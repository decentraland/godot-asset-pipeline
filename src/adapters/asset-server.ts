import { IFetchComponent } from '@well-known-components/http-server'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { TransientError, isTransientHttpStatus } from '../logic/transient-error'

const execAsync = promisify(exec)

/**
 * Default bake budget per entity, shared by all its retry passes; overridden
 * by ASSET_SERVER_TIMEOUT_MS (.env.default). Heavy scenes take 40 min on
 * shared vCPUs while still making progress every poll, so 90 min plus
 * uploads covers them.
 */
export const DEFAULT_ASSET_SERVER_TIMEOUT_MS = 5_400_000
export const GODOT_BINARY = '/app/decentraland.godot.client.x86_64'
export const DEFAULT_ASSET_SERVER_PORT = '8080'
/** How long to wait after killing the previous godot before starting a new one. */
export const DEFAULT_RESTART_SETTLE_MS = 2_000
/** Poll interval and attempts while waiting for /health after a (re)start. */
export const DEFAULT_READY_POLL_MS = 1_000
export const DEFAULT_READY_POLL_ATTEMPTS = 60
export const DEFAULT_BATCH_POLL_MS = 2_000
/**
 * Stall detection while polling a batch. A job whose worker panicked inside
 * the asset server never reaches a terminal state, so the batch would only
 * end at the (30 min) timeout. Two signals, both requiring zero progress
 * (no job reached completed/failed) for the given time:
 *  - panics: godot logged at least as many `panicked at` lines as there are
 *    pending jobs — every pending job is a dead worker;
 *  - downloads: every pending job still says `downloading` — nothing is being
 *    processed, and no download takes that long.
 */
export const DEFAULT_STALL_PANIC_MS = 2 * 60_000
export const DEFAULT_STALL_DOWNLOAD_MS = 10 * 60_000
/**
 * Per-job rule: a job that has been `downloading` for this long while other
 * jobs completed meanwhile never started its request (the server's download
 * slot is dead) — it starves the batch to a trickle without ever stalling it
 * completely. Files are a few MB; a real download never takes minutes.
 */
export const DEFAULT_STALL_DOWNLOAD_JOB_MS = 3 * 60_000
/** Once one download is stuck, the other in-flight ones older than this hold dead slots too. */
export const STALL_DOWNLOAD_SIBLING_MS = 60_000
/**
 * More stuck jobs than this is not a few bad files but a broken network
 * (every download hangs): fail transiently so the queue retries the whole
 * job later instead of publishing a bake with most of the scene missing.
 */
export const DEFAULT_MAX_STALLED_JOBS = 25
const PANIC_MARKER = 'panicked at'

/** The batch stopped making progress and the pending jobs will never finish (see stall detection). */
export class BatchStalledError extends Error {
  readonly stuckJobs: JobStatus[]
  /** Every non-terminal job at the moment of the stall (the stuck ones included). */
  readonly pendingJobs: JobStatus[]
  readonly reason: 'panics' | 'downloads'
  constructor(
    batchId: string,
    stuckJobs: JobStatus[],
    reason: 'panics' | 'downloads',
    panics: number,
    stalledMs: number,
    pendingJobs: JobStatus[] = stuckJobs
  ) {
    super(
      `Batch ${batchId} stalled: ${stuckJobs.length} job(s) made no progress for ${Math.round(stalledMs / 1000)} s ` +
        (reason === 'panics' ? `after ${panics} asset server panic(s)` : 'while still downloading')
    )
    this.name = 'BatchStalledError'
    this.stuckJobs = stuckJobs
    this.pendingJobs = pendingJobs
    this.reason = reason
  }
}

export type WaitOptions = {
  stallPanicMs?: number
  stallDownloadMs?: number
  stallDownloadJobMs?: number
  maxStalledJobs?: number
}

/** A 5xx/429 from the asset server (after the fetch adapter's retries) is transient. */
function httpError(message: string, status: number): Error {
  return isTransientHttpStatus(status) ? new TransientError(message) : new Error(message)
}

/**
 * The godot asset-server command line, as `spawn` wants it: the binary and
 * its arguments, no shell. Never launch it through `exec`: `exec` buffers the
 * child's stdout/stderr (1 MiB by default) and SIGTERMs the child when the
 * buffer overflows — a big bake logs more than that and was getting killed
 * mid-batch, which surfaced as `connect ECONNREFUSED 127.0.0.1:8080`.
 */
