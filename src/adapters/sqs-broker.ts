import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  ReceiveMessageCommandOutput,
  SendMessageCommand,
  SendMessageCommandOutput
} from '@aws-sdk/client-sqs'
import { AppComponents } from '../types'
import { DeploymentJob, parseDeploymentMessage } from '../logic/deployment-message'
import { BrokerJob, IJobBroker } from './job-broker'
import { ITaskProtection } from './task-protection'

// IJobBroker over Amazon SQS.
//
// - claim: long-polls the queues in the order given (the last one for the full
//   wait, the ones before it briefly), one message at a time. A message that
//   does not parse or validate is deleted and counted as `invalid`.
// - while a job runs its visibility is extended every half-period (heartbeat),
//   within SQS's 12 h limit.
// - ECS scale-in protection is turned on with every claim and stays on between
//   back-to-back jobs; it is turned off only when a full polling round finds
//   every queue empty (or on stop), so a pending scale-in never lands between
//   two jobs and bounces the second one.
// - complete: DeleteMessage (success, or a permanent content failure).
// - fail: ChangeMessageVisibility to a backoff (5 min, 30 min, then 2 h); SQS
//   redelivers it and, after the queue's maxReceiveCount, its redrive policy
//   dead-letters it. Every receive counts, including deliveries handed back on
//   shutdown, so maxReceiveCount must leave room for those.
// - release / stop: ChangeMessageVisibility 0, so another task picks it up now.

/** The subset of SQSClient the broker uses (tests pass a fake). */
export interface SqsSender {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>
}

export type SqsJobBrokerOptions = {
  // Logical queue name -> SQS queue URL
  queueUrls: Record<string, string>
  // Visibility set on receive and on every heartbeat (JOB_VISIBILITY_TIMEOUT_SECONDS)
  visibilityTimeoutSeconds: number
  // Long-poll wait on the last queue polled (default 20, SQS's maximum)
  waitTimeSeconds?: number
  // Wait on the queues polled before the last one (default 1)
  leadingWaitTimeSeconds?: number
  taskProtection?: ITaskProtection
}

export type ISqsJobBroker = IJobBroker<DeploymentJob> & {
  // Jobs claimed and not yet completed, failed or released (by message id)
  inFlight(): string[]
}

// SQS never keeps a received message hidden for more than 12 h in total
export const MAX_VISIBILITY_SECONDS = 43_200
export const DEFAULT_JOB_VISIBILITY_TIMEOUT_SECONDS = 900
const MIN_VISIBILITY_SECONDS = 30
const DEFAULT_WAIT_TIME_SECONDS = 20
const DEFAULT_LEADING_WAIT_TIME_SECONDS = 1
/**
 * Visibility after a transient failure, by delivery: long enough that an
 * outage of the catalyst, S3 or the network (or a fix to a misconfigured
 * bucket) is over before the job runs out of deliveries and is dead-lettered.
 */
export const BACKOFF_SCHEDULE_SECONDS: readonly number[] = [300, 1_800, 7_200]

/** Visibility for a transient failure on the given delivery: 5 min, 30 min, then 2 h. */
export function backoffSecondsFor(receiveCount: number | undefined): number {
  const attempt = Math.max(1, Math.floor(receiveCount ?? 1))
  return BACKOFF_SCHEDULE_SECONDS[Math.min(attempt, BACKOFF_SCHEDULE_SECONDS.length) - 1]
}

