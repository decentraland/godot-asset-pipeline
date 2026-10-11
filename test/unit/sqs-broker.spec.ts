import type { Message } from '@aws-sdk/client-sqs'
import type { IConfigComponent, ILoggerComponent, IMetricsComponent } from '@well-known-components/interfaces'
import {
  MAX_VISIBILITY_SECONDS,
  SqsJobBrokerOptions,
  backoffSecondsFor,
  createSqsJobBroker,
  parseVisibilityTimeout
} from '../../src/adapters/sqs-broker'
import { createTaskProtection, protectionMinutesFor } from '../../src/adapters/task-protection'
import { createBrokerQueueAdapter } from '../../src/adapters/task-queue'
import { createRunnerComponent } from '../../src/adapters/runner'
import { ContentError, TransientError } from '../../src/logic/transient-error'
import { createJobProcessor } from '../../src/service'
import { BaseComponents } from '../../src/types'

const TASK_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/asset-optimizer-queue'
const PRIORITY_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/asset-optimizer-priority-queue'
const QUEUE_URLS = { task: TASK_URL, priority: PRIORITY_URL }
const AGENT_URI = 'http://169.254.170.2/api/task-id'

const authChain = [{ type: 'SIGNER', payload: '0xabc', signature: '' }]

function stubLogs() {
  const logger = { log: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() }
  const logs: ILoggerComponent = { getLogger: () => logger }
  return { logs, logger }
}

function stubMetrics() {
  const metrics = {
    increment: jest.fn(),
    startTimer: jest.fn(() => ({ end: jest.fn() })),
    observe: jest.fn(),
    decrement: jest.fn(),
    getValue: jest.fn(),
    reset: jest.fn(),
    resetAll: jest.fn()
  }
  return metrics as unknown as IMetricsComponent<string> & typeof metrics
}

type SqsCall = { name: string; input: any }

// Hand-rolled SQS: per-queue message lists, every command recorded.
// `hangWhenEmpty` makes an empty receive wait until aborted (a real long poll).
function fakeSqs(queues: Record<string, Message[]>, options: { hangWhenEmpty?: boolean } = {}) {
  const calls: SqsCall[] = []
  const sqs = {
    async send(command: any, sendOptions?: { abortSignal?: AbortSignal }) {
      const name = String(command.constructor.name).replace(/Command$/, '')
      calls.push({ name, input: command.input })
      if (name === 'ReceiveMessage') {
        const next = queues[command.input.QueueUrl]?.shift()
        if (next) return { Messages: [next] }
        if (options.hangWhenEmpty) {
          return new Promise((_resolve, reject) => {
            sendOptions?.abortSignal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }))
            )
          })
        }
        return {}
      }
      if (name === 'SendMessage') return { MessageId: 'sent-1' }
      return {}
    }
  }
  const inputs = (name: string) => calls.filter((call) => call.name === name).map((call) => call.input)
  return { sqs, calls, inputs }
}

function message(id: string, body: unknown, receiveCount = 1): Message {
  return {
    MessageId: id,
    ReceiptHandle: `rh-${id}`,
    Body: typeof body === 'string' ? body : JSON.stringify(body),
    Attributes: { ApproximateReceiveCount: String(receiveCount) }
  }
}

function sceneJob(entityId: string, contentServerUrls = ['https://peer.decentraland.org/content']) {
  return { entity: { entityId, entityType: 'scene', authChain }, contentServerUrls }
}

function fakeFetch() {
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fetch = jest.fn(async (url: string, init: { method: string; body: string }) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '{"protection":{}}' }
  })
  return { fetch, calls }
}

function setup(
  queues: Record<string, Message[]>,
  options: Partial<SqsJobBrokerOptions> & { hangWhenEmpty?: boolean; agentUri?: string } = {}
) {
  const { logs, logger } = stubLogs()
  const metrics = stubMetrics()
  const fake = fakeSqs(queues, { hangWhenEmpty: options.hangWhenEmpty })
  const protectionFetch = fakeFetch()
  const taskProtection = createTaskProtection(
    { logs },
    { agentUri: options.agentUri, expiresInMinutes: 120, fetch: protectionFetch.fetch }
  )
  const broker = createSqsJobBroker({ logs, metrics }, fake.sqs, {
    queueUrls: QUEUE_URLS,
    visibilityTimeoutSeconds: 900,
    taskProtection,
    ...options
  })
  const adapter = createBrokerQueueAdapter({ logs, metrics }, broker, {
    queue: 'task',
    priorityQueue: 'priority',
    idleSleepMs: 1,
    errorSleepMs: 1
  })
  return { broker, adapter, metrics, logger, protection: protectionFetch, ...fake }
}

