import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createServerComponent, createStatusCheckComponent } from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent, instrumentHttpServerWithMetrics } from '@well-known-components/metrics'
import { AwsCredentialIdentity } from '@smithy/types'
import { SQSClient } from '@aws-sdk/client-sqs'
import { IBaseComponent } from '@well-known-components/interfaces'
import path from 'path'
import { createFetchComponent } from './adapters/fetch'
import { createRunnerComponent } from './adapters/runner'
import { ITaskQueue, createBrokerQueueAdapter, createMemoryQueueAdapter } from './adapters/task-queue'
import { createSqsJobBroker, parseVisibilityTimeout } from './adapters/sqs-broker'
import { createTaskProtection, protectionMinutesFor } from './adapters/task-protection'
import { createLocalStorageComponent, createS3StorageComponent } from './adapters/storage'
import { DEFAULT_ASSET_SERVER_TIMEOUT_MS, createAssetServerComponent } from './adapters/asset-server'
import { createContentProxyComponent } from './adapters/content-proxy'
import { metricDeclarations } from './metrics'
import { handleEntityId, handleProfile } from './one-off'
import { AppComponents, GlobalContext } from './types'

export const DEFAULT_HTTP_SERVER_PORT = 5000
export const DEFAULT_AWS_REGION = 'us-east-1'

// Logical names of the two SQS lanes (metric labels and logs)
export const TASK_QUEUE_NAME = 'task'
export const PRIORITY_QUEUE_NAME = 'priority'

/**
 * The job source: SQS when TASK_QUEUE and/or PRIORITY_TASK_QUEUE is set (the
 * priority queue is polled first), otherwise an in-memory queue for tests and
 * `--entityId` one-offs.
 */
async function createTaskQueue(
  components: Pick<AppComponents, 'config' | 'logs' | 'metrics'>
): Promise<ITaskQueue<DeploymentToSqs> & IBaseComponent> {
  const { config, logs, metrics } = components
  const taskQueueUrl = (await config.getString('TASK_QUEUE')) || undefined
  const priorityQueueUrl = (await config.getString('PRIORITY_TASK_QUEUE')) || undefined

  if (!taskQueueUrl && !priorityQueueUrl) {
    logs.getLogger('components').info('TASK_QUEUE is not set: using an in-memory queue')
    return createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'memory' })
  }

  // Default credential chain (the ECS task role); SQS_ENDPOINT is for LocalStack only
  const sqsEndpoint = (await config.getString('SQS_ENDPOINT')) || undefined
  const sqs = new SQSClient({
    region: (await config.getString('AWS_REGION')) || DEFAULT_AWS_REGION,
    ...(sqsEndpoint && { endpoint: sqsEndpoint })
  })

  const bakeBudgetMs =
    parseInt((await config.getString('ASSET_SERVER_TIMEOUT_MS')) || '', 10) || DEFAULT_ASSET_SERVER_TIMEOUT_MS
  const taskProtection = createTaskProtection(
    { logs },
    { agentUri: await config.getString('ECS_AGENT_URI'), expiresInMinutes: protectionMinutesFor(bakeBudgetMs) }
  )

  const queueUrls: Record<string, string> = {}
  if (taskQueueUrl) queueUrls[TASK_QUEUE_NAME] = taskQueueUrl
  if (priorityQueueUrl) queueUrls[PRIORITY_QUEUE_NAME] = priorityQueueUrl

  const broker = createSqsJobBroker({ logs, metrics }, sqs, {
    queueUrls,
    visibilityTimeoutSeconds: parseVisibilityTimeout(await config.getString('JOB_VISIBILITY_TIMEOUT_SECONDS')),
    taskProtection
  })

  return createBrokerQueueAdapter<DeploymentToSqs>({ logs, metrics }, broker, {
    queue: taskQueueUrl ? TASK_QUEUE_NAME : PRIORITY_QUEUE_NAME,
    priorityQueue: taskQueueUrl && priorityQueueUrl ? PRIORITY_QUEUE_NAME : undefined
  })
}

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const server = await createServerComponent<GlobalContext>(
    { config, logs },
    {
      cors: {}
    }
  )
  // Serves /health/live, /health/ready and /health/startup
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent({ config, logs })

  // Serves /metrics
  await instrumentHttpServerWithMetrics({ metrics, server, config })

  const taskQueue = await createTaskQueue({ config, logs, metrics })

  const bucket = await config.getString('BUCKET')
  const s3Endpoint = (await config.getString('S3_ENDPOINT')) || undefined
  const s3Region = (await config.getString('AWS_REGION')) || DEFAULT_AWS_REGION
  const prefixVersion = (await config.getString('S3_PREFIX')) || undefined

  // Static keys are for local S3-compatible storage only; on AWS the default
  // credential chain (the ECS task role) is used.
  const s3AccessKeyId = await config.getString('S3_ACCESS_KEY_ID')
  const s3SecretAccessKey = await config.getString('S3_SECRET_ACCESS_KEY')
  const s3Credentials: AwsCredentialIdentity | undefined =
    s3AccessKeyId && s3SecretAccessKey
      ? {
          accessKeyId: s3AccessKeyId,
          secretAccessKey: s3SecretAccessKey
        }
      : undefined

  // Jobs from SQS are deleted once baked: their output must land in the
  // bucket, under the version prefix, never on the task's ephemeral disk.
  const consumesSqs = !!(await config.getString('TASK_QUEUE')) || !!(await config.getString('PRIORITY_TASK_QUEUE'))
  if (consumesSqs && (!bucket || !prefixVersion)) {
    throw new Error(
      'BUCKET and S3_PREFIX must be set when TASK_QUEUE or PRIORITY_TASK_QUEUE is set (local storage is for one-offs only)'
    )
  }

  const storage =
    bucket !== undefined && bucket !== ''
      ? await createS3StorageComponent(bucket, prefixVersion, s3Endpoint, s3Credentials, s3Region, { logs })
      : createLocalStorageComponent(path.resolve(process.cwd(), 'storage'), { logs })

  const runner = createRunnerComponent()

  const assetServerUrl = (await config.getString('ASSET_SERVER_URL')) || 'http://localhost:8080'
  const assetServer = createAssetServerComponent({ logs, fetch }, { baseUrl: assetServerUrl })
  // Served by this process's own HTTP server; the asset server runs in the same container.
  const contentProxy = createContentProxyComponent({
    port: parseInt((await config.getString('HTTP_SERVER_PORT')) || String(DEFAULT_HTTP_SERVER_PORT), 10)
  })

  const entityIdIndex = process.argv.findIndex((p) => p === '--entityId')
  if (entityIdIndex !== -1) {
    const entityId = process.argv[entityIdIndex + 1]
    if (entityId) {
      await handleEntityId(entityId, { fetch, logs, taskQueue, config })
    } else {
      logs.getLogger('main').error('Error: Please provide a value for --entityId')
    }
  }

  const profileIndex = process.argv.findIndex((p) => p === '--profile')
  if (profileIndex !== -1) {
    const profileAddress = process.argv[profileIndex + 1]
    if (profileAddress) {
      await handleProfile(profileAddress, { fetch, logs, storage, assetServer, config })
      // Exit after profile processing is complete
      process.exit(0)
    } else {
      logs.getLogger('main').error('Error: Please provide an address for --profile')
    }
  }

  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    metrics,
    taskQueue,
    runner,
    storage,
    assetServer,
    contentProxy
  }
}
