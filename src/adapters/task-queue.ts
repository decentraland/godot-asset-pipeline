import { IBaseComponent, IMetricsComponent } from '@well-known-components/interfaces'
import { validateMetricsDeclaration } from '@well-known-components/metrics'
import { AsyncQueue } from '@well-known-components/pushable-channel'
import { AppComponents } from '../types'
import { BrokerJob, IJobBroker } from './job-broker'

export interface TaskQueueMessage {
  id: string
  isPriority: boolean
}

export interface ITaskQueue<T> {
  publish(job: T, prioritize?: boolean): Promise<TaskQueueMessage>
  consumeAndProcessJob<R>(
    taskRunner: (job: T, message: TaskQueueMessage) => Promise<R>
  ): Promise<{ result: R | undefined }>
}

// How a job ended, as counted by `job_queue_outcome_total`:
// - success: baked and published (or nothing to bake)
// - content_failure: the entity itself cannot be baked; acknowledged, not retried
// - transient: network/infra failure; handed back to the queue for a retry
// - invalid: the message could not be parsed or validated; dropped
export type JobOutcome = 'success' | 'content_failure' | 'transient' | 'invalid'

export const queueMetrics = validateMetricsDeclaration({
  job_queue_duration_seconds: {
    type: IMetricsComponent.HistogramType,
    help: 'Duration of each job in seconds',
    labelNames: ['queue_name'],
    buckets: [1, 10, 100, 200, 300, 400, 500, 600, 700, 1000, 1200, 1600, 1800, 3600]
  },
  job_queue_enqueue_total: {
    type: IMetricsComponent.CounterType,
    help: 'Total amount of enqueued jobs',
    labelNames: ['queue_name']
  },
  job_queue_failures_total: {
    type: IMetricsComponent.CounterType,
    help: 'Total amount of failed tasks',
    labelNames: ['queue_name']
  },
  job_queue_outcome_total: {
    type: IMetricsComponent.CounterType,
    help: 'Jobs by outcome (success, content_failure, transient, invalid)',
    labelNames: ['outcome']
  }
})

export async function sleep(ms: number) {
  return new Promise<void>((ok) => setTimeout(ok, ms))
}

// In-process queue for tests and local one-offs (`--entityId`): no
// persistence, no retries.
export function createMemoryQueueAdapter<T>(
  components: Pick<AppComponents, 'logs' | 'metrics'>,
  options: { queueName: string }
): ITaskQueue<T> & IBaseComponent {
  type InternalElement = { message: TaskQueueMessage; job: T }
  const q = new AsyncQueue<InternalElement>((_action) => void 0)
  let lastJobId = 0

  const logger = components.logs.getLogger(options.queueName)

  return {
    async stop() {
      q.close()
    },
    async publish(job, prioritize?: boolean) {
      const id = 'job-' + (++lastJobId).toString()
      const message: TaskQueueMessage = { id, isPriority: !!prioritize }
      q.enqueue({ job, message })
      logger.info(`Publishing job`, { id })
      components.metrics.increment('job_queue_enqueue_total', { queue_name: options.queueName })
      return message
    },
    async consumeAndProcessJob(taskRunner) {
      const it: InternalElement = (await q.next()).value
      if (it) {
        const { end } = components.metrics.startTimer('job_queue_duration_seconds', { queue_name: options.queueName })
        try {
          logger.info(`Processing job`, { id: it.message.id })
          const result = await taskRunner(it.job, it.message)
          logger.info(`Processed job`, { id: it.message.id })
          return { result, message: it.message }
        } catch (err: any) {
          components.metrics.increment('job_queue_failures_total', { queue_name: options.queueName })
          logger.error(err, { id: it.message.id })
        } finally {
          end()
        }
      }
      return { result: undefined }
    }
  }
}

export type BrokerQueueAdapterOptions = {
  // Logical name of the main queue
  queue: string
  // Logical name of the priority queue, polled before `queue` on every iteration
  priorityQueue?: string
  // Pause after a poll that found nothing on any queue
  idleSleepMs?: number
  // Pause after a claim that failed (broker unreachable, access denied, ...)
  errorSleepMs?: number
}

