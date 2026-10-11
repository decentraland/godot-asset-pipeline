import { mkdtemp, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { BatchStalledError, BatchStatus, IAssetServerComponent } from '../../src/adapters/asset-server'
import { ContentError, TransientError } from '../../src/logic/transient-error'
import { ProcessReport, godotOptimizer, partitionServerFailures } from '../../src/runners/godot-optimizer'

const DNS_ERROR =
  'Request error: reqwest::Error { kind: Request, url: Url { scheme: "https", host: Some(Domain("worlds-content-server.decentraland.org")) }, source: hyper::Error(Connect, ConnectError("dns error", Custom { kind: Uncategorized, error: "failed to lookup address information: Temporary failure in name resolution" })) }'
const CONTENT_ERROR = 'There are some missing dependencies in the gltf'

function stubLogs() {
  const logger = { log: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() }
  return { logs: { getLogger: () => logger }, logger }
}

function job(hash: string, status: 'completed' | 'failed', error?: string) {
  return { job_id: `job-${hash}`, hash, asset_type: 'scene' as const, status, progress: 1, elapsed_secs: 1, error }
}

type Stubs = {
  batch: Partial<BatchStatus>
  storeFileStrict?: jest.Mock
}

function scene(entityId = 'bafyscene') {
  return {
    entity: { entityId, entityType: 'scene', authChain: [] },
    contentServerUrls: ['https://peer.decentraland.org/content']
  } as any
}

describe('partitionServerFailures', () => {
  it('separates network drops from content defects', () => {
    const { transient, permanent } = partitionServerFailures([
      { hash: 'a', assetType: 'scene', error: DNS_ERROR },
      { hash: 'b', assetType: 'scene', error: CONTENT_ERROR },
      { hash: 'c', assetType: 'texture', error: 'Network is unreachable' }
    ])
    expect(transient.map((j) => j.hash)).toEqual(['a', 'c'])
    expect(permanent.map((j) => j.hash)).toEqual(['b'])
  })
})

describe('godotOptimizer scene processing', () => {
  let dir: string
  const originalCwd = process.cwd()

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'godot-optimizer-spec-'))
    process.env.GODOT_CONTENT_CACHE_PATH = path.join(dir, 'cache')
    process.chdir(dir)
  })
  afterAll(async () => {
    process.chdir(originalCwd)
    delete process.env.GODOT_CONTENT_CACHE_PATH
    await rm(dir, { recursive: true, force: true })
  })

  async function setup({ batch, storeFileStrict }: Stubs) {
    const zipPath = path.join(dir, `${batch.batch_id || 'batch'}-main.zip`)
    await writeFile(zipPath, 'zip')
    const individual = await Promise.all(
      (batch.jobs || [])
        .filter((j) => j.status === 'completed')
        .map(async (j) => {
          const p = path.join(dir, `${j.hash}.zip`)
          await writeFile(p, 'zip')
          return { hash: j.hash, zip_path: p }
        })
    )
    const status: BatchStatus = {
      batch_id: 'batch',
      output_hash: 'out',
      status: 'completed',
      progress: 1,
      zip_path: zipPath,
      jobs: [],
      individual_zips: individual,
      ...batch
    }
    const assetServer: IAssetServerComponent = {
      isReady: jest.fn().mockResolvedValue(true),
      processScene: jest.fn().mockResolvedValue({ batch_id: 'batch', total_assets: status.jobs.length }),
      processAssets: jest.fn(),
      getBatchStatus: jest.fn(),
      waitForCompletion: jest.fn().mockResolvedValue(status),
      restartGodot: jest.fn().mockResolvedValue(true),
      getGodotLogs: jest.fn().mockReturnValue([]),
      clearGodotLogs: jest.fn(),
      getPanicCount: jest.fn().mockReturnValue(0)
    }
    const contentProxy = {
      register: jest.fn((entityId: string) => `http://127.0.0.1:5000/content-proxy/${entityId}/contents/`),
      unregister: jest.fn(),
      lookup: jest.fn(),
      baseUrlFor: jest.fn()
    }
    const storage = {
      storeFile: jest.fn().mockResolvedValue(undefined),
      storeFileStrict: storeFileStrict || jest.fn().mockResolvedValue(undefined),
      storeFiles: jest.fn(),
      exists: jest.fn().mockResolvedValue(false)
    }
    const config = {
      getString: jest.fn().mockResolvedValue(undefined),
      getNumber: jest.fn(),
      requireString: jest.fn(),
      requireNumber: jest.fn()
    }
    const { logs } = stubLogs()
    // Default content server: the entity exists but has no entry script; everything else is 404.
    const fetch = {
      fetch: jest.fn(async (url: string) =>
        url.endsWith('/contents/bafyscene')
          ? {
              ok: true,
              status: 200,
              json: async () => ({ id: 'bafyscene', metadata: {}, content: [] }),
              text: async () => ''
            }
          : { ok: false, status: 404, text: async () => '', json: async () => ({}) }
      )
    }
    return { assetServer, storage, config, logs, fetch, contentProxy }
  }

  /** Content server stub for a code-only scene: entity + its script + crdt. */
  function codeOnlyContentServer(fetch: { fetch: jest.Mock }) {
    const entity = {
      id: 'bafyscene',
      metadata: { main: 'bin/game.js' },
      content: [
        { file: 'scene.json', hash: 'bafyscenejson' },
        { file: 'bin/game.js', hash: 'bafyjs' },
        { file: 'main.crdt', hash: 'bafycrdt' }
      ]
    }
    const bodies: Record<string, string> = { bafyjs: 'console.log("hi")', bafycrdt: 'crdt' }
    fetch.fetch.mockImplementation(async (url: string) => {
      const hash = url.split('/').pop() as string
      if (hash === 'bafyscene') return { ok: true, status: 200, json: async () => entity, text: async () => '' }
      if (hash in bodies)
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(bodies[hash]), text: async () => '' }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    })
  }

  it('bakes from <CATALYST_URL>/content when the job carries no content server', async () => {
    const components = await setup({ batch: { jobs: [job('ok1', 'completed')] } })
    components.config.getString.mockImplementation(async (key: string) =>
      key === 'CATALYST_URL' ? 'https://peer.example.org/' : undefined
    )
    const job0 = { entity: { entityId: 'bafyscene', entityType: 'scene', authChain: [] } } as any
    const report = (await godotOptimizer(job0, { id: '1', isPriority: false }, components as any)) as ProcessReport
    expect(report.result?.success).toBe(true)
    expect(report.contentServerUrl).toBe('https://peer.example.org/content')
    expect(components.assetServer.processScene).toHaveBeenCalledWith({
      sceneHash: 'bafyscene',
      contentBaseUrl: 'https://peer.example.org/content/contents/'
    })
  })

  it('publishes a partial bake when the server dropped an asset on a content defect', async () => {
    const components = await setup({ batch: { jobs: [job('ok1', 'completed'), job('bad', 'failed', CONTENT_ERROR)] } })
    const report = (await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)) as ProcessReport
    expect(report.result?.success).toBe(true)
    expect(report.partial).toBe(true)
    expect(report.transient).toBeUndefined()
    expect(report.individualAssets.droppedByServer).toBe(1)
    expect(components.storage.storeFileStrict).toHaveBeenCalled()
  })

  it('refuses to publish a bake whose assets were dropped on network errors and fails transiently', async () => {
    const components = await setup({
      batch: { jobs: [job('ok1', 'completed'), job('net', 'failed', DNS_ERROR), job('bad', 'failed', CONTENT_ERROR)] }
    })
    const error = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(TransientError)
    expect(error.message).toContain('not publishing a partial bake')
    expect(error.message).toContain('net: Request error')
    expect(error.report.transient).toBe(true)
    expect(error.report.result.success).toBe(false)
    expect(error.report.errors).toEqual(expect.arrayContaining([expect.stringContaining('Server dropped scene bad')]))
    expect(components.storage.storeFileStrict).not.toHaveBeenCalled()
    await expect(stat(path.join(dir, 'ok1.zip'))).rejects.toThrow()
  })

  it('retries instead of recording an empty success when every download failed on the network', async () => {
    const components = await setup({
      batch: { status: 'failed', error: 'No assets completed successfully', jobs: [job('a', 'failed', DNS_ERROR)] }
    })
    const error = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(TransientError)
    expect(error.message).toContain('Batch failed on transient network errors')
  })

  it('still treats "nothing completed" on content errors as an empty success when there is no script', async () => {
    const components = await setup({
      batch: { status: 'failed', error: 'No assets completed successfully', jobs: [job('a', 'failed', CONTENT_ERROR)] }
    })
    const report = (await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)) as ProcessReport
    expect(report.result).toMatchObject({ success: true, optimizedAssets: 0 })
    expect(report.bootOnly).toBeUndefined()
    expect(components.storage.storeFileStrict).not.toHaveBeenCalled()
  })

  it('publishes the boot bundle when the server refuses a code-only scene', async () => {
    const components = await setup({ batch: {} })
    ;(components.assetServer.processScene as jest.Mock).mockRejectedValue(
      new Error('Failed to submit scene for processing: 400 {"error":"No processable assets found in scene"}')
    )
    codeOnlyContentServer(components.fetch)
    const report = (await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)) as ProcessReport
    expect(report.bootOnly).toBe(true)
    expect(report.result).toMatchObject({ success: true, optimizedAssets: 4, metadataZipPath: 'bafyscene-mobile.zip' })
    expect(report.result?.individualZips).toEqual([
      'bafyscene-mobile.zip',
      'bafyjs.js',
      'bafycrdt.crdt',
      'bafyscene-optimized.json',
      'bafyscene-boot.zip'
    ])
    const keys = (components.storage.storeFileStrict as jest.Mock).mock.calls.map(([key, , type]) => [key, type])
    expect(keys).toEqual([
      ['bafyjs.js', 'application/javascript'],
      ['bafycrdt.crdt', 'application/octet-stream'],
      ['bafyscene-optimized.json', 'application/json'],
      ['bafyscene-boot.zip', 'application/zip'],
      ['bafyscene-mobile.zip', 'application/zip']
    ])
  })

  it('publishes the boot bundle when every mesh was rejected on content', async () => {
    const components = await setup({
      batch: { status: 'failed', error: 'No assets completed successfully', jobs: [job('a', 'failed', CONTENT_ERROR)] }
    })
    codeOnlyContentServer(components.fetch)
    const report = (await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)) as ProcessReport
    expect(report.bootOnly).toBe(true)
    expect(report.result?.success).toBe(true)
    expect(components.storage.storeFileStrict).toHaveBeenCalledTimes(5)
  })

  it('fails transiently when the boot bundle cannot be fetched because the content server is down', async () => {
    const components = await setup({ batch: {} })
    ;(components.assetServer.processScene as jest.Mock).mockRejectedValue(new Error('400 No processable assets'))
    components.fetch.fetch.mockResolvedValue({ ok: false, status: 503, text: async () => '', json: async () => ({}) })
    const error = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(TransientError)
  })

  it('publishes a clean scene exactly as before: every zip under its own key, manifest zip last', async () => {
    const components = await setup({ batch: { jobs: [job('ok1', 'completed'), job('ok2', 'completed')] } })
    const report = (await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)) as ProcessReport
    expect(report.result?.success).toBe(true)
    expect(report.partial).toBe(false)
    const calls = (components.storage.storeFileStrict as jest.Mock).mock.calls.map(([key, , type]) => [key, type])
    expect(calls).toEqual([
      ['ok1.zip', 'application/zip'],
      ['ok2.zip', 'application/zip'],
      ['batch-main.zip', 'application/zip']
    ])
    expect(report.result?.individualZips).toEqual(['batch-main.zip', 'ok1.zip', 'ok2.zip'])
  })

  it('fails transiently when an upload never lands and abandons the remaining uploads', async () => {
    const storeFileStrict = jest
      .fn()
      .mockRejectedValueOnce(new TransientError('Failed to store file v6/ok1.zip after 5 attempts: EAI_AGAIN'))
      .mockResolvedValue(undefined)
    const components = await setup({
      batch: { jobs: [job('ok1', 'completed'), job('ok2', 'completed')] },
      storeFileStrict
    })
    const error = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(TransientError)
    expect(error.report.transient).toBe(true)
    expect(error.report.individualAssets.failed).toBe(1)
    expect(storeFileStrict).toHaveBeenCalledTimes(1)
    await expect(stat(path.join(dir, 'ok2.zip'))).rejects.toThrow()
  })

  it('keeps uploading after a per-asset local file error and records a content failure', async () => {
    const storeFileStrict = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))
      .mockResolvedValue(undefined)
    const components = await setup({
      batch: { jobs: [job('ok1', 'completed'), job('ok2', 'completed')] },
      storeFileStrict
    })
    const error = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(ContentError)
    expect(error.report.transient).toBeFalsy()
    expect(storeFileStrict).toHaveBeenCalledTimes(3)
  })

  it('fails transiently (never as content) when the bucket rejects the uploads', async () => {
    // What storage.ts throws for AccessDenied / NoSuchBucket: not retried in-process, but transient
    const denied = new TransientError('Storage rejected file v6/ok1.zip: Access Denied', {
      cause: Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })
    })
    const storeFileStrict = jest.fn().mockRejectedValue(denied)
    const components = await setup({ batch: { jobs: [job('ok1', 'completed')] }, storeFileStrict })
    const error = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(TransientError)
    expect(error.report.transient).toBe(true)
    expect(storeFileStrict).toHaveBeenCalledTimes(1)
  })

  it('fails transiently on an error nobody classified (a code or infrastructure fault)', async () => {
    const components = await setup({ batch: {} })
    ;(components.assetServer.waitForCompletion as jest.Mock).mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'jobs')")
    )
    const error = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(TransientError)
    expect(error.report.transient).toBe(true)
  })

  it('records a scene the content server does not have (404) as a content failure', async () => {
    const components = await setup({ batch: {} })
    ;(components.assetServer.processScene as jest.Mock).mockRejectedValue(new Error('400 No processable assets'))
    components.fetch.fetch.mockResolvedValue({ ok: false, status: 404, text: async () => '', json: async () => ({}) })
    const error = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(ContentError)
    expect(error.message).toContain('Failed to fetch entity definition: 404')
  })

  it('skips a scene that is already published, without touching Godot', async () => {
    const components = await setup({ batch: { jobs: [job('ok1', 'completed')] } })
    components.storage.exists.mockResolvedValue(true)
    const result = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)
    expect(result).toBeNull()
    expect(components.storage.exists).toHaveBeenCalledWith('bafyscene-mobile.zip')
    expect(components.assetServer.isReady).not.toHaveBeenCalled()
    expect(components.assetServer.processScene).not.toHaveBeenCalled()
    expect(components.storage.storeFileStrict).not.toHaveBeenCalled()
  })

  it('re-bakes an already published scene when the job is forced', async () => {
    const components = await setup({ batch: { jobs: [job('ok1', 'completed')] } })
    components.storage.exists.mockResolvedValue(true)
    const report = (await godotOptimizer(
      { ...scene(), force: true },
      { id: '1', isPriority: false },
      components as any
    )) as ProcessReport
    expect(report.result?.success).toBe(true)
    expect(components.storage.exists).not.toHaveBeenCalled()
    expect(components.assetServer.processScene).toHaveBeenCalled()
  })

  it('leaves the post-job Godot restart to the consume loop', async () => {
    const components = await setup({ batch: { jobs: [job('ok1', 'completed')] } })
    await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)
    expect(components.assetServer.restartGodot).not.toHaveBeenCalled()
  })

  it('keeps a batch timeout transient', async () => {
    const components = await setup({ batch: {} })
    ;(components.assetServer.waitForCompletion as jest.Mock).mockRejectedValue(
      new TransientError('Timeout waiting for batch batch to complete after 10ms')
    )
    const error = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(TransientError)
    expect(error.report.transient).toBe(true)
  })

  it('keeps a content failure of the whole batch permanent', async () => {
    const components = await setup({ batch: { status: 'failed', error: 'Scene has no scene.json', jobs: [] } })
    const error = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(ContentError)
    expect(error).not.toBeInstanceOf(TransientError)
    expect(error.report.transient).toBe(false)
  })

  it('fails transiently when godot cannot be started', async () => {
    const components = await setup({ batch: {} })
    ;(components.assetServer.isReady as jest.Mock).mockResolvedValue(false)
    ;(components.assetServer.restartGodot as jest.Mock).mockResolvedValue(false)
    await expect(godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)).rejects.toBeInstanceOf(
      TransientError
    )
  })
})

