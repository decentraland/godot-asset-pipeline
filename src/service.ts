import { Lifecycle } from '@well-known-components/interfaces'
import { setupRouter } from './controllers/routes'
import { godotOptimizer } from './runners/godot-optimizer'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { TaskQueueMessage } from './adapters/task-queue'
import { AppComponents, BaseComponents, GlobalContext, TestComponents } from './types'
import { ContentError, isContentError, isTransientError } from './logic/transient-error'
import { isContentServerAllowed, jobContentServerUrl, parseAllowedHosts } from './logic/content-server'
import { isValidEntityId } from './logic/deployment-message'

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  const globalContext: GlobalContext = {
    components
  }

  // wire the HTTP router (make it automatic? TBD)
  const router = await setupRouter(globalContext)
  // register routes middleware
  components.server.use(router.middleware())
  // register not implemented/method not allowed/cors responses middleware
  components.server.use(router.allowedMethods())
  // set the context to be passed to the handlers
  components.server.setContext(globalContext)

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const godot = createGodotGate(globalContext.components)
  const processJob = await createJobProcessor(globalContext.components, godotOptimizer, godot)

  components.runner.runTask(async (opt) => {
    while (opt.isRunning) {
      // Never claim a job while Godot is down: it would only be failed (and
      // pushed towards the DLQ) without being baked.
      if (!(await godot.ensureReady())) continue
      await components.taskQueue.consumeAndProcessJob(processJob)
    }
  })
}

/** How many Godot start attempts in a row may fail before the process exits (ECS replaces the task). */
export const MAX_GODOT_START_FAILURES = 3
export const GODOT_START_RETRY_DELAY_MS = 30_000

export type GodotGate = {
  /**
   * Called before every claim: restarts Godot when the last job used it (to
   * free its memory) or when it is not answering. False when it could not be
   * started (after a pause); after MAX_GODOT_START_FAILURES in a row the
   * process gives up (`onGiveUp`, by default exit 1) so ECS replaces the task.
   */
  ensureReady(): Promise<boolean>
  /** The job just processed used Godot: restart it before the next claim. */
  markUsed(): void
}

export function createGodotGate(
  components: Pick<BaseComponents, 'assetServer' | 'logs'>,
  options: { maxFailures?: number; retryDelayMs?: number; onGiveUp?: () => void } = {}
): GodotGate {
  const logger = components.logs.getLogger('godot-gate')
  const maxFailures = options.maxFailures ?? MAX_GODOT_START_FAILURES
  const retryDelayMs = options.retryDelayMs ?? GODOT_START_RETRY_DELAY_MS
  const onGiveUp = options.onGiveUp ?? (() => process.exit(1))
  let used = false
  let failures = 0

  return {
    async ensureReady() {
      if (!used && (await components.assetServer.isReady())) {
        failures = 0
        return true
      }
      if (used) logger.info('Restarting Godot to free memory before the next job')
      if (await components.assetServer.restartGodot()) {
        used = false
        failures = 0
        return true
      }
      failures++
      logger.error(`Godot asset-server could not be started (${failures}/${maxFailures} in a row)`)
      if (failures >= maxFailures) {
        logger.error('Giving up: exiting so the task is replaced')
        onGiveUp()
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      return false
    },
    markUsed() {
      used = true
    }
  }
}

type Optimizer = (job: DeploymentToSqs, message: TaskQueueMessage, components: BaseComponents) => Promise<unknown>

/**
 * The task runner for one job. Resolving acknowledges the job (the broker
 * deletes it); throwing hands it back for a retry. So:
 * - success, an already published scene (the optimizer resolves `null`), and
 *   content failures (a `ContentError`, including a content server outside
 *   ALLOWED_CONTENT_SERVER_HOSTS, rejected before anything is fetched) resolve
 * - every other failure throws: transient (network/infra) and unclassified
 *   errors alike. The queue redelivers the job later and dead-letters it
 *   after too many attempts, where it can be inspected and redriven.
 */
export async function createJobProcessor(
  components: BaseComponents,
  optimizer: Optimizer = godotOptimizer,
  godot?: Pick<GodotGate, 'markUsed'>
): Promise<(job: DeploymentToSqs, message: TaskQueueMessage) => Promise<void>> {
  const logger = components.logs.getLogger('main-loop')
  const allowedHosts = parseAllowedHosts(await components.config.getString('ALLOWED_CONTENT_SERVER_HOSTS'))

  // Godot needs a restart before the next claim unless the optimizer skipped
  // the job without touching it (it resolves `null`: already published).
  async function runOptimizer(job: DeploymentToSqs, message: TaskQueueMessage): Promise<unknown> {
    let result: unknown
    try {
      result = await optimizer(job, message, components)
      return result
    } finally {
      if (result !== null) godot?.markUsed()
    }
  }

  return async (job, message) => {
    const entityId = job.entity.entityId
    const entityType = (job.entity as { entityType?: string }).entityType || 'scene'

    if (message.isPriority) {
      logger.info('Processing PRIORITY job', { entityId })
    }

    try {
      // SQS messages are checked when parsed; this also covers in-memory one-offs
      if (!isValidEntityId(entityId)) throw new ContentError(`Not an entity id (content hash): ${entityId}`)

      // The content server URL comes from the message: never fetch from a host outside the allowlist.
      const contentServerUrl = jobContentServerUrl(job)
      if (contentServerUrl && !isContentServerAllowed(contentServerUrl, allowedHosts)) {
        throw new ContentError(`Content server ${contentServerUrl} is not in ALLOWED_CONTENT_SERVER_HOSTS`)
      }

      await runOptimizer(job, message)
      components.metrics.increment('job_queue_outcome_total', { outcome: 'success' })
    } catch (error) {
      logger.error(`Error processing job ${entityId}`, { entityType })
      logger.error(error as any)

      if (isContentError(error)) {
        components.metrics.increment('job_queue_outcome_total', { outcome: 'content_failure' })
        return
      }
      components.metrics.increment('job_queue_outcome_total', { outcome: 'transient' })
      logger.warn(
        isTransientError(error)
          ? 'Transient failure, releasing the job for retry'
          : 'Unclassified failure, releasing the job for retry (it is dead-lettered if it keeps failing)',
        { entityId, entityType }
      )
      throw error
    }
  }
}