/** JOB_VISIBILITY_TIMEOUT_SECONDS, defaulted and clamped to what SQS accepts. */
export function parseVisibilityTimeout(value: string | undefined): number {
  const parsed = parseInt(value || '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_JOB_VISIBILITY_TIMEOUT_SECONDS
  return Math.min(Math.max(parsed, MIN_VISIBILITY_SECONDS), MAX_VISIBILITY_SECONDS)
}

type InFlightJob = {
  queueUrl: string
  receiptHandle: string
  receivedAt: number
  heartbeat: NodeJS.Timeout
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createSqsJobBroker(
  components: Pick<AppComponents, 'logs' | 'metrics'>,
  sqs: SqsSender,
  options: SqsJobBrokerOptions
): ISqsJobBroker {
  const logger = components.logs.getLogger('sqs-broker')
  const visibility = options.visibilityTimeoutSeconds
  const waitTimeSeconds = options.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS
  const leadingWaitTimeSeconds = options.leadingWaitTimeSeconds ?? DEFAULT_LEADING_WAIT_TIME_SECONDS
  const taskProtection = options.taskProtection

  const inFlight = new Map<string, InFlightJob>()
  let stopping = false
  // Whether this broker last asked ECS to protect the task
  let protectedTask = false
  let poll: AbortController | undefined

  function queueUrlOf(queue: string): string {
    const url = options.queueUrls[queue]
    if (!url) throw new Error(`Unknown queue ${queue}`)
    return url
  }

  async function changeVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void> {
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds
      })
    )
  }

  async function deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }))
  }

  // Seconds left before the delivery hits SQS's 12 h visibility limit
  function remainingSeconds(job: InFlightJob): number {
    return Math.floor(MAX_VISIBILITY_SECONDS - (Date.now() - job.receivedAt) / 1000)
  }

  function startHeartbeat(messageId: string, queueUrl: string, receiptHandle: string, receivedAt: number) {
    const heartbeat = setInterval(
      () => {
        const job = inFlight.get(messageId)
        if (!job) return clearInterval(heartbeat)
        const seconds = Math.min(visibility, remainingSeconds(job))
        if (seconds <= 0) {
          clearInterval(heartbeat)
          logger.warn('Job reached the 12 h visibility limit; it will be redelivered', { messageId })
          return
        }
        changeVisibility(queueUrl, receiptHandle, seconds).then(
          () => logger.debug('Extended job visibility', { messageId, seconds }),
          (err) => logger.warn(`Could not extend job visibility: ${errorMessage(err)}`, { messageId })
        )
      },
      (visibility * 1000) / 2
    )
    heartbeat.unref()
    inFlight.set(messageId, { queueUrl, receiptHandle, receivedAt, heartbeat })
  }

  async function protect(): Promise<void> {
    protectedTask = true
    await taskProtection?.enable()
  }

  async function unprotect(): Promise<void> {
    if (!protectedTask) return
    protectedTask = false
    await taskProtection?.disable()
  }

  // Ends the claim on a job (no more heartbeats) and runs its final SQS call.
  // Scale-in protection stays on: the next claim either takes another job
  // (still protected) or finds the queues empty and drops it. A job already
  // settled (released on shutdown) is left alone: its message may be on
  // another task by now.
  async function settle(job: BrokerJob<DeploymentJob>, finish: (entry: InFlightJob) => Promise<void>): Promise<void> {
    const entry = inFlight.get(job.id)
    if (!entry) {
      logger.debug('Job already settled', { messageId: job.id })
      return
    }
    clearInterval(entry.heartbeat)
    inFlight.delete(job.id)
    await finish(entry)
  }

  async function drop(queueUrl: string, message: Message, reason: string): Promise<void> {
    components.metrics.increment('job_queue_outcome_total', { outcome: 'invalid' })
    logger.error(`Dropping invalid message: ${reason}`, {
      messageId: message.MessageId ?? '',
      body: (message.Body ?? '').slice(0, 1000)
    })
    try {
      await deleteMessage(queueUrl, message.ReceiptHandle!)
    } catch (err) {
      logger.warn(`Could not delete invalid message: ${errorMessage(err)}`, { messageId: message.MessageId ?? '' })
    }
  }

  async function receive(queueUrl: string, wait: number): Promise<Message | undefined> {
    const controller = new AbortController()
    poll = controller
    try {
      const response = (await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: wait,
          VisibilityTimeout: visibility,
          MessageSystemAttributeNames: ['ApproximateReceiveCount']
        }),
        { abortSignal: controller.signal }
      )) as ReceiveMessageCommandOutput
      return response.Messages?.find((message) => !!message.ReceiptHandle)
    } catch (err) {
      // The long poll is aborted on stop
      if (stopping) return undefined
      throw err
    } finally {
      if (poll === controller) poll = undefined
    }
  }

  return {
    async claim(queues) {
      for (let i = 0; i < queues.length; i++) {
        if (stopping) return null
        const queue = queues[i]
        const queueUrl = queueUrlOf(queue)
        const message = await receive(queueUrl, i === queues.length - 1 ? waitTimeSeconds : leadingWaitTimeSeconds)
        if (!message) continue

        if (stopping) {
          await changeVisibility(queueUrl, message.ReceiptHandle!, 0).catch(() => undefined)
          return null
        }

        const parsed = parseDeploymentMessage(message.Body)
        if (!parsed.ok) {
          await drop(queueUrl, message, parsed.reason)
          continue
        }

        const messageId = message.MessageId || message.ReceiptHandle!
        const receiveCount = parseInt(message.Attributes?.ApproximateReceiveCount || '1', 10) || 1
        startHeartbeat(messageId, queueUrl, message.ReceiptHandle!, Date.now())
        // Renewed on every claim, so its expiry always covers this job's budget
        await protect()
        logger.info('Claimed job', {
          messageId,
          queue,
          receiveCount,
          entityId: parsed.job.entity.entityId,
          entityType: parsed.job.entity.entityType
        })
        return { queue, id: messageId, data: parsed.job, receiveCount }
      }
      // A full round found nothing: the task is idle and may be scaled in
      if (inFlight.size === 0 && !stopping) await unprotect()
      return null
    },

    async complete(job) {
      await settle(job, (entry) => deleteMessage(entry.queueUrl, entry.receiptHandle))
    },

    async fail(job, error) {
      await settle(job, async (entry) => {
        const seconds = Math.max(0, Math.min(backoffSecondsFor(job.receiveCount), remainingSeconds(entry)))
        logger.info(`Job will be retried in ${seconds} s`, {
          messageId: job.id,
          receiveCount: job.receiveCount ?? 1,
          error: error ?? ''
        })
        await changeVisibility(entry.queueUrl, entry.receiptHandle, seconds)
      })
    },

    async release(job) {
      await settle(job, (entry) => changeVisibility(entry.queueUrl, entry.receiptHandle, 0))
    },

    async send(queue, data) {
      const response = (await sqs.send(
        new SendMessageCommand({ QueueUrl: queueUrlOf(queue), MessageBody: JSON.stringify(data) })
      )) as SendMessageCommandOutput
      return response.MessageId ?? ''
    },

    // Stops polling and hands every in-flight job back right away: a bake
    // cannot finish within ECS's stop timeout, so another task should take it.
    async stop() {
      stopping = true
      poll?.abort()
      const pending = [...inFlight.entries()]
      inFlight.clear()
      for (const [, entry] of pending) clearInterval(entry.heartbeat)
      await Promise.all(
        pending.map(async ([messageId, entry]) => {
          try {
            await changeVisibility(entry.queueUrl, entry.receiptHandle, 0)
            logger.info('Released in-flight job on shutdown', { messageId })
          } catch (err) {
            logger.warn(`Could not release in-flight job: ${errorMessage(err)}`, { messageId })
          }
        })
      )
      await unprotect()
    },

    inFlight() {
      return [...inFlight.keys()]
    }
  }
}
