import { test } from '../components'

// The service loop drains the in-memory queue; a job whose content server is
// outside ALLOWED_CONTENT_SERVER_HOSTS is dropped as a content failure before
// anything is fetched or baked.
const previousAllowlist = process.env.ALLOWED_CONTENT_SERVER_HOSTS
process.env.ALLOWED_CONTENT_SERVER_HOSTS = 'peer.decentraland.org'

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const startedAt = Date.now()
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('service loop', function ({ components, spyComponents }) {
  afterAll(() => {
    if (previousAllowlist === undefined) delete process.env.ALLOWED_CONTENT_SERVER_HOSTS
    else process.env.ALLOWED_CONTENT_SERVER_HOSTS = previousAllowlist
  })

  it('rejects a job from a content server outside the allowlist as a content failure', async () => {
    const increment = spyComponents.metrics.increment
    const processScene = spyComponents.assetServer.processScene

    await components.taskQueue.publish({
      entity: { entityId: 'bafyforeign', authChain: [] },
      contentServerUrls: ['https://evil.example.org/content']
    })

    await waitFor(() =>
      increment.mock.calls.some(
        ([name, labels]) => name === 'job_queue_outcome_total' && labels?.outcome === 'content_failure'
      )
    )
    expect(processScene).not.toHaveBeenCalled()
  })
})