describe('godotOptimizer stalled batches', () => {
  let dir: string
  const originalCwd = process.cwd()
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'godot-optimizer-stall-'))
    process.env.GODOT_CONTENT_CACHE_PATH = path.join(dir, 'cache')
    process.chdir(dir)
  })
  afterAll(async () => {
    process.chdir(originalCwd)
    delete process.env.GODOT_CONTENT_CACHE_PATH
    await rm(dir, { recursive: true, force: true })
  })

  function stalledOn(hash: string) {
    return new BatchStalledError(
      'b1',
      [{ job_id: 'j', hash, asset_type: 'scene', status: 'downloading', progress: 0, elapsed_secs: 130 }],
      'panics',
      1,
      130_000
    )
  }

  async function setup(waits: Array<BatchStalledError | 'complete'>) {
    const zipPath = path.join(dir, 'main.zip')
    await writeFile(zipPath, 'zip')
    const okZip = path.join(dir, 'ok1.zip')
    await writeFile(okZip, 'zip')
    const completed: BatchStatus = {
      batch_id: 'b2',
      output_hash: 'o',
      status: 'completed',
      progress: 1,
      zip_path: zipPath,
      jobs: [{ job_id: '1', hash: 'ok1', asset_type: 'scene', status: 'completed', progress: 1, elapsed_secs: 1 }],
      individual_zips: [{ hash: 'ok1', zip_path: okZip }]
    }
    const waitForCompletion = jest.fn()
    for (const w of waits) {
      if (w === 'complete') waitForCompletion.mockResolvedValueOnce(completed)
      else waitForCompletion.mockRejectedValueOnce(w)
    }
    const assetServer = {
      isReady: jest.fn().mockResolvedValue(true),
      processScene: jest.fn().mockResolvedValue({ batch_id: 'b', total_assets: 2 }),
      processAssets: jest.fn(),
      getBatchStatus: jest.fn(),
      waitForCompletion,
      restartGodot: jest.fn().mockResolvedValue(true),
      getGodotLogs: jest.fn().mockReturnValue([]),
      clearGodotLogs: jest.fn(),
      getPanicCount: jest.fn().mockReturnValue(0)
    }
    const contentProxy = {
      register: jest.fn((entityId: string) => `http://127.0.0.1:5000/content-proxy/${entityId}/contents/`),
      unregister: jest.fn(),
      lookup: jest.fn(),
      baseUrlFor: jest.fn()
    }
    const storage = {
      storeFile: jest.fn(),
      storeFileStrict: jest.fn().mockResolvedValue(undefined),
      storeFiles: jest.fn(),
      exists: jest.fn().mockResolvedValue(false)
    }
    const config = { getString: jest.fn().mockResolvedValue(undefined) }
    const fetch = {
      fetch: jest.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '', json: async () => ({}) })
    }
    return { assetServer, storage, config, logs: stubLogs().logs, fetch, contentProxy }
  }

  it('converges over many passes by default (each pass excludes what stalled before)', async () => {
    const stalls = Array.from({ length: 8 }, (_, i) => stalledOn(`bafybad${i}`))
    const components = await setup([...stalls, 'complete'])
    const report = (await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)) as ProcessReport
    expect(report.result?.success).toBe(true)
    expect(report.individualAssets.droppedByServer).toBe(8)
    expect((components.contentProxy.register as jest.Mock).mock.calls.at(-1)?.[2]).toHaveLength(8)
  })

  it('also hides the stalled files siblings when the entity names them as a family', async () => {
    const stalled = new BatchStalledError(
      'b1',
      [{ job_id: 'j', hash: 'ring1', asset_type: 'scene', status: 'downloading', progress: 0, elapsed_secs: 200 }],
      'downloads',
      0,
      200_000,
      [
        { job_id: 'j', hash: 'ring1', asset_type: 'scene', status: 'downloading', progress: 0, elapsed_secs: 200 },
        { job_id: 'k', hash: 'ring2', asset_type: 'scene', status: 'queued', progress: 0, elapsed_secs: 200 },
        { job_id: 'l', hash: 'tree1', asset_type: 'scene', status: 'queued', progress: 0, elapsed_secs: 200 }
      ]
    )
    const components = await setup([stalled, 'complete'])
    components.fetch.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        id: 'bafyscene',
        metadata: {},
        content: [
          { file: 'models/building_ring_in_01.glb', hash: 'ring1' },
          { file: 'models/building_ring_in_02.glb', hash: 'ring2' },
          { file: 'models/tree_01.glb', hash: 'tree1' }
        ]
      })
    })
    const report = (await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)) as ProcessReport
    expect(report.result?.success).toBe(true)
    expect(components.contentProxy.register).toHaveBeenCalledWith(
      'bafyscene',
      'https://peer.decentraland.org/content',
      ['ring1', 'ring2']
    )
    expect(report.individualAssets.droppedByServer).toBe(2)
    expect(report.errors).toEqual([
      expect.stringContaining('Server dropped scene ring1: asset server stalled'),
      expect.stringContaining('Server dropped scene ring2: sibling of files')
    ])
  })

  it('gives a retry pass only what is left of the entity budget', async () => {
    const components = await setup([stalledOn('bafybad'), 'complete'])
    components.config.getString.mockImplementation(async (key: string) =>
      key === 'ASSET_SERVER_TIMEOUT_MS' ? '100000' : undefined
    )
    // the restart between passes takes real time; the retry must not get the full budget again
    ;(components.assetServer.restartGodot as jest.Mock).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(true), 25))
    )
    await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)
    const budgets = (components.assetServer.waitForCompletion as jest.Mock).mock.calls.map(([, ms]) => ms)
    expect(budgets).toHaveLength(2)
    expect(budgets[0]).toBe(100000)
    expect(budgets[1]).toBeLessThan(100000)
    expect(budgets[1]).toBeGreaterThan(90000)
  })

  it('re-runs the scene through the proxy without the stuck file and ships it as a partial bake', async () => {
    const components = await setup([stalledOn('bafybad'), 'complete'])
    const report = (await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any)) as ProcessReport
    expect(report.result?.success).toBe(true)
    expect(report.partial).toBe(true)
    expect(report.individualAssets.droppedByServer).toBe(1)
    expect(report.errors).toEqual([expect.stringContaining('Server dropped scene bafybad: asset server stalled')])
    expect(report.transient).toBeUndefined()
    expect(components.assetServer.restartGodot).toHaveBeenCalledTimes(1) // after the stall (the loop restarts it after the entity)
    expect(components.contentProxy.register).toHaveBeenCalledWith(
      'bafyscene',
      'https://peer.decentraland.org/content',
      ['bafybad']
    )
    expect(components.contentProxy.unregister).toHaveBeenCalledWith('bafyscene')
    const submits = (components.assetServer.processScene as jest.Mock).mock.calls.map(([p]) => p.contentBaseUrl)
    expect(submits).toEqual([
      'https://peer.decentraland.org/content/contents/',
      'http://127.0.0.1:5000/content-proxy/bafyscene/contents/'
    ])
  })

  it('accumulates exclusions across passes and fails for good when it keeps stalling', async () => {
    const components = await setup([stalledOn('bafybad1'), stalledOn('bafybad2'), stalledOn('bafybad3')])
    components.config.getString.mockImplementation(async (key: string) =>
      key === 'ASSET_SERVER_MAX_STALL_RETRIES' ? '2' : undefined
    )
    const error = await godotOptimizer(scene(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(ContentError)
    expect(error.message).toContain('Asset server stalled on 3 file(s) after 3 passes')
    const registered = (components.contentProxy.register as jest.Mock).mock.calls.map(([, , ex]) => ex)
    expect(registered).toEqual([['bafybad1'], ['bafybad1', 'bafybad2']])
    expect(components.contentProxy.unregister).toHaveBeenCalled()
  })
})

