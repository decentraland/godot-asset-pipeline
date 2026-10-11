import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import {
  BatchStalledError,
  GODOT_BINARY,
  createAssetServerComponent,
  godotServerCommand
} from '../../src/adapters/asset-server'
import { TransientError } from '../../src/logic/transient-error'

const spawnMock = jest.fn()
const execMock = jest.fn((_cmd: string, cb: (err: null, out: { stdout: string; stderr: string }) => void) =>
  cb(null, { stdout: '', stderr: '' })
)
jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  exec: (...args: unknown[]) => (execMock as any)(...args)
}))

function stubLogs() {
  const logger = { log: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() }
  return { logs: { getLogger: () => logger }, logger }
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; unref: jest.Mock }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.unref = jest.fn()
  return child
}

async function untilSpawned(): Promise<void> {
  for (let i = 0; i < 200 && spawnMock.mock.calls.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  if (spawnMock.mock.calls.length === 0) throw new Error('spawn was never called')
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) }
}

describe('godotServerCommand', () => {
  it('describes the asset-server launch without a shell', () => {
    expect(godotServerCommand('9090')).toEqual({
      file: GODOT_BINARY,
      args: ['--headless', '--asset-server', '--asset-server-port', '9090']
    })
    expect(godotServerCommand().args).toContain('8080')
  })
})

describe('restartGodot', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    execMock.mockClear()
  })

  it('spawns the binary directly (no exec buffer) and captures its output', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const fetch = { fetch: jest.fn().mockResolvedValue(jsonResponse({ status: 'ok' })) }
    const { logs } = stubLogs()
    const server = createAssetServerComponent(
      { logs, fetch: fetch as any },
      { baseUrl: 'http://localhost:8080', timings: { restartSettleMs: 1, readyPollMs: 1 } }
    )

    const ready = server.restartGodot()
    await untilSpawned()
    child.stdout.write('[godot] hello\n')
    child.stderr.write('warning\n')
    await expect(ready).resolves.toBe(true)

    expect(execMock.mock.calls[0][0]).toContain('pkill -9 -f "decentraland.godot.client"')
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [file, args, options] = spawnMock.mock.calls[0]
    expect(file).toBe(GODOT_BINARY)
    expect(args).toEqual(['--headless', '--asset-server', '--asset-server-port', '8080'])
    expect(options).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] })
    expect(child.unref).toHaveBeenCalled()
    const logsAfter = server.getGodotLogs()
    expect(logsAfter).toEqual(expect.arrayContaining(['[godot] hello', '[stderr] warning']))
    expect(logsAfter.some((line) => line.includes('Godot asset-server is ready'))).toBe(true)
  })

  it('reports false when the server never becomes healthy, and survives a spawn error', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const fetch = { fetch: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    const { logs } = stubLogs()
    const server = createAssetServerComponent(
      { logs, fetch: fetch as any },
      { baseUrl: 'http://localhost:8080', timings: { restartSettleMs: 1, readyPollMs: 1, readyPollAttempts: 3 } }
    )

    const ready = server.restartGodot()
    await untilSpawned()
    child.emit('error', new Error('ENOENT'))
    await expect(ready).resolves.toBe(false)
    expect(server.getGodotLogs().some((line) => line.includes('failed to spawn Godot: ENOENT'))).toBe(true)
  })
})

describe('waitForCompletion', () => {
  it('returns the batch once completed', async () => {
    const statuses = [{ status: 'processing' }, { status: 'completed', zip_path: '/tmp/a.zip', jobs: [] }]
    const fetch = { fetch: jest.fn().mockImplementation(async () => jsonResponse(statuses.shift())) }
    const { logs } = stubLogs()
    const server = createAssetServerComponent(
      { logs, fetch: fetch as any },
      { baseUrl: 'http://localhost:8080', timings: { batchPollMs: 1 } }
    )
    await expect(server.waitForCompletion('b1', 1000)).resolves.toMatchObject({ status: 'completed' })
  })

  it('times out with a TransientError so the queue retries the job', async () => {
    const fetch = { fetch: jest.fn().mockImplementation(async () => jsonResponse({ status: 'processing' })) }
    const { logs } = stubLogs()
    const server = createAssetServerComponent(
      { logs, fetch: fetch as any },
      { baseUrl: 'http://localhost:8080', timings: { batchPollMs: 1 } }
    )
    const error = await server.waitForCompletion('b2', 20).catch((e) => e)
    expect(error).toBeInstanceOf(TransientError)
    expect(error.message).toBe('Timeout waiting for batch b2 to complete after 20ms')
  })
})