const DEFAULT_IDLE_SLEEP_MS = 1_000
const DEFAULT_ERROR_SLEEP_MS = 5_000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * ITaskQueue over an IJobBroker. Every iteration asks the broker for the
 * priority queue first, then the main queue. A job the runner finishes is
 * completed; a job the runner throws on is failed (handed back for a retry).
 */
export function createBrokerQueueAdapter<T>(
  components: Pick<AppComponents, 'logs' | 'metrics'>,
  broker: IJobBroker<T>,
  options: BrokerQueueAdapterOptions
): ITaskQueue<T> & IBaseComponent {
  const { queue: mainQueue, priorityQueue } = options
  const idleSleepMs = options.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS
  const errorSleepMs = options.errorSleepMs ?? DEFAULT_ERROR_SLEEP_MS
  const logger = components.logs.getLogger('task-queue')

  const pollingOrder = priorityQueue ? [priorityQueue, mainQueue] : [mainQueue]
  let closed = false
  // Wakes an in-progress pause so stop() returns promptly
  let wake: (() => void) | undefined

  function pause(ms: number): Promise<void> {
    if (closed) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      wake = done
      function done() {
        clearTimeout(timer)
        wake = undefined
        resolve()
      }
    })
  }

  async function fail(job: BrokerJob<T>, reason: string): Promise<void> {
    try {
      await broker.fail(job, reason)
    } catch (err) {
      logger.warn(`Could not fail job: ${errorMessage(err)}`, { queue: job.queue, id: job.id })
    }
  }

  async function release(job: BrokerJob<T>): Promise<void> {
    if (!broker.release) return fail(job, 'consumer stopping')
    try {
      await broker.release(job)
    } catch (err) {
      logger.warn(`Could not release job: ${errorMessage(err)}`, { queue: job.queue, id: job.id })
    }
  }

  async function run<R>(
    job: BrokerJob<T>,
    taskRunner: (job: T, message: TaskQueueMessage) => Promise<R>
  ): Promise<{ result: R | undefined; message: TaskQueueMessage }> {
    const { queue, id } = job
    const message: TaskQueueMessage = { id, isPriority: queue === priorityQueue }
    const { end } = components.metrics.startTimer('job_queue_duration_seconds', { queue_name: queue })
    try {
      logger.info(`Processing job`, { id, queue })
      const result = await taskRunner(job.data, message)
      logger.info(`Processed job`, { id, queue })
      try {
        await broker.complete(job)
      } catch (err) {
        // The work is done; the claim most likely expired and the job was redelivered meanwhile.
        logger.warn(`Could not complete job: ${errorMessage(err)}`, { id, queue })
      }
      return { result, message }
    } catch (err: any) {
      logger.error(err, { id, queue })
      components.metrics.increment('job_queue_failures_total', { queue_name: queue })
      await fail(job, errorMessage(err))
      return { result: undefined, message }
    } finally {
      end()
    }
  }

  return {
    async stop() {
      closed = true
      wake?.()
      await broker.stop?.()
    },

    async publish(job, prioritize?: boolean) {
      if (!broker.send) throw new Error('Publishing is not supported by this queue backend')
      const queue = prioritize && priorityQueue ? priorityQueue : mainQueue
      const id = await broker.send(queue, job)
      const message: TaskQueueMessage = { id, isPriority: queue === priorityQueue }
      logger.info(`Publishing job`, { id, queue })
      components.metrics.increment('job_queue_enqueue_total', { queue_name: queue })
      return message
    },

    async consumeAndProcessJob(taskRunner) {
      while (!closed) {
        let claimed
        try {
          claimed = await broker.claim(pollingOrder)
        } catch (err) {
          if (closed) break
          logger.error(`Claim failed: ${errorMessage(err)}; retrying in ${errorSleepMs} ms`)
          await pause(errorSleepMs)
          continue
        }

        if (closed) {
          if (claimed) await release(claimed)
          break
        }

        if (!claimed) {
          await pause(idleSleepMs)
          continue
        }

        return run(claimed, taskRunner)
      }
      return { result: undefined }
    }
  }
}