describe('godotOptimizer wearable processing', () => {
  let dir: string
  const originalCwd = process.cwd()
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'godot-optimizer-wearable-'))
    process.env.GODOT_CONTENT_CACHE_PATH = path.join(dir, 'cache')
    process.chdir(dir)
  })
  afterAll(async () => {
    process.chdir(originalCwd)
    delete process.env.GODOT_CONTENT_CACHE_PATH
    await rm(dir, { recursive: true, force: true })
  })

  function wearable() {
    return {
      entity: { entityId: 'bafywearable', entityType: 'wearable', authChain: [] },
      contentServerUrls: ['https://peer.decentraland.org/content'],
      _profileData: { originalEntityId: 'x', gltfFile: 'a.glb', contentMapping: {}, contentBaseUrl: 'https://c/' }
    } as any
  }

  async function setup(batch: Partial<BatchStatus>) {
    const status: BatchStatus = {
      batch_id: 'w',
      output_hash: 'o',
      status: 'completed',
      progress: 1,
      jobs: [],
      ...batch
    }
    const assetServer = {
      isReady: jest.fn().mockResolvedValue(true),
      processScene: jest.fn(),
      processAssets: jest.fn().mockResolvedValue({ batch_id: 'w', output_hash: 'o', jobs: [], total: 1 }),
      getBatchStatus: jest.fn(),
      waitForCompletion: jest.fn().mockResolvedValue(status),
      restartGodot: jest.fn().mockResolvedValue(true),
      getGodotLogs: jest.fn().mockReturnValue([]),
      clearGodotLogs: jest.fn(),
      getPanicCount: jest.fn().mockReturnValue(0)
    }
    const contentProxy = { register: jest.fn(), unregister: jest.fn(), lookup: jest.fn(), baseUrlFor: jest.fn() }
    const storage = {
      storeFile: jest.fn(),
      storeFileStrict: jest.fn(),
      storeFiles: jest.fn(),
      exists: jest.fn().mockResolvedValue(true)
    }
    const config = { getString: jest.fn().mockResolvedValue(undefined) }
    const fetch = { fetch: jest.fn().mockResolvedValue({ ok: true, json: async () => ({}), text: async () => '' }) }
    return { assetServer, storage, config, logs: stubLogs().logs, fetch, contentProxy }
  }

  it('retries a wearable whose download failed on the network', async () => {
    const components = await setup({
      status: 'failed',
      error: 'No assets completed successfully',
      jobs: [{ ...job('g', 'failed', DNS_ERROR), asset_type: 'wearable' }]
    })
    const error = await godotOptimizer(wearable(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(TransientError)
    expect(error.report.transient).toBe(true)
  })

  it('records a content failure of a wearable as permanent', async () => {
    const components = await setup({ status: 'failed', error: 'Error loading gltf: ERR_PARSE_ERROR', jobs: [] })
    const error = await godotOptimizer(wearable(), { id: '1', isPriority: false }, components as any).catch((e) => e)
    expect(error).toBeInstanceOf(ContentError)
    expect(error.report.transient).toBe(false)
    // Wearables are always baked (no already-published check)
    expect(components.storage.exists).not.toHaveBeenCalled()
  })
})