describe('asset server HTTP errors', () => {
  function serverWith(status: number) {
    const fetch = {
      fetch: jest.fn().mockResolvedValue({ ok: false, status, text: async () => 'nope', json: async () => ({}) })
    }
    const { logs } = stubLogs()
    return createAssetServerComponent({ logs, fetch: fetch as any }, { baseUrl: 'http://localhost:8080' })
  }

  it('turns a 5xx into a TransientError', async () => {
    await expect(serverWith(503).getBatchStatus('b')).rejects.toBeInstanceOf(TransientError)
    await expect(serverWith(502).processScene({ sceneHash: 's', contentBaseUrl: 'u' })).rejects.toBeInstanceOf(
      TransientError
    )
  })

  it('keeps a 4xx permanent', async () => {
    const error = await serverWith(400)
      .processScene({ sceneHash: 's', contentBaseUrl: 'u' })
      .catch((e) => e)
    expect(error).not.toBeInstanceOf(TransientError)
    expect(error.message).toBe('Failed to submit scene for processing: 400 nope')
  })
})

describe('waitForCompletion stall detection', () => {
  const stuck = (status: string) => [
    { job_id: '1', hash: 'bafydone', asset_type: 'scene', status: 'completed', progress: 1, elapsed_secs: 1 },
    { job_id: '2', hash: 'bafystuck', asset_type: 'scene', status, progress: 0, elapsed_secs: 99 }
  ]

  async function serverWithPanics(panicLines: number, jobs: unknown[]) {
    const child = fakeChild()
    spawnMock.mockReset()
    spawnMock.mockReturnValue(child)
    let healthCalls = 0
    const fetch = {
      fetch: jest.fn(async (url: string) => {
        if (url.endsWith('/health')) {
          healthCalls++
          return jsonResponse({ ok: true })
        }
        return jsonResponse({ batch_id: 'b', output_hash: 'o', status: 'processing', progress: 0.5, jobs })
      })
    }
    const { logs } = stubLogs()
    const server = createAssetServerComponent(
      { logs, fetch: fetch as any },
      { baseUrl: 'http://localhost:8080', timings: { restartSettleMs: 1, readyPollMs: 1, batchPollMs: 1 } }
    )
    const ready = server.restartGodot()
    await untilSpawned()
    for (let i = 0; i < panicLines; i++) {
      child.stderr.write(`ERROR: [Rust:log] thread 'dcl-godot-tokio' panicked at 'FromGodot::from_variant() failed'\n`)
    }
    await ready
    expect(healthCalls).toBeGreaterThan(0)
    return server
  }

  it('throws BatchStalledError once godot panicked for every pending job and nothing progresses', async () => {
    const server = await serverWithPanics(1, stuck('downloading'))
    expect(server.getPanicCount()).toBe(1)
    const error = await server
      .waitForCompletion('b', 10_000, { stallPanicMs: 20, stallDownloadMs: 10_000 })
      .catch((e) => e)
    expect(error).toBeInstanceOf(BatchStalledError)
    expect(error.reason).toBe('panics')
    expect(error.stuckJobs.map((j: any) => j.hash)).toEqual(['bafystuck'])
  })

  it('throws BatchStalledError when every pending job is stuck downloading for too long', async () => {
    const server = await serverWithPanics(0, stuck('downloading'))
    const error = await server
      .waitForCompletion('b', 10_000, { stallPanicMs: 10_000, stallDownloadMs: 20 })
      .catch((e) => e)
    expect(error).toBeInstanceOf(BatchStalledError)
    expect(error.reason).toBe('downloads')
  })

  it('does not call a job that is still processing a stall, and times out normally instead', async () => {
    const server = await serverWithPanics(0, stuck('processing'))
    const error = await server.waitForCompletion('b', 60, { stallPanicMs: 5, stallDownloadMs: 5 }).catch((e) => e)
    expect(error).not.toBeInstanceOf(BatchStalledError)
    expect(error.message).toContain('Timeout waiting for batch')
  })

  it('flags a job stuck downloading while others complete, without waiting for the batch to go idle', async () => {
    const child = fakeChild()
    spawnMock.mockReset()
    spawnMock.mockReturnValue(child)
    let polls = 0
    const fetch = {
      fetch: jest.fn(async (url: string) => {
        if (url.endsWith('/health')) return jsonResponse({ ok: true })
        polls++
        // job A never leaves downloading; B..E complete one per poll
        const others = ['b', 'c', 'd', 'e'].map((h, i) => ({
          job_id: h,
          hash: `bafy${h}`,
          asset_type: 'scene',
          status: i < polls ? 'completed' : 'queued',
          progress: 0,
          elapsed_secs: polls
        }))
        return jsonResponse({
          batch_id: 'b',
          output_hash: 'o',
          status: 'processing',
          progress: 0.5,
          jobs: [
            {
              job_id: 'a',
              hash: 'bafya',
              asset_type: 'scene',
              status: 'downloading',
              progress: 0,
              elapsed_secs: polls
            },
            ...others
          ]
        })
      })
    }
    const { logs } = stubLogs()
    const server = createAssetServerComponent(
      { logs, fetch: fetch as any },
      { baseUrl: 'http://localhost:8080', timings: { restartSettleMs: 1, readyPollMs: 1, batchPollMs: 5 } }
    )
    const error = await server
      .waitForCompletion('b', 10_000, { stallPanicMs: 10_000, stallDownloadMs: 10_000, stallDownloadJobMs: 30 })
      .catch((e) => e)
    expect(error).toBeInstanceOf(BatchStalledError)
    expect(error.reason).toBe('downloads')
    expect(error.stuckJobs.map((j: any) => j.hash)).toEqual(['bafya'])
    expect(error.message).toContain('1 job(s) made no progress')
  })

  it('treats too many stuck downloads as a network problem (transient), not as files to exclude', async () => {
    let polls = 0
    const stuckMany = Array.from({ length: 30 }, (_, i) => ({
      job_id: `j${i}`,
      hash: `bafystuck${i}`,
      asset_type: 'scene',
      status: 'downloading',
      progress: 0,
      elapsed_secs: 1
    }))
    const fetch = {
      fetch: jest.fn(async () => {
        polls++
        return jsonResponse({
          batch_id: 'b',
          output_hash: 'o',
          status: 'processing',
          progress: 0.1,
          jobs: [
            ...stuckMany,
            {
              job_id: 'ok',
              hash: 'bafyok',
              asset_type: 'scene',
              status: polls > 1 ? 'completed' : 'queued',
              progress: 1,
              elapsed_secs: 1
            }
          ]
        })
      })
    }
    const { logs } = stubLogs()
    const server = createAssetServerComponent(
      { logs, fetch: fetch as any },
      { baseUrl: 'http://localhost:8080', timings: { batchPollMs: 5 } }
    )
    const error = await server
      .waitForCompletion('b', 10_000, {
        stallPanicMs: 10_000,
        stallDownloadMs: 10_000,
        stallDownloadJobMs: 30,
        maxStalledJobs: 25
      })
      .catch((e) => e)
    expect(error).toBeInstanceOf(TransientError)
    expect(error.message).toContain('more than 25')
  })

  it('resets the panic counter when godot restarts', async () => {
    const server = await serverWithPanics(2, stuck('downloading'))
    expect(server.getPanicCount()).toBe(2)
    server.clearGodotLogs()
    expect(server.getPanicCount()).toBe(0)
  })
})
