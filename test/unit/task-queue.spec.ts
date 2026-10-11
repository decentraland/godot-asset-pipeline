import type { ILoggerComponent, IMetricsComponent } from '@well-known-components/interfaces'
import { BrokerJob, IJobBroker } from '../../src/adapters/job-broker'
import { BrokerQueueAdapterOptions, createBrokerQueueAdapter } from '../../src/adapters/task-queue'

type Payload = { entity: { entityId: string; entityType?: string } }

function stubLogs() {
  const logger = { log: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() }
  const logs: ILoggerComponent = { getLogger: () => logger }
  return { logs, logger }
}

function stubMetrics() {
  const end = jest.fn()
  const metrics = {
    increment: jest.fn(),
    startTimer: jest.fn(() => ({ end })),
    observe: jest.fn(),
    decrement: jest.fn(),
    getValue: jest.fn(),
    reset: jest.fn(),
    resetAll: jest.fn()
  }
  return { metrics: metrics as unknown as IMetricsComponent<string>, calls: metrics, end }
}

type ClaimAnswer = BrokerJob<Payload> | null | Error

const LANES: BrokerQueueAdapterOptions = { queue: 'main', priorityQueue: 'priority' }

// Scripted broker: every claim() answers with the next entry (repeating the
// last), records the queue order it was asked for, and logs complete/fail/send.
function scriptedBroker(answers: ClaimAnswer[], withSend = true) {
  const claims: string[][] = []
  const completed: Array<[string, string]> = []
  const failed: Array<[string, string, string | undefined]> = []
  const sent: Array<[string, Payload]> = []
  let sendId = 0
  const broker: IJobBroker<Payload> = {
    async claim(queues) {
      claims.push([...queues])
      const answer = answers[Math.min(claims.length - 1, answers.length - 1)]
      if (answer instanceof Error) throw answer
      return answer
    },
    async complete(job) {
      completed.push([job.queue, job.id])
    },
    async fail(job, error) {
      failed.push([job.queue, job.id, error])
    },
    ...(withSend && {
      async send(queue: string, data: Payload) {
        sent.push([queue, data])
        return `sent-${++sendId}`
      }
    })
  }
  return { broker, claims, completed, failed, sent }
}

function job(queue: string, id: string, entityId = 'bafy'): BrokerJob<Payload> {
  return { queue, id, data: { entity: { entityId } } }
}

