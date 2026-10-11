import { test } from '../components'

test('integration sanity tests using a real server backend', function ({ components, spyComponents }) {
  it('responds /ping', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/ping')

    expect(r.status).toEqual(200)
    expect(await r.text()).toEqual('/ping')
  })

  it('calling /ping increments a metric', async () => {
    const { localFetch } = components

    // create the spy
    spyComponents.metrics.increment

    const r = await localFetch.fetch('/ping')

    expect(r.status).toEqual(200)
    expect(await r.text()).toEqual('/ping')

    expect(spyComponents.metrics.increment).toBeCalledWith('test_ping_counter', { pathname: '/ping' })
  })

  it('responds /health/live', async () => {
    const r = await components.localFetch.fetch('/health/live')

    expect(r.status).toEqual(200)
  })

  it('serves the job queue metrics on /metrics', async () => {
    const r = await components.localFetch.fetch('/metrics')

    expect(r.status).toEqual(200)
    const body = await r.text()
    expect(body).toContain('job_queue_duration_seconds')
    expect(body).toContain('job_queue_outcome_total')
  })

  it('random url responds 404', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/ping' + Math.random())

    expect(r.status).toEqual(404)
  })
})