export function godotServerCommand(port: string = DEFAULT_ASSET_SERVER_PORT): { file: string; args: string[] } {
  return { file: GODOT_BINARY, args: ['--headless', '--asset-server', '--asset-server-port', port] }
}

export type AssetType = 'scene' | 'wearable' | 'emote' | 'texture'

export interface IAssetServerComponent {
  isReady(): Promise<boolean>
  processScene(params: ProcessSceneParams): Promise<ProcessSceneResponse>
  processAssets(params: ProcessAssetsParams): Promise<ProcessAssetsResponse>
  getBatchStatus(batchId: string): Promise<BatchStatus>
  /** Resolves when the batch is completed/failed; throws TransientError on timeout, BatchStalledError on a stall. */
  waitForCompletion(batchId: string, timeoutMs?: number, options?: WaitOptions): Promise<BatchStatus>
  restartGodot(): Promise<boolean>
  getGodotLogs(): string[]
  clearGodotLogs(): void
  /** `panicked at` lines seen in godot's output since the last (re)start. */
  getPanicCount(): number
}

export type ProcessSceneParams = {
  sceneHash: string
  contentBaseUrl: string
  outputHash?: string
}

export type ProcessSceneResponse = {
  batch_id: string
  output_hash: string
  scene_hash: string
  total_assets: number
  jobs: Array<{ job_id: string; hash: string; status: string }>
}

export type AssetRequest = {
  url: string
  type: AssetType
  hash: string
  base_url: string
  content_mapping?: Record<string, string>
}

export type ProcessAssetsParams = {
  outputHash?: string
  assets: AssetRequest[]
}

export type ProcessAssetsResponse = {
  batch_id: string
  output_hash: string
  jobs: Array<{
    job_id: string
    hash: string
    status: string
  }>
  total: number
}

export type BatchStatus = {
  batch_id: string
  output_hash: string
  status: 'processing' | 'packing' | 'completed' | 'failed'
  progress: number
  zip_path?: string
  error?: string
  jobs: JobStatus[]
  individual_zips?: Array<{ hash: string; zip_path: string }>
}

export type JobStatus = {
  job_id: string
  hash: string
  asset_type: AssetType
  status: 'queued' | 'downloading' | 'processing' | 'completed' | 'failed'
  progress: number
  elapsed_secs: number
  error?: string
}

export type AssetServerConfig = {
  baseUrl: string
  /** Test hooks: shorten the waits around a godot (re)start. */
  timings?: {
    restartSettleMs?: number
    readyPollMs?: number
    readyPollAttempts?: number
    batchPollMs?: number
  }
}