async function flush(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('createBrokerQueueAdapter', () => {
  describe('polling order', () => {
    it('always asks for the priority queue first, then the main queue', async () => {
      const { broker, claims } = scriptedBroker([job('main', 'j1'), job('priority', 'p1')])
      const { logs } = stubLogs()
      const adapter = createBrokerQueueAdapter({ logs, metrics: stubMetrics().metrics }, broker, LANES)

      const first = await adapter.consumeAndProcessJob(async (data, message) => ({ data, message }))
      const second = await adapter.consumeAndProcessJob(async (_data, message) => message)

      expect(claims).toEqual([
        ['priority', 'main'],
        ['priority', 'main']
      ])
      expect(first.result).toEqual({ data: { entity: { entityId: 'bafy' } }, message: { id: 'j1', isPriority: false } })
      expect(second.result).toEqual({ id: 'p1', isPriority: true })
    })

    it('polls only the main queue when there is no priority queue', async () => {
      const { broker, claims } = scriptedBroker([job('main', 'j1')])
      const { logs } = stubLogs()
      const adapter = createBrokerQueueAdapter({ logs, metrics: stubMetrics().metrics }, broker, { queue: 'main' })

      await adapter.consumeAndProcessJob(async () => 1)

      expect(claims).toEqual([['main']])
    })

    it('sleeps idleSleepMs on a miss', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
      try {
        const { broker, claims } = scriptedBroker([null, null, job('main', 'j1')])
        const { logs } = stubLogs()
        const adapter = createBrokerQueueAdapter({ logs, metrics: stubMetrics().metrics }, broker, {
          ...LANES,
          idleSleepMs: 1000
        })

        const pending = adapter.consumeAndProcessJob(async () => 'done')
        await flush()
        expect(claims).toHaveLength(1)

        jest.advanceTimersByTime(999)
        await flush()
        expect(claims).toHaveLength(1)

        jest.advanceTimersByTime(1)
        await flush()
        expect(claims).toHaveLength(2)

        jest.advanceTimersByTime(1000)
        const { result } = await pending
        expect(result).toBe('done')
        expect(claims).toHaveLength(3)
      } finally {
        jest.useRealTimers()
      }
    })
  })

  describe('job lifecycle', () => {
    it('completes the job after a successful run and times it under its queue name', async () => {
      const { broker, completed, failed } = scriptedBroker([job('main', 'j1')])
      const { logs } = stubLogs()
      const { metrics, calls, end } = stubMetrics()
      const adapter = createBrokerQueueAdapter({ logs, metrics }, broker, LANES)

      const { result } = await adapter.consumeAndProcessJob(async () => 'ok')

      expect(result).toBe('ok')
      expect(completed).toEqual([['main', 'j1']])
      expect(failed).toEqual([])
      expect(calls.startTimer).toHaveBeenCalledWith('job_queue_duration_seconds', { queue_name: 'main' })
      expect(end).toHaveBeenCalledTimes(1)
      expect(calls.increment).not.toHaveBeenCalled()
    })

    it('fails the job with the error message and counts the failure when the runner throws', async () => {
      const { broker, completed, failed } = scriptedBroker([job('main', 'j1')])
      const { logs, logger } = stubLogs()
      const { metrics, calls, end } = stubMetrics()
      const adapter = createBrokerQueueAdapter({ logs, metrics }, broker, LANES)

      const { result } = await adapter.consumeAndProcessJob(async () => {
        throw new Error('boom')
      })

      expect(result).toBeUndefined()
      expect(completed).toEqual([])
      expect(failed).toEqual([['main', 'j1', 'boom']])
      expect(calls.increment).toHaveBeenCalledWith('job_queue_failures_total', { queue_name: 'main' })
      expect(end).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalled()
    })

    it('keeps the result when the broker refuses the completion (expired-and-redelivered race)', async () => {
      const { broker } = scriptedBroker([job('main', 'j1')])
      broker.complete = async () => {
        throw new Error('receipt handle expired')
      }
      const { logs, logger } = stubLogs()
      const adapter = createBrokerQueueAdapter({ logs, metrics: stubMetrics().metrics }, broker, LANES)

      const { result } = await adapter.consumeAndProcessJob(async () => 'ok')

      expect(result).toBe('ok')
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/complete/), expect.objectContaining({ id: 'j1' }))
    })
  })

  describe('claim errors', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('sleeps errorSleepMs on a claim error instead of hot-looping', async () => {
      const { broker, claims } = scriptedBroker([new Error('connection refused'), job('main', 'j1')])
      const { logs, logger } = stubLogs()
      const adapter = createBrokerQueueAdapter({ logs, metrics: stubMetrics().metrics }, broker, {
        ...LANES,
        errorSleepMs: 5000
      })

      const pending = adapter.consumeAndProcessJob(async () => 'ok')
      await flush()
      expect(claims).toHaveLength(1)
      expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/connection refused/))

      jest.advanceTimersByTime(4999)
      await flush()
      expect(claims).toHaveLength(1)

      jest.advanceTimersByTime(1)
      const { result } = await pending
      expect(result).toBe('ok')
      expect(claims).toHaveLength(2)
    })
  })

  describe('stop()', () => {
    it('makes a pending consumeAndProcessJob resolve with no result', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
      try {
        const { broker, claims } = scriptedBroker([null])
        const { logs } = stubLogs()
        const adapter = createBrokerQueueAdapter({ logs, metrics: stubMetrics().metrics }, broker, {
          ...LANES,
          idleSleepMs: 60_000
        })

        const pending = adapter.consumeAndProcessJob(async () => 'never')
        await flush()
        expect(claims).toHaveLength(1)

        await adapter.stop!()
        await expect(pending).resolves.toEqual({ result: undefined })
        // and it does not start polling again
        const again = await adapter.consumeAndProcessJob(async () => 'never')
        expect(again).toEqual({ result: undefined })
        expect(claims).toHaveLength(1)
      } finally {
        jest.useRealTimers()
      }
    })

    function stoppingBroker(withRelease: boolean) {
      let deliver: (value: BrokerJob<Payload> | null) => void = () => {}
      const failed: Array<[string, string, string | undefined]> = []
      const released: Array<[string, string]> = []
      const broker: IJobBroker<Payload> = {
        claim: () => new Promise((resolve) => (deliver = resolve)),
        complete: jest.fn(),
        fail: async (claimed, error) => {
          failed.push([claimed.queue, claimed.id, error])
        },
        ...(withRelease && {
          release: async (claimed: BrokerJob<Payload>) => {
            released.push([claimed.queue, claimed.id])
          }
        })
      }
      return { broker, failed, released, deliver: (value: BrokerJob<Payload>) => deliver(value) }
    }

    it('releases a job claimed while stopping so another consumer can take it', async () => {
      const { logs } = stubLogs()
      const { broker, failed, released, deliver } = stoppingBroker(true)
      const adapter = createBrokerQueueAdapter({ logs, metrics: stubMetrics().metrics }, broker, LANES)
      const runner = jest.fn(async () => 'never')

      const pending = adapter.consumeAndProcessJob(runner)
      await flush()
      await adapter.stop!()
      deliver(job('main', 'late'))

      await expect(pending).resolves.toEqual({ result: undefined })
      expect(runner).not.toHaveBeenCalled()
      expect(released).toEqual([['main', 'late']])
      expect(failed).toEqual([])
    })

    it('falls back to fail() when the broker cannot release', async () => {
      const { logs } = stubLogs()
      const { broker, failed, deliver } = stoppingBroker(false)
      const adapter = createBrokerQueueAdapter({ logs, metrics: stubMetrics().metrics }, broker, LANES)

      const pending = adapter.consumeAndProcessJob(async () => 'never')
      await flush()
      await adapter.stop!()
      deliver(job('main', 'late'))

      await expect(pending).resolves.toEqual({ result: undefined })
      expect(failed).toEqual([['main', 'late', expect.stringMatching(/stopp/)]])
    })
  })

  describe('publish()', () => {
    it('sends to the main queue, or the priority queue when asked', async () => {
      const { broker, sent } = scriptedBroker([])
      const { logs } = stubLogs()
      const { metrics, calls } = stubMetrics()
      const adapter = createBrokerQueueAdapter({ logs, metrics }, broker, LANES)

      const scene = await adapter.publish({ entity: { entityId: 'a' } })
      const wearable = await adapter.publish({ entity: { entityId: 'b', entityType: 'wearable' } })
      const priority = await adapter.publish({ entity: { entityId: 'c', entityType: 'emote' } }, true)

      expect(sent.map(([queue]) => queue)).toEqual(['main', 'main', 'priority'])
      expect(scene).toEqual({ id: 'sent-1', isPriority: false })
      expect(wearable).toEqual({ id: 'sent-2', isPriority: false })
      expect(priority).toEqual({ id: 'sent-3', isPriority: true })
      expect(calls.increment).toHaveBeenCalledWith('job_queue_enqueue_total', { queue_name: 'priority' })
    })

    it('sends a prioritized job to the main queue when there is no priority queue', async () => {
      const { broker, sent } = scriptedBroker([])
      const { logs } = stubLogs()
      const adapter = createBrokerQueueAdapter({ logs, metrics: stubMetrics().metrics }, broker, { queue: 'main' })

      const message = await adapter.publish({ entity: { entityId: 'a' } }, true)

      expect(sent.map(([queue]) => queue)).toEqual(['main'])
      expect(message.isPriority).toBe(false)
    })

    it('throws when the broker cannot send', async () => {
      const { broker } = scriptedBroker([], false)
      const { logs } = stubLogs()
      const adapter = createBrokerQueueAdapter({ logs, metrics: stubMetrics().metrics }, broker, LANES)

      await expect(adapter.publish({ entity: { entityId: 'a' } })).rejects.toThrow(/not supported/)
    })
  })
})