function outcomes(metrics: ReturnType<typeof stubMetrics>) {
  return metrics.increment.mock.calls
    .filter(([name]) => name === 'job_queue_outcome_total')
    .map(([, labels]) => (labels as { outcome: string }).outcome)
}

// The service's real job runner over a fake optimizer
async function jobProcessor(
  metrics: IMetricsComponent<string>,
  optimizer: jest.Mock,
  env: Record<string, string> = {}
) {
  const config = { getString: async (key: string) => env[key] } as unknown as IConfigComponent
  const components = { config, logs: stubLogs().logs, metrics } as unknown as BaseComponents
  return createJobProcessor(components, optimizer)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((ok) => (resolve = ok))
  return { promise, resolve }
}

async function flush(times = 10) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('SQS job broker', () => {
  describe('polling', () => {
    it('polls the priority queue first (briefly), then long-polls the main queue, one message at a time', async () => {
      const { broker, inputs } = setup({ [TASK_URL]: [message('m1', sceneJob('bafy1'))] })

      const job = await broker.claim(['priority', 'task'])

      expect(inputs('ReceiveMessage')).toEqual([
        {
          QueueUrl: PRIORITY_URL,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 900,
          MessageSystemAttributeNames: ['ApproximateReceiveCount']
        },
        {
          QueueUrl: TASK_URL,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 900,
          MessageSystemAttributeNames: ['ApproximateReceiveCount']
        }
      ])
      expect(job).toEqual({ queue: 'task', id: 'm1', data: sceneJob('bafy1'), receiveCount: 1 })
      await broker.complete(job!)
    })

    it('takes a priority job without polling the main queue', async () => {
      const { broker, inputs } = setup({
        [PRIORITY_URL]: [message('p1', sceneJob('bafyp'))],
        [TASK_URL]: [message('m1', sceneJob('bafy1'))]
      })

      const job = await broker.claim(['priority', 'task'])

      expect(job?.queue).toBe('priority')
      expect(inputs('ReceiveMessage').map((input) => input.QueueUrl)).toEqual([PRIORITY_URL])
      await broker.complete(job!)
    })

    it('marks priority jobs through the queue adapter', async () => {
      const { adapter } = setup({ [PRIORITY_URL]: [message('p1', sceneJob('bafyp'))] })
      const { result } = await adapter.consumeAndProcessJob(async (_job, msg) => msg)
      expect(result).toEqual({ id: 'p1', isPriority: true })
    })

    it('returns null when every queue is empty', async () => {
      const { broker } = setup({})
      expect(await broker.claim(['priority', 'task'])).toBeNull()
    })
  })

  describe('parsing', () => {
    it('unwraps an SNS envelope and normalises a world deployment to a scene', async () => {
      const world = {
        type: 'world',
        subType: 'deployment',
        entity: { entityId: 'bafyworld', authChain },
        contentServerUrls: ['https://worlds.example.org']
      }
      const { broker } = setup({
        [TASK_URL]: [message('m1', { Type: 'Notification', Message: JSON.stringify(world) })]
      })

      const job = await broker.claim(['task'])

      expect(job?.data.entity).toEqual({ entityId: 'bafyworld', entityType: 'scene', authChain })
      expect(job?.data.contentServerUrls).toEqual(['https://worlds.example.org'])
      await broker.complete(job!)
    })

    it('takes a catalyst event entity type from its subType', async () => {
      const catalyst = {
        type: 'catalyst-deployment',
        subType: 'emote',
        entity: { id: 'bafyemote', authChain, pointers: ['urn:x'] },
        contentServerUrls: ['https://peer.decentraland.org/content']
      }
      const { broker } = setup({ [TASK_URL]: [message('m1', catalyst)] })

      const job = await broker.claim(['task'])

      expect(job?.data.entity).toEqual(
        expect.objectContaining({ entityId: 'bafyemote', entityType: 'emote', pointers: ['urn:x'] })
      )
      await broker.complete(job!)
    })

    it('deletes an invalid message, counts it as invalid and keeps polling', async () => {
      const { broker, inputs, metrics, logger } = setup({
        [PRIORITY_URL]: [message('bad', '{not json')],
        [TASK_URL]: [message('m1', sceneJob('bafy1'))]
      })

      const job = await broker.claim(['priority', 'task'])

      expect(inputs('DeleteMessage')).toEqual([{ QueueUrl: PRIORITY_URL, ReceiptHandle: 'rh-bad' }])
      expect(outcomes(metrics)).toEqual(['invalid'])
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Dropping invalid message'), expect.anything())
      expect(job?.id).toBe('m1')
      await broker.complete(job!)
    })

    it('drops a message that is not a DeploymentToSqs (no authChain)', async () => {
      const { broker, inputs, metrics } = setup({
        [TASK_URL]: [message('bad', { entity: { entityId: 'bafy' } })]
      })

      expect(await broker.claim(['task'])).toBeNull()
      expect(inputs('DeleteMessage')).toEqual([{ QueueUrl: TASK_URL, ReceiptHandle: 'rh-bad' }])
      expect(outcomes(metrics)).toEqual(['invalid'])
    })
  })

  describe('outcomes through the service job runner', () => {
    it('deletes the message on success', async () => {
      const { adapter, inputs, metrics } = setup({ [TASK_URL]: [message('m1', sceneJob('bafy1'))] })
      const optimizer = jest.fn(async () => null)

      await adapter.consumeAndProcessJob(await jobProcessor(metrics, optimizer))

      expect(optimizer).toHaveBeenCalledWith(sceneJob('bafy1'), { id: 'm1', isPriority: false }, expect.anything())
      expect(inputs('DeleteMessage')).toEqual([{ QueueUrl: TASK_URL, ReceiptHandle: 'rh-m1' }])
      expect(inputs('ChangeMessageVisibility')).toEqual([])
      expect(outcomes(metrics)).toEqual(['success'])
    })

    it('deletes the message on a content failure', async () => {
      const { adapter, inputs, metrics } = setup({ [TASK_URL]: [message('m1', sceneJob('bafy1'))] })
      const optimizer = jest.fn(async () => {
        throw new ContentError('glTF parse error: missing buffer')
      })

      await adapter.consumeAndProcessJob(await jobProcessor(metrics, optimizer))

      expect(inputs('DeleteMessage')).toEqual([{ QueueUrl: TASK_URL, ReceiptHandle: 'rh-m1' }])
      expect(inputs('ChangeMessageVisibility')).toEqual([])
      expect(outcomes(metrics)).toEqual(['content_failure'])
    })

    it.each([
      ['an unclassified error (code bug)', new TypeError("Cannot read properties of undefined (reading 'x')")],
      [
        'a storage rejection (AccessDenied)',
        new TransientError('Storage rejected file v6/bafy1-mobile.zip: Access Denied', {
          cause: Object.assign(new Error('Access Denied'), { name: 'AccessDenied' })
        })
      ],
      ['a full disk', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })]
    ])('never deletes the message on %s: it is retried and eventually dead-lettered', async (_label, failure) => {
      const { adapter, inputs, metrics } = setup({ [TASK_URL]: [message('m1', sceneJob('bafy1'))] })
      const optimizer = jest.fn(async () => {
        throw failure
      })

      await adapter.consumeAndProcessJob(await jobProcessor(metrics, optimizer))

      expect(inputs('DeleteMessage')).toEqual([])
      expect(inputs('ChangeMessageVisibility')).toEqual([
        { QueueUrl: TASK_URL, ReceiptHandle: 'rh-m1', VisibilityTimeout: 300 }
      ])
      expect(outcomes(metrics)).toEqual(['transient'])
    })

    it('leaves the message on a transient failure, with a visibility backoff by receive count', async () => {
      const { adapter, inputs, metrics } = setup({ [TASK_URL]: [message('m1', sceneJob('bafy1'), 3)] })
      const optimizer = jest.fn(async () => {
        throw new TransientError('Timeout waiting for batch')
      })

      await adapter.consumeAndProcessJob(await jobProcessor(metrics, optimizer))

      expect(inputs('DeleteMessage')).toEqual([])
      expect(inputs('ChangeMessageVisibility')).toEqual([
        { QueueUrl: TASK_URL, ReceiptHandle: 'rh-m1', VisibilityTimeout: 7_200 }
      ])
      expect(outcomes(metrics)).toEqual(['transient'])
    })

    it('rejects a content server outside ALLOWED_CONTENT_SERVER_HOSTS before baking, and deletes the message', async () => {
      const { adapter, inputs, metrics } = setup({
        [TASK_URL]: [
          message('evil', sceneJob('bafyevil', ['https://evil.example.org/content'])),
          message('ok', sceneJob('bafyok', ['https://PEER.decentraland.org/content']))
        ]
      })
      const optimizer = jest.fn(async (_job: unknown) => null)
      const processJob = await jobProcessor(metrics, optimizer, {
        ALLOWED_CONTENT_SERVER_HOSTS: 'peer.decentraland.org, worlds.example.org'
      })

      await adapter.consumeAndProcessJob(processJob)
      await adapter.consumeAndProcessJob(processJob)

      expect(optimizer).toHaveBeenCalledTimes(1)
      expect(optimizer.mock.calls[0][0]).toEqual(sceneJob('bafyok', ['https://PEER.decentraland.org/content']))
      expect(inputs('DeleteMessage').map((input) => input.ReceiptHandle)).toEqual(['rh-evil', 'rh-ok'])
      expect(outcomes(metrics)).toEqual(['content_failure', 'success'])
    })
  })

  describe('backoff', () => {
    it('waits 5 min, 30 min, then 2 h, so a short outage does not dead-letter the job', () => {
      expect([undefined, 1, 2, 3, 4, 5, 10].map(backoffSecondsFor)).toEqual([300, 300, 1800, 7200, 7200, 7200, 7200])
    })

    it('never asks for more than what is left of the 12 h visibility limit', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
      try {
        const { broker, inputs } = setup({ [TASK_URL]: [message('m1', sceneJob('bafy1'), 5)] })
        const job = await broker.claim(['task'])
        jest.setSystemTime(Date.now() + (MAX_VISIBILITY_SECONDS - 100) * 1000)

        await broker.fail(job!, 'boom')

        expect(inputs('ChangeMessageVisibility').pop()).toEqual(
          expect.objectContaining({ ReceiptHandle: 'rh-m1', VisibilityTimeout: 100 })
        )
      } finally {
        jest.useRealTimers()
      }
    })
  })

  describe('visibility heartbeat', () => {
    beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }))
    afterEach(() => jest.useRealTimers())

    it('extends the visibility every half-period while the job runs, and stops when it ends', async () => {
      const { broker, inputs } = setup({ [TASK_URL]: [message('m1', sceneJob('bafy1'))] })
      const job = await broker.claim(['task'])

      jest.advanceTimersByTime(449_000)
      expect(inputs('ChangeMessageVisibility')).toEqual([])

      jest.advanceTimersByTime(1_000)
      expect(inputs('ChangeMessageVisibility')).toEqual([
        { QueueUrl: TASK_URL, ReceiptHandle: 'rh-m1', VisibilityTimeout: 900 }
      ])

      jest.advanceTimersByTime(450_000)
      expect(inputs('ChangeMessageVisibility')).toHaveLength(2)

      await broker.complete(job!)
      jest.advanceTimersByTime(10 * 450_000)
      expect(inputs('ChangeMessageVisibility')).toHaveLength(2)
      expect(broker.inFlight()).toEqual([])
    })

    it('stops extending at the 12 h visibility limit', async () => {
      const { broker, inputs, logger } = setup({ [TASK_URL]: [message('m1', sceneJob('bafy1'))] })
      await broker.claim(['task'])

      jest.advanceTimersByTime(MAX_VISIBILITY_SECONDS * 1000 + 10 * 450_000)

      const extensions = inputs('ChangeMessageVisibility').map((input) => input.VisibilityTimeout)
      expect(extensions).toHaveLength(MAX_VISIBILITY_SECONDS / 450 - 1)
      expect(extensions[extensions.length - 1]).toBe(450)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('12 h'), expect.anything())
    })

    it('keeps the job running when an extension fails', async () => {
      const { broker, sqs, logger } = setup({ [TASK_URL]: [message('m1', sceneJob('bafy1'))] })
      await broker.claim(['task'])
      const send = sqs.send
      sqs.send = async (command: any, options?: any) => {
        if (command.constructor.name === 'ChangeMessageVisibilityCommand') throw new Error('throttled')
        return send(command, options)
      }

      jest.advanceTimersByTime(450_000)
      await flush()

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('throttled'), expect.anything())
      expect(broker.inFlight()).toEqual(['m1'])
    })
  })

  describe('shutdown', () => {
    it('releases the in-flight job (visibility 0) on stop and never acknowledges it afterwards', async () => {
      const { adapter, inputs, metrics, protection } = setup(
        { [TASK_URL]: [message('m1', sceneJob('bafy1'))] },
        { agentUri: AGENT_URI }
      )
      const bake = deferred()
      const optimizer = jest.fn(() => bake.promise)
      const pending = adapter.consumeAndProcessJob(await jobProcessor(metrics, optimizer))
      await flush()
      expect(optimizer).toHaveBeenCalled()

      await adapter.stop!()

      expect(inputs('ChangeMessageVisibility')).toEqual([
        { QueueUrl: TASK_URL, ReceiptHandle: 'rh-m1', VisibilityTimeout: 0 }
      ])
      expect(protection.calls.map((call) => call.body.ProtectionEnabled)).toEqual([true, false])

      // The bake finishing later must not delete a message another task may own now
      bake.resolve()
      await pending
      expect(inputs('DeleteMessage')).toEqual([])
      expect(inputs('ChangeMessageVisibility')).toHaveLength(1)
    })

    it('aborts an in-progress long poll on stop', async () => {
      const { adapter, inputs } = setup({}, { hangWhenEmpty: true })
      const runner = jest.fn(async () => undefined)
      const pending = adapter.consumeAndProcessJob(runner)
      await flush()
      expect(inputs('ReceiveMessage')).toHaveLength(1)

      await adapter.stop!()

      await expect(pending).resolves.toEqual({ result: undefined })
      expect(runner).not.toHaveBeenCalled()
    })

    it('hands back a message received while stopping', async () => {
      const { sqs, inputs, broker } = setup({ [TASK_URL]: [message('m1', sceneJob('bafy1'))] })
      const send = sqs.send
      sqs.send = async (command: any, options?: any) => {
        const result = await send(command, options)
        if (command.constructor.name === 'ReceiveMessageCommand') await broker.stop!()
        return result
      }

      expect(await broker.claim(['task'])).toBeNull()
      expect(inputs('ChangeMessageVisibility')).toEqual([
        { QueueUrl: TASK_URL, ReceiptHandle: 'rh-m1', VisibilityTimeout: 0 }
      ])
    })

    it('lets the runner loop exit after the grace period while a bake is still running', async () => {
      const runner = createRunnerComponent({ stopGraceMs: 20 })
      await runner.start!({} as any)
      let iterations = 0
      runner.runTask(async (opt) => {
        while (opt.isRunning) {
          iterations++
          await new Promise(() => undefined) // a bake that never ends
        }
      })

      const startedAt = Date.now()
      await runner.stop!()

      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(iterations).toBe(1)
    })

    it('waits for loops that return promptly', async () => {
      const runner = createRunnerComponent({ stopGraceMs: 60_000 })
      await runner.start!({} as any)
      const finished = jest.fn()
      runner.runTask(async (opt) => {
        while (opt.isRunning) await new Promise((resolve) => setTimeout(resolve, 5))
        finished()
      })

      await runner.stop!()

      expect(finished).toHaveBeenCalled()
    })
  })

  describe('ECS task protection', () => {
    it('protects the task while a job runs and unprotects it once the queues are found empty', async () => {
      const { adapter, broker, protection } = setup(
        { [TASK_URL]: [message('m1', sceneJob('bafy1'))] },
        { agentUri: AGENT_URI + '/' }
      )
      let protectedDuringJob: unknown[] = []

      await adapter.consumeAndProcessJob(async () => {
        protectedDuringJob = protection.calls.map((call) => call.body)
      })

      expect(protectedDuringJob).toEqual([{ ProtectionEnabled: true, ExpiresInMinutes: 120 }])
      // Still protected after the job: the next claim may take another one
      expect(protection.calls).toHaveLength(1)

      await expect(broker.claim(['priority', 'task'])).resolves.toBeNull()
      expect(protection.calls).toEqual([
        {
          url: `${AGENT_URI}/task-protection/v1/state`,
          method: 'PUT',
          body: { ProtectionEnabled: true, ExpiresInMinutes: 120 }
        },
        { url: `${AGENT_URI}/task-protection/v1/state`, method: 'PUT', body: { ProtectionEnabled: false } }
      ])

      // An idle task is not unprotected over and over
      await broker.claim(['priority', 'task'])
      expect(protection.calls).toHaveLength(2)
    })

    it('stays protected between back-to-back jobs, including after a transient failure', async () => {
      const { adapter, broker, protection } = setup(
        { [TASK_URL]: [message('m1', sceneJob('bafy1')), message('m2', sceneJob('bafy2'))] },
        { agentUri: AGENT_URI }
      )
      await adapter.consumeAndProcessJob(async () => {
        throw new TransientError('ECONNRESET')
      })
      await adapter.consumeAndProcessJob(async () => undefined)
      expect(protection.calls.map((call) => call.body.ProtectionEnabled)).toEqual([true, true])

      await broker.claim(['priority', 'task'])
      expect(protection.calls.map((call) => call.body.ProtectionEnabled)).toEqual([true, true, false])
    })

    it('unprotects on stop', async () => {
      const { adapter, broker, protection } = setup(
        { [TASK_URL]: [message('m1', sceneJob('bafy1'))] },
        { agentUri: AGENT_URI }
      )
      await adapter.consumeAndProcessJob(async () => undefined)
      await broker.stop!()
      expect(protection.calls.map((call) => call.body.ProtectionEnabled)).toEqual([true, false])
    })

    it('makes no calls when ECS_AGENT_URI is not set', async () => {
      const { adapter, protection } = setup({ [TASK_URL]: [message('m1', sceneJob('bafy1'))] })
      await adapter.consumeAndProcessJob(async () => undefined)
      expect(protection.fetch).not.toHaveBeenCalled()
    })

    it('logs a failed protection call and still runs the job', async () => {
      const { logs, logger } = stubLogs()
      const fetch = jest.fn(async () => {
        throw new Error('connect ECONNREFUSED')
      })
      const protection = createTaskProtection({ logs }, { agentUri: AGENT_URI, expiresInMinutes: 120, fetch })

      await expect(protection.enable()).resolves.toBeUndefined()
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'), expect.anything())
    })

    it('logs a refusal reported by the agent', async () => {
      const { logs, logger } = stubLogs()
      const fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '{"failure":{"Reason":"TASK_NOT_VALID"}}'
      }))
      const protection = createTaskProtection({ logs }, { agentUri: AGENT_URI, expiresInMinutes: 120, fetch })

      await protection.disable()
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('TASK_NOT_VALID'), expect.anything())
    })

    it('lasts the bake budget plus a margin', () => {
      expect(protectionMinutesFor(5_400_000)).toBe(120)
      expect(protectionMinutesFor(10 ** 12)).toBe(2_880)
    })
  })

  describe('configuration', () => {
    it('parses JOB_VISIBILITY_TIMEOUT_SECONDS within what SQS accepts', () => {
      expect(parseVisibilityTimeout(undefined)).toBe(900)
      expect(parseVisibilityTimeout('')).toBe(900)
      expect(parseVisibilityTimeout('abc')).toBe(900)
      expect(parseVisibilityTimeout('1800')).toBe(1800)
      expect(parseVisibilityTimeout('5')).toBe(30)
      expect(parseVisibilityTimeout('99999')).toBe(MAX_VISIBILITY_SECONDS)
    })

    it('sends raw DeploymentToSqs bodies', async () => {
      const { broker, inputs } = setup({})
      const id = await broker.send!('priority', sceneJob('bafy1') as any)
      expect(id).toBe('sent-1')
      expect(inputs('SendMessage')).toEqual([
        { QueueUrl: PRIORITY_URL, MessageBody: JSON.stringify(sceneJob('bafy1')) }
      ])
    })
  })
})
