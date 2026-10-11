import { SQSClient } from '@aws-sdk/client-sqs'
import { test } from '../components'

// With TASK_QUEUE / PRIORITY_TASK_QUEUE set, the program consumes from SQS:
// the priority queue first, then the main queue. The SQS client is stubbed at
// its `send`, so no request leaves the process.
const TASK_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/asset-optimizer-queue'
const PRIORITY_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/asset-optimizer-priority-queue'

const previous = {
  TASK_QUEUE: process.env.TASK_QUEUE,
  PRIORITY_TASK_QUEUE: process.env.PRIORITY_TASK_QUEUE,
  ALLOWED_CONTENT_SERVER_HOSTS: process.env.ALLOWED_CONTENT_SERVER_HOSTS,
  BUCKET: process.env.BUCKET,
  S3_PREFIX: process.env.S3_PREFIX
}
process.env.TASK_QUEUE = TASK_URL
process.env.PRIORITY_TASK_QUEUE = PRIORITY_URL
process.env.ALLOWED_CONTENT_SERVER_HOSTS = 'peer.decentraland.org'
// Required with a queue; no S3 call is made (both jobs are dropped before baking)
process.env.BUCKET = 'test-bucket'
process.env.S3_PREFIX = 'v0'

type Sent = { name: string; input: any }
const sent: Sent[] = []
// Messages the main queue hands out; filled by the test once the program runs
const pending: Array<{ MessageId: string; ReceiptHandle: string; Body: string }> = []

// Patched by hand, not with jest.spyOn: the test runner resets and restores
// every jest mock around each test, while this loop runs from startup.
const originalSend = SQSClient.prototype.send
SQSClient.prototype.send = async function (command: any) {
  const name = String(command.constructor.name).replace(/Command$/, '')
  sent.push({ name, input: command.input })
  if (name === 'ReceiveMessage') {
    const next = command.input.QueueUrl === TASK_URL ? pending.shift() : undefined
    if (next) return { Messages: [next] }
    // A long poll that found nothing
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return {}
} as any

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('SQS wiring', function ({ spyComponents }) {
  afterAll(() => {
    SQSClient.prototype.send = originalSend
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('polls the priority queue before the main queue and deletes invalid and disallowed jobs', async () => {
    // Spies are installed on first access: take them before any job runs
    const increment = spyComponents.metrics.increment
    const processScene = spyComponents.assetServer.processScene
    pending.push(
      { MessageId: 'bad', ReceiptHandle: 'rh-bad', Body: 'not json' },
      {
        MessageId: 'evil',
        ReceiptHandle: 'rh-evil',
        Body: JSON.stringify({
          entity: { entityId: 'bafyevil', authChain: [{ type: 'SIGNER', payload: '0xabc', signature: '' }] },
          contentServerUrls: ['https://evil.example.org/content']
        })
      }
    )
    await waitFor(() => sent.filter((call) => call.name === 'DeleteMessage').length >= 2)

    const receives = sent.filter((call) => call.name === 'ReceiveMessage').map((call) => call.input.QueueUrl)
    expect(receives.slice(0, 2)).toEqual([PRIORITY_URL, TASK_URL])
    expect(sent.filter((call) => call.name === 'DeleteMessage').map((call) => call.input)).toEqual([
      { QueueUrl: TASK_URL, ReceiptHandle: 'rh-bad' },
      { QueueUrl: TASK_URL, ReceiptHandle: 'rh-evil' }
    ])

    const outcomes = increment.mock.calls
      .filter(([name]) => name === 'job_queue_outcome_total')
      .map(([, labels]) => labels?.outcome)
    expect(outcomes).toEqual(['invalid', 'content_failure'])
    expect(processScene).not.toHaveBeenCalled()
  })
})
