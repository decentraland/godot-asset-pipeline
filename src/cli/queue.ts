// Manual (re)queue and backfill: sends optimizer jobs straight to the SQS
// queues the worker polls.
//
//   yarn queue [options] <entityId> [<entityId> ...]
//   yarn queue [options] --file ids.txt
//
// Options:
//   --priority                 send to PRIORITY_TASK_QUEUE (polled first) instead of TASK_QUEUE
//   --file <path>              read entity ids from a file, one per line ('#' starts a comment)
//   --content-server-url <url> content server of the entities (default: the worker's <CATALYST_URL>/content)
//   --entity-type <type>       scene (default), wearable or emote
//   --force                    re-bake scenes that are already published (otherwise the worker skips them)
//   --dry-run                  print the messages without sending them
//
// Uses the default AWS credential chain, AWS_REGION and, for LocalStack, SQS_ENDPOINT.
import { readFile } from 'fs/promises'
import { parseArgs } from 'util'
import { SendMessageCommand, SendMessageCommandOutput, SQSClient } from '@aws-sdk/client-sqs'
import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import {
  SUPPORTED_ENTITY_TYPES,
  EntityType,
  buildDeploymentMessage,
  isValidEntityId
} from '../logic/deployment-message'
import { SqsSender } from '../adapters/sqs-broker'

export type QueueCliOptions = {
  priority: boolean
  files: string[]
  contentServerUrl?: string
  entityType: EntityType
  force: boolean
  dryRun: boolean
  entityIds: string[]
  help: boolean
}

export const USAGE = `Usage: yarn queue [--priority] [--file <ids.txt>] [--content-server-url <url>]
                  [--entity-type scene|wearable|emote] [--force] [--dry-run] [<entityId> ...]`

// Parallel SendMessage calls
const SEND_CONCURRENCY = 10

export function parseQueueArgs(argv: string[]): QueueCliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      priority: { type: 'boolean', default: false },
      file: { type: 'string', multiple: true, short: 'f' },
      'content-server-url': { type: 'string' },
      'entity-type': { type: 'string', default: 'scene' },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  })

  const entityType = String(values['entity-type']).toLowerCase()
  if (!SUPPORTED_ENTITY_TYPES.has(entityType)) {
    throw new Error(`--entity-type must be one of ${[...SUPPORTED_ENTITY_TYPES].join(', ')}`)
  }

  const contentServerUrl = values['content-server-url']?.replace(/\/+$/, '')
  if (contentServerUrl !== undefined) {
    let protocol: string
    try {
      protocol = new URL(contentServerUrl).protocol
    } catch {
      throw new Error(`--content-server-url is not a URL: ${contentServerUrl}`)
    }
    if (protocol !== 'https:' && protocol !== 'http:') {
      throw new Error(`--content-server-url must be http(s): ${contentServerUrl}`)
    }
  }

  return {
    priority: !!values.priority,
    files: values.file ?? [],
    contentServerUrl,
    entityType: entityType as EntityType,
    force: !!values.force,
    dryRun: !!values['dry-run'],
    help: !!values.help,
    entityIds: positionals
  }
}

/** Entity ids from a file: one per line, blank lines and '#' comments skipped. */
export function parseEntityIdList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
}

/** The ids in order, without duplicates. */
export function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))]
}

/** The SendMessage input for one entity: a raw DeploymentToSqs (the queues use raw delivery). */
export function buildSendMessageInput(
  queueUrl: string,
  entityId: string,
  options: Pick<QueueCliOptions, 'entityType' | 'contentServerUrl'> & { force?: boolean }
): { QueueUrl: string; MessageBody: string } {
  if (!isValidEntityId(entityId)) throw new Error(`Not an entity id (content hash): ${entityId}`)
  const message = buildDeploymentMessage(entityId, options)
  if (!DeploymentToSqs.validate(message)) {
    throw new Error(`Invalid job for ${entityId}: ${JSON.stringify(DeploymentToSqs.validate.errors)}`)
  }
  return { QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }
}

export type QueueResult = { entityId: string; messageId?: string; error?: string }

/** Sends one message per entity id, a few in parallel; failures are reported, not thrown. */
export async function queueEntities(
  sqs: SqsSender,
  queueUrl: string,
  entityIds: string[],
  options: Pick<QueueCliOptions, 'entityType' | 'contentServerUrl'> & { force?: boolean },
  onResult: (result: QueueResult) => void = () => undefined
): Promise<QueueResult[]> {
  const results: QueueResult[] = new Array(entityIds.length)
  let next = 0

  async function worker() {
    while (next < entityIds.length) {
      const index = next++
      const entityId = entityIds[index]
      let result: QueueResult
      try {
        const response = (await sqs.send(
          new SendMessageCommand(buildSendMessageInput(queueUrl, entityId, options))
        )) as SendMessageCommandOutput
        result = { entityId, messageId: response.MessageId }
      } catch (err) {
        result = { entityId, error: err instanceof Error ? err.message : String(err) }
      }
      results[index] = result
      onResult(result)
    }
  }

  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, entityIds.length) }, worker))
  return results
}

export async function runQueueCli(argv: string[]): Promise<number> {
  let options: QueueCliOptions
  try {
    options = parseQueueArgs(argv)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    console.error(USAGE)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  const fromFiles = await Promise.all(
    options.files.map(async (file) => parseEntityIdList(await readFile(file, 'utf8')))
  )
  const entityIds = uniqueIds([...options.entityIds, ...fromFiles.flat()])
  if (entityIds.length === 0) {
    console.error('No entity ids given')
    console.error(USAGE)
    return 2
  }
  const invalidIds = entityIds.filter((id) => !isValidEntityId(id))
  if (invalidIds.length > 0) {
    console.error(`Not entity ids (content hashes): ${invalidIds.slice(0, 10).join(', ')}`)
    return 2
  }

  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })
  const queueVariable = options.priority ? 'PRIORITY_TASK_QUEUE' : 'TASK_QUEUE'
  const queueUrl = await config.getString(queueVariable)
  if (!queueUrl && !options.dryRun) {
    console.error(`${queueVariable} is not set`)
    return 2
  }

  if (options.dryRun) {
    for (const entityId of entityIds) {
      console.log(buildSendMessageInput(queueUrl || `<${queueVariable}>`, entityId, options).MessageBody)
    }
    return 0
  }

  const sqsEndpoint = (await config.getString('SQS_ENDPOINT')) || undefined
  const sqs = new SQSClient({
    region: (await config.getString('AWS_REGION')) || 'us-east-1',
    ...(sqsEndpoint && { endpoint: sqsEndpoint })
  })

  const results = await queueEntities(sqs, queueUrl!, entityIds, options, (result) => {
    if (result.error) console.error(`${result.entityId}\tFAILED\t${result.error}`)
    else console.log(`${result.entityId}\t${result.messageId}`)
  })
  sqs.destroy()

  const failed = results.filter((result) => result.error).length
  console.log(`Queued ${results.length - failed}/${results.length} entities to ${queueVariable}`)
  return failed > 0 ? 1 : 0
}

if (require.main === module) {
  runQueueCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err)
      process.exit(1)
    }
  )
}