export function createAssetServerComponent(
  components: { logs: ILoggerComponent; fetch: IFetchComponent },
  config: AssetServerConfig
): IAssetServerComponent {
  const { logs, fetch } = components
  const { baseUrl } = config
  const restartSettleMs = config.timings?.restartSettleMs ?? DEFAULT_RESTART_SETTLE_MS
  const readyPollMs = config.timings?.readyPollMs ?? DEFAULT_READY_POLL_MS
  const readyPollAttempts = config.timings?.readyPollAttempts ?? DEFAULT_READY_POLL_ATTEMPTS
  const batchPollMs = config.timings?.batchPollMs ?? DEFAULT_BATCH_POLL_MS
  const logger = logs.getLogger('asset-server')

  // Buffer to store Godot process output
  let godotLogs: string[] = []
  let panics = 0
  const MAX_LOG_LINES = 5000 // Limit to prevent memory issues

  function addGodotLog(line: string) {
    if (line.trim()) {
      if (line.includes(PANIC_MARKER)) panics++
      godotLogs.push(line.trim())
      // Keep only the last MAX_LOG_LINES
      if (godotLogs.length > MAX_LOG_LINES) {
        godotLogs = godotLogs.slice(-MAX_LOG_LINES)
      }
    }
  }

  function getGodotLogs(): string[] {
    return [...godotLogs]
  }

  function clearGodotLogs(): void {
    godotLogs = []
    panics = 0
  }

  function getPanicCount(): number {
    return panics
  }

  function isTerminal(job: JobStatus): boolean {
    return job.status === 'completed' || job.status === 'failed'
  }

  async function isReady(): Promise<boolean> {
    try {
      const response = await fetch.fetch(`${baseUrl}/health`)
      // Consume response body to free the connection
      await response.text().catch(() => {})
      return response.ok
    } catch {
      return false
    }
  }

  async function processScene(params: ProcessSceneParams): Promise<ProcessSceneResponse> {
    const body: Record<string, unknown> = {
      scene_hash: params.sceneHash,
      content_base_url: params.contentBaseUrl
    }
    if (params.outputHash) body.output_hash = params.outputHash

    logger.info('Submitting scene for processing', { sceneHash: params.sceneHash, baseUrl })

    const response = await fetch.fetch(`${baseUrl}/process-scene`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw httpError(`Failed to submit scene for processing: ${response.status} ${errorText}`, response.status)
    }

    return (await response.json()) as ProcessSceneResponse
  }

  async function processAssets(params: ProcessAssetsParams): Promise<ProcessAssetsResponse> {
    const body = {
      output_hash: params.outputHash,
      assets: params.assets
    }

    logger.info('Submitting assets for processing', {
      outputHash: params.outputHash || 'auto',
      assetCount: params.assets.length,
      baseUrl
    })

    const response = await fetch.fetch(`${baseUrl}/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw httpError(`Failed to submit assets for processing: ${response.status} ${errorText}`, response.status)
    }

    return (await response.json()) as ProcessAssetsResponse
  }

  async function getBatchStatus(batchId: string): Promise<BatchStatus> {
    const response = await fetch.fetch(`${baseUrl}/status/${batchId}`)

    if (!response.ok) {
      const errorText = await response.text()
      throw httpError(`Failed to get batch status: ${response.status} ${errorText}`, response.status)
    }

    return (await response.json()) as BatchStatus
  }

  async function waitForCompletion(
    batchId: string,
    timeoutMs: number = DEFAULT_ASSET_SERVER_TIMEOUT_MS,
    options: WaitOptions = {}
  ): Promise<BatchStatus> {
    const startTime = Date.now()
    const pollIntervalMs = batchPollMs
    const stallPanicMs = options.stallPanicMs ?? DEFAULT_STALL_PANIC_MS
    const stallDownloadMs = options.stallDownloadMs ?? DEFAULT_STALL_DOWNLOAD_MS
    const stallDownloadJobMs = options.stallDownloadJobMs ?? DEFAULT_STALL_DOWNLOAD_JOB_MS
    const maxStalledJobs = options.maxStalledJobs ?? DEFAULT_MAX_STALLED_JOBS
    let lastTerminal = -1
    let lastProgressAt = Date.now()
    // Per job: when it was first seen downloading (our clock — the server's
    // elapsed_secs counts from the batch start) and how many jobs were
    // terminal at that moment.
    const downloadingSince = new Map<string, { since: number; terminal: number }>()

    const stall = (
      stuck: JobStatus[],
      reason: 'panics' | 'downloads',
      panicCount: number,
      stalledMs: number,
      pending: JobStatus[]
    ) => {
      if (stuck.length > maxStalledJobs) {
        throw new TransientError(
          `Batch ${batchId}: ${stuck.length} job(s) stalled (${reason}), more than ${maxStalledJobs} — treating as a network problem`
        )
      }
      throw new BatchStalledError(batchId, stuck, reason, panicCount, stalledMs, pending)
    }

    while (Date.now() - startTime < timeoutMs) {
      const status = await getBatchStatus(batchId)

      logger.debug('Batch status', {
        batchId,
        status: status.status,
        progress: status.progress
      })

      if (status.status === 'completed' || status.status === 'failed') {
        return status
      }

      const jobs = status.jobs || []
      const terminal = jobs.filter(isTerminal).length
      if (terminal !== lastTerminal) {
        lastTerminal = terminal
        lastProgressAt = Date.now()
      }
      const pending = jobs.filter((job) => !isTerminal(job))
      const stalledMs = Date.now() - lastProgressAt
      const now = Date.now()
      for (const job of jobs) {
        if (job.status === 'downloading') {
          if (!downloadingSince.has(job.hash)) downloadingSince.set(job.hash, { since: now, terminal })
        } else {
          downloadingSince.delete(job.hash)
        }
      }
      if (pending.length > 0 && status.status !== 'packing') {
        const panicCount = getPanicCount()
        if (stalledMs >= stallPanicMs && panicCount >= pending.length) {
          stall(pending, 'panics', panicCount, stalledMs, pending)
        }
        const stuckDownloads = pending.filter((job) => {
          const seen = downloadingSince.get(job.hash)
          return !!seen && now - seen.since >= stallDownloadJobMs && terminal > seen.terminal
        })
        if (stuckDownloads.length > 0) {
          // the other downloads in flight for more than a minute hold dead slots too
          const siblingMs = Math.min(STALL_DOWNLOAD_SIBLING_MS, stallDownloadJobMs)
          const stuck = pending.filter((job) => {
            const seen = downloadingSince.get(job.hash)
            return !!seen && now - seen.since >= siblingMs
          })
          const oldest = Math.min(...stuck.map((j) => downloadingSince.get(j.hash)!.since))
          stall(stuck, 'downloads', panicCount, now - oldest, pending)
        }
        if (stalledMs >= stallDownloadMs && pending.every((job) => job.status === 'downloading')) {
          stall(pending, 'downloads', panicCount, stalledMs, pending)
        }
      }

      // Use a cancellable sleep pattern
      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(() => resolve(), pollIntervalMs)
        // Ensure timeout is unreferenced so it doesn't keep the process alive
        if (timeoutId.unref) {
          timeoutId.unref()
        }
      })
    }

    // Transient: the bake outran the budget (heavy scene on a loaded host) and
    // godot is restarted right after; the queue retries the job.
    throw new TransientError(`Timeout waiting for batch ${batchId} to complete after ${timeoutMs}ms`)
  }

  async function restartGodot(): Promise<boolean> {
    const port = process.env.ASSET_SERVER_PORT || DEFAULT_ASSET_SERVER_PORT
    logger.info('Restarting Godot asset-server...')

    try {
      // Kill existing Godot process - use simpler pattern
      try {
        await execAsync('pkill -9 -f "decentraland.godot.client" || true')
        logger.info('Sent kill signal to Godot process')
      } catch {
        // Ignore errors - process might not exist
      }

      // Wait for process to fully terminate
      await new Promise((resolve) => setTimeout(resolve, restartSettleMs))

      // Clear logs from previous run
      clearGodotLogs()
      addGodotLog(`[${new Date().toISOString()}] Starting Godot asset-server...`)

      // Start new Godot process in background — through `spawn`, see
      // godotServerCommand() for why `exec` must not be used here.
      // `--headless` is fine: the asset-preprocessor module that needed
      // the SubViewport / opengl3 rasterizer (octahedral impostors,
      // BoxOccluder auto-spawn) was removed (godot-explorer 16da5eec /
      // 70047448). The remaining bake pipeline (texture compress, LOD
      // chain, splitter, material flips) runs on CPU; the dummy renderer
      // saves ~3x wall time vs the Mesa llvmpipe + Xvfb path and avoided
      // tripping the orchestrator's ASSET_SERVER_TIMEOUT_MS on GP-scale
      // bakes.
      const { file, args } = godotServerCommand(port)
      const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })

      // Without a listener a spawn failure (missing binary) is an uncaught
      // exception; log it and let the readiness poll below report the failure.
      child.on('error', (error) => {
        logger.error('Failed to spawn Godot', { error: error.message })
        addGodotLog(`[${new Date().toISOString()}] ERROR: failed to spawn Godot: ${error.message}`)
      })

      // Capture stdout
      if (child.stdout) {
        child.stdout.on('data', (data: Buffer | string) => {
          const lines = data.toString().split('\n')
          for (const line of lines) {
            addGodotLog(line)
          }
        })
      }

      // Capture stderr
      if (child.stderr) {
        child.stderr.on('data', (data: Buffer | string) => {
          const lines = data.toString().split('\n')
          for (const line of lines) {
            addGodotLog(`[stderr] ${line}`)
          }
        })
      }

      // Log when process exits
      child.on('exit', (code, signal) => {
        addGodotLog(`[${new Date().toISOString()}] Godot process exited with code ${code}, signal ${signal}`)
      })

      // Detach from child process - we don't need to track it
      child.unref()

      // Wait for server to be ready (up to readyPollAttempts * readyPollMs, 60 s by default)
      for (let i = 0; i < readyPollAttempts; i++) {
        await new Promise((resolve) => setTimeout(resolve, readyPollMs))
        if (await isReady()) {
          logger.info('Godot asset-server is ready after restart')
          addGodotLog(`[${new Date().toISOString()}] Godot asset-server is ready`)
          return true
        }
      }

      logger.error('Godot asset-server failed to become ready after restart')
      addGodotLog(`[${new Date().toISOString()}] ERROR: Godot asset-server failed to become ready`)
      return false
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error('Failed to restart Godot', { error: errorMsg })
      addGodotLog(`[${new Date().toISOString()}] ERROR: Failed to restart Godot: ${errorMsg}`)
      return false
    }
  }

  return {
    isReady,
    processScene,
    processAssets,
    getBatchStatus,
    waitForCompletion,
    restartGodot,
    getGodotLogs,
    clearGodotLogs,
    getPanicCount
  }
}
