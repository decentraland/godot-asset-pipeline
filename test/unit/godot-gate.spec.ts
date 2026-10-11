import type { IConfigComponent, IMetricsComponent } from '@well-known-components/interfaces'
import { createGodotGate, createJobProcessor } from '../../src/service'
import { ContentError } from '../../src/logic/transient-error'
import { BaseComponents } from '../../src/types'

function stubLogs() {
  const logger = { log: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() }
  return { logs: { getLogger: () => logger }, logger }
}

function stubAssetServer(ready: boolean, restarts: boolean[] = []) {
  const restartGodot = jest.fn(async () => (restarts.length > 0 ? restarts.shift()! : true))
  return { isReady: jest.fn(async () => ready), restartGodot }
}

function gate(assetServer: ReturnType<typeof stubAssetServer>, onGiveUp = jest.fn()) {
  const { logs } = stubLogs()
  return {
    gate: createGodotGate({ assetServer, logs } as unknown as Pick<BaseComponents, 'assetServer' | 'logs'>, {
      maxFailures: 3,
      retryDelayMs: 1,
      onGiveUp
    }),
    onGiveUp
  }
}

const job = (entityId = 'bafy1') => ({ entity: { entityId, entityType: 'scene', authChain: [] } }) as any

describe('Godot gate (checked before every claim)', () => {
  it('does not restart a Godot that is up and unused', async () => {
    const assetServer = stubAssetServer(true)
    const { gate: g } = gate(assetServer)
    await expect(g.ensureReady()).resolves.toBe(true)
    expect(assetServer.restartGodot).not.toHaveBeenCalled()
  })

  it('starts Godot when it is not answering (first claim after boot, or a crash)', async () => {
    const assetServer = stubAssetServer(false)
    const { gate: g } = gate(assetServer)
    await expect(g.ensureReady()).resolves.toBe(true)
    expect(assetServer.restartGodot).toHaveBeenCalledTimes(1)
  })

  it('restarts Godot after a job used it, once the job is settled', async () => {
    const assetServer = stubAssetServer(true)
    const { gate: g } = gate(assetServer)
    g.markUsed()
    await expect(g.ensureReady()).resolves.toBe(true)
    expect(assetServer.restartGodot).toHaveBeenCalledTimes(1)
    await expect(g.ensureReady()).resolves.toBe(true)
    expect(assetServer.restartGodot).toHaveBeenCalledTimes(1)
  })

  it('refuses to claim while Godot cannot start, and gives up after too many failures in a row', async () => {
    const assetServer = stubAssetServer(false, [false, false, false])
    const { gate: g, onGiveUp } = gate(assetServer)
    await expect(g.ensureReady()).resolves.toBe(false)
    await expect(g.ensureReady()).resolves.toBe(false)
    expect(onGiveUp).not.toHaveBeenCalled()
    await expect(g.ensureReady()).resolves.toBe(false)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })

  it('resets the failure count once Godot starts', async () => {
    const assetServer = stubAssetServer(false, [false, false, true, false, false])
    const { gate: g, onGiveUp } = gate(assetServer)
    for (let i = 0; i < 5; i++) await g.ensureReady()
    expect(onGiveUp).not.toHaveBeenCalled()
  })
})

describe('job processor and the Godot gate', () => {
  async function processor(optimizer: jest.Mock) {
    const config = { getString: async () => undefined } as unknown as IConfigComponent
    const metrics = { increment: jest.fn() } as unknown as IMetricsComponent<string>
    const components = { config, logs: stubLogs().logs, metrics } as unknown as BaseComponents
    const markUsed = jest.fn()
    return { run: await createJobProcessor(components, optimizer, { markUsed }), markUsed, metrics }
  }

  it('marks Godot used after a bake, success or failure', async () => {
    const ok = await processor(jest.fn(async () => ({ result: { success: true } })))
    await ok.run(job(), { id: '1', isPriority: false })
    expect(ok.markUsed).toHaveBeenCalledTimes(1)

    const failed = await processor(
      jest.fn(async () => {
        throw new ContentError('broken glTF')
      })
    )
    await failed.run(job(), { id: '1', isPriority: false })
    expect(failed.markUsed).toHaveBeenCalledTimes(1)
  })

  it('does not restart Godot for a job skipped as already published', async () => {
    const { run, markUsed } = await processor(jest.fn(async () => null))
    await run(job(), { id: '1', isPriority: false })
    expect(markUsed).not.toHaveBeenCalled()
  })

  it('rejects an entity id that is not a content hash before baking', async () => {
    const optimizer = jest.fn()
    const { run, metrics } = await processor(optimizer)
    await run(job('../../x'), { id: '1', isPriority: false })
    expect(optimizer).not.toHaveBeenCalled()
    expect(metrics.increment).toHaveBeenCalledWith('job_queue_outcome_total', { outcome: 'content_failure' })
  })
})
