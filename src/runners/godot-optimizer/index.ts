import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import fs from 'fs/promises'
import path from 'path'
import { TaskQueueMessage } from '../../adapters/task-queue'
import { AppComponents } from '../../types'
import {
  AssetType,
  BatchStalledError,
  BatchStatus,
  DEFAULT_ASSET_SERVER_TIMEOUT_MS,
  JobStatus,
  ProcessSceneResponse
} from '../../adapters/asset-server'
import { clearGodotCache, preloadEntityContent } from './content-preloader'
import { contentTypeFor, objectKeyFor, orderForUpload } from './publish'
import { EntityDefinition, mobileZipKey, publishBootBundle } from './boot-bundle'
import { expandStalledFamily } from './stall-family'
import {
  ContentError,
  TransientError,
  isContentError,
  isTransientAssetError,
  isTransientError,
  contentDownloadError
} from '../../logic/transient-error'
import { resolveContentServerUrl } from '../../logic/content-server'

// Extended type that includes entityType and profile data from the producer
type DeploymentWithType = DeploymentToSqs & {
  entity: {
    entityType?: string
  }
  _profileData?: {
    originalEntityId: string
    gltfFile: string
    contentMapping: Record<string, string>
    contentBaseUrl: string
  }
}

type EntityType = 'scene' | 'wearable' | 'emote'

export type ProcessReport = {
  entityId: string
  entityType: EntityType
  contentServerUrl: string
  startedAt: Date
  finishedAt: Date | null
  errors: string[]
  godotLogs: string[]
  godotProcessLogs: string[]
  individualAssets: {
    total: number
    successful: number
    failed: number
    // Jobs the asset server marked `failed` and left out of the batch output
    // (e.g. a scene GLB whose external textures did not bake). Not counted in
    // `failed`, which only tracks upload failures and drives `result.success`.
    droppedByServer: number
  }
  serverFailedJobs?: Array<{ hash: string; assetType: string; error: string }>
  // True when the bake is incomplete (droppedByServer > 0, or a completed job
  // produced no individual zip). The entity still counts as `success` so a
  // permanent content defect is not re-baked on every backfill.
  partial?: boolean
  // True when the asset server had nothing to bake (no GLB/glTF) and only the
  // boot bundle (manifest + scene code) was published — see boot-bundle.ts.
  bootOnly?: boolean
  // True when the failure was not positively caused by the content (DNS,
  // unreachable host, asset server crash, upload that never landed, a storage
  // or code fault): the job is released back to the queue and retried instead
  // of recorded as a final failure — and a bake with network-dropped assets is
  // never published.
  transient?: boolean
  result: {
    success: boolean
    batchId?: string
    optimizedAssets?: number
    metadataZipPath?: string
    individualZips?: string[]
  } | null
}

/**
 * Cross-check the per-job statuses of a finished scene batch against the
 * individual zips the server handed back. A scene batch completes even when
 * some jobs failed (the server drops a GLB whose external textures failed to
 * bake, so a `.scn` never ships with dangling ExtResources), so this is the
 * only signal that the bake is partial.
 */
export function summarizeServerJobs(
  jobs: JobStatus[],
  individualZips: Array<{ hash: string }>
): {
  failed: Array<{ hash: string; assetType: string; error: string }>
  completedNotPacked: string[]
} {
  const failed = jobs
    .filter((job) => job.status === 'failed')
    .map((job) => ({ hash: job.hash, assetType: job.asset_type, error: job.error || 'unknown error' }))
  const packed = new Set(individualZips.map((zip) => zip.hash))
  const completedNotPacked = jobs
    .filter((job) => job.status === 'completed' && !packed.has(job.hash))
    .map((job) => job.hash)
  return { failed, completedNotPacked }
}

export type ServerFailedJob = { hash: string; assetType: string; error: string }

/**
 * How many times a stalled scene batch is re-run with the stuck assets hidden
 * (see adapters/content-proxy.ts). Each pass excludes everything that stalled
 * before, so the loop always converges; a family of files the server cannot
 * digest (one scene had 40 node-heavy GLBs that jam its four download slots
 * four at a time) needs several passes. Cached downloads make a pass cheap.
 * Override with ASSET_SERVER_MAX_STALL_RETRIES.
 */
export const MAX_STALL_RETRIES = 10
export const STALL_DROP_REASON = 'asset server stalled on this file (worker panic); excluded from the bake'
export const STALL_FAMILY_DROP_REASON = 'sibling of files the asset server stalled on; excluded from the bake'

type SceneComponents = Pick<AppComponents, 'logs' | 'config' | 'storage' | 'assetServer' | 'fetch' | 'contentProxy'>

/**
 * Split server-dropped jobs into the ones a retry can fix (the download hit a
 * DNS/connect/timeout error) and the ones it cannot (broken content).
 */
export function partitionServerFailures(failed: ServerFailedJob[]): {
  transient: ServerFailedJob[]
  permanent: ServerFailedJob[]
} {
  const transient = failed.filter((job) => isTransientAssetError(job.error))
  const permanent = failed.filter((job) => !isTransientAssetError(job.error))
  return { transient, permanent }
}

function parseMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function describeJobs(jobs: ServerFailedJob[], limit: number = 5): string {
  const shown = jobs.slice(0, limit).map((job) => `${job.hash}: ${job.error}`)
  const rest = jobs.length > limit ? `; +${jobs.length - limit} more` : ''
  return shown.join('; ') + rest
}

/** Best-effort removal of the zips a batch produced when they will not be uploaded. */
async function discardBatchOutput(batch: Pick<BatchStatus, 'zip_path' | 'individual_zips'>): Promise<void> {
  const paths = [batch.zip_path, ...(batch.individual_zips || []).map((zip) => zip.zip_path)].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  )
  await Promise.all(paths.map((p) => fs.rm(p, { force: true }).catch(() => {})))
}

/** Failed batch jobs whose error is network-shaped: the batch must be retried, not recorded. */
function transientBatchJobs(jobs: JobStatus[] | undefined): ServerFailedJob[] {
  return (jobs || [])
    .filter((job) => job.status === 'failed' && isTransientAssetError(job.error))
    .map((job) => ({ hash: job.hash, assetType: job.asset_type, error: job.error || 'unknown error' }))
}

/**
 * Bakes one entity. Resolves with the bake report, or with `null` when the job
 * was skipped without touching Godot (the scene is already published). Throws
 * a `ContentError` when the content cannot be baked and a `TransientError`
 * (or any other error) when a retry may help.
 *
 * Godot is not restarted here once the bake is over: the consume loop
 * (service.ts) restarts it before claiming the next job, so the message is
 * settled as soon as the uploads land.
 */
export async function godotOptimizer(
  entity: DeploymentToSqs,
  _msg: TaskQueueMessage,
  components: SceneComponents
): Promise<ProcessReport | null> {
  const { logs, assetServer, storage } = components
  const logger = logs.getLogger('godot-optimizer')

  // Cast to extended type to access entityType
  const entityWithType = entity as DeploymentWithType
  const entityType = (entityWithType.entity.entityType as EntityType) || 'scene'

  logger.info('Processing entity', {
    entityId: entity.entity.entityId,
    entityType
  })

  // Entity ids are content hashes, so a published scene never changes: an SNS
  // redelivery, a backfill rerun or a duplicate event skips it. The legacy
  // metadata zip is uploaded last (also by a boot-only bake), so its presence
  // marks a fully published scene. `force: true` in the job re-bakes anyway.
  // Wearables and emotes are keyed by their glTF hash and bake in seconds: they
  // are always baked.
  if (entityType !== 'wearable' && entityType !== 'emote' && !entity.force) {
    const marker = mobileZipKey(entity.entity.entityId)
    if (await storage.exists(marker)) {
      logger.info('Scene is already published, skipping (queue it with force to re-bake)', {
        entityId: entity.entity.entityId,
        marker
      })
      return null
    }
  }

  const tempDir = path.join(process.cwd(), 'temp')
  let report: ProcessReport | null = null

  // Ensure Godot is running (first call after container start, or after a crash)
  if (!(await assetServer.isReady())) {
    logger.info('Godot asset-server not running, starting it...')
    const started = await assetServer.restartGodot()
    if (!started) {
      throw new TransientError('Failed to start Godot asset-server')
    }
  }

  try {
    switch (entityType) {
      case 'scene':
        report = await processScene(entity, components)
        break
      case 'wearable':
      case 'emote':
        report = await processWearableOrEmote(entity, entityType, components)
        break
      default:
        logger.warn('Unknown entity type, defaulting to scene processing', { entityType })
        report = await processScene(entity, components)
    }
  } finally {
    // Get Godot process stdout/stderr before restart (they will be cleared on restart)
    const godotProcessLogs = assetServer.getGodotLogs()
    if (godotProcessLogs.length > 0) {
      logger.info('Captured Godot process logs', { lineCount: godotProcessLogs.length })
    }

    // Add Godot process logs to separate field in report
    if (report) {
      report.godotProcessLogs = godotProcessLogs
      await storeReport(report, tempDir, storage, logger)
    }

    // Clear Godot content cache to free disk space. Godot itself is restarted
    // by the consume loop before the next claim, after the job is settled.
    await clearGodotCache(logger).catch((err) => {
      logger.warn('Failed to clear Godot cache', {
        error: err instanceof Error ? err.message : String(err)
      })
    })
  }

  // Throw error if processing failed so service.ts reports correct status
  // But first, save the report reference so it can be returned
  const finalReport = report
  if (finalReport && finalReport.result && !finalReport.result.success) {
    const errorMsg = finalReport.errors.length > 0 ? finalReport.errors.join('; ') : 'Processing failed'
    // Store report in a way that service.ts can access it even on error
    // We'll throw but also return the report via a custom error. Only a
    // failure the bake positively blamed on the content is a ContentError
    // (acknowledged); anything else goes back to the queue for a retry.
    const error = (finalReport.transient ? new TransientError(errorMsg) : new ContentError(errorMsg)) as Error & {
      report?: ProcessReport
    }
    error.report = finalReport
    throw error
  }

  return finalReport
}

/**
 * Process a scene entity - creates individual ZIPs for each asset
 */
async function processScene(entity: DeploymentToSqs, components: SceneComponents): Promise<ProcessReport> {
  const { logs, storage, assetServer, config, contentProxy } = components
  const logger = logs.getLogger('godot-optimizer:scene')

  const entityId = entity.entity.entityId
  const contentServerUrl = await resolveContentServerUrl(entity, config)

  const contentBaseUrl = `${contentServerUrl}/contents/`

  const report: ProcessReport = {
    entityId,
    entityType: 'scene',
    contentServerUrl,
    startedAt: new Date(),
    finishedAt: null,
    errors: [],
    godotLogs: [],
    godotProcessLogs: [],
    individualAssets: { total: 0, successful: 0, failed: 0, droppedByServer: 0 },
    result: null
  }

  const tempDir = path.join(process.cwd(), 'temp')
  try {
    await fs.mkdir(tempDir, { recursive: true })
  } catch {
    // Ignore if already exists
  }

  try {
    const timeoutMs = parseInt(
      (await config.getString('ASSET_SERVER_TIMEOUT_MS')) || String(DEFAULT_ASSET_SERVER_TIMEOUT_MS),
      10
    )

    // Single call to process the entire scene. A batch that stalls (a job's
    // worker panicked inside the asset server) is re-run with the stuck files
    // hidden behind the local content proxy; they end up as dropped assets.
    logger.info('Processing scene', { entityId, contentBaseUrl })

    const stalled: ServerFailedJob[] = []
    const maxStallRetries = parseMs(await config.getString('ASSET_SERVER_MAX_STALL_RETRIES')) ?? MAX_STALL_RETRIES
    // One budget for the whole entity: every retry pass gets what is left of it.
    const budgetStartedAt = Date.now()
    let sceneResponse: ProcessSceneResponse | null = null
    let batchResult: BatchStatus | null = null
    try {
      for (let pass = 1; pass <= 1 + maxStallRetries; pass++) {
        const remainingMs = timeoutMs - (Date.now() - budgetStartedAt)
        if (remainingMs <= 0) {
          throw new TransientError(`Bake budget of ${timeoutMs}ms exhausted after ${pass - 1} pass(es)`)
        }
        const baseUrl =
          stalled.length > 0
            ? contentProxy.register(
                entityId,
                contentServerUrl,
                stalled.map((job) => job.hash)
              )
            : contentBaseUrl
        try {
          sceneResponse = await assetServer.processScene({ sceneHash: entityId, contentBaseUrl: baseUrl })
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          if (errorMsg.includes('No processable assets') || errorMsg.includes('400')) {
            logger.info('Scene has no processable assets, publishing the boot bundle only', { entityId })
            return await finishWithBootBundle(report, contentServerUrl, tempDir, components, logger)
          }
          throw error
        }

        logger.info('Scene processing submitted', {
          entityId,
          pass,
          batchId: sceneResponse.batch_id,
          totalAssets: sceneResponse.total_assets,
          excluded: stalled.length
        })

        try {
          batchResult = await assetServer.waitForCompletion(sceneResponse.batch_id, remainingMs, {
            stallPanicMs: parseMs(await config.getString('ASSET_SERVER_STALL_PANIC_MS')),
            stallDownloadMs: parseMs(await config.getString('ASSET_SERVER_STALL_DOWNLOAD_MS')),
            stallDownloadJobMs: parseMs(await config.getString('ASSET_SERVER_STALL_DOWNLOAD_JOB_MS')),
            maxStalledJobs: parseMs(await config.getString('ASSET_SERVER_MAX_STALLED_JOBS'))
          })
          break
        } catch (error) {
          if (!(error instanceof BatchStalledError)) throw error
          const stuck = error.stuckJobs.map((job) => ({
            hash: job.hash,
            assetType: job.asset_type,
            error: STALL_DROP_REASON
          }))
          // Their siblings (same name stem) are going to stall next pass — hide
          // them now. The stem is taken over everything that stalled so far, so
          // a second family (`building_lane_*` after `building_ring_*`) widens
          // it to the common prefix (`building_`) instead of costing a pass each.
          const typeOf = new Map(error.pendingJobs.map((job) => [job.hash, job.asset_type]))
          const entityForNames = await fetchEntityDefinition(entityId, contentServerUrl, components.fetch).catch(
            () => null
          )
          const family = entityForNames
            ? expandStalledFamily(
                [...stalled, ...stuck].map((job) => job.hash),
                error.pendingJobs.map((job) => job.hash),
                entityForNames.content || []
              ).map((hash) => ({ hash, assetType: typeOf.get(hash) || 'scene', error: STALL_FAMILY_DROP_REASON }))
            : []
          logger.warn('Batch stalled, restarting godot and retrying without the stuck files', {
            entityId,
            pass,
            reason: error.reason,
            stuck: stuck.map((job) => job.hash).join(','),
            family: family.length
          })
          report.godotLogs.push(
            `[pass ${pass}] ${error.message}; excluding ${stuck.length} stuck + ${family.length} sibling file(s)`
          )
          stalled.push(...stuck, ...family)
          await assetServer.restartGodot()
          if (pass === 1 + maxStallRetries) {
            throw new ContentError(
              `Asset server stalled on ${stalled.length} file(s) after ${pass} passes: ${describeJobs(stalled)}`
            )
          }
        }
      }
    } finally {
      contentProxy.unregister(entityId)
    }
    if (!sceneResponse || !batchResult) throw new Error('Scene processing produced no batch result')

    // Collect job logs
    for (const job of batchResult.jobs || []) {
      if (job.error) {
        report.godotLogs.push(`[${job.hash}] ${job.status}: ${job.error}`)
      } else {
        report.godotLogs.push(`[${job.hash}] ${job.status} (${job.elapsed_secs}s)`)
      }
    }

    if (batchResult.status === 'failed') {
      const errorMsg = batchResult.error || ''
      // "Nothing completed" is only a legitimate empty scene when the jobs
      // failed on content; when they failed on the network, retry the job
      // instead of recording a success with zero assets.
      const networkFailures = transientBatchJobs(batchResult.jobs)
      if (networkFailures.length > 0) {
        throw new TransientError(
          `Batch failed on transient network errors (${networkFailures.length} asset(s)): ${describeJobs(networkFailures)}`
        )
      }
      if (errorMsg.includes('No assets completed successfully') || errorMsg.includes('No processable assets')) {
        logger.info('Scene has no processable assets (from batch result), publishing the boot bundle only', {
          entityId
        })
        return await finishWithBootBundle(report, contentServerUrl, tempDir, components, logger)
      }
      throw new ContentError(batchResult.error || 'Scene processing failed')
    }

    if (!batchResult.zip_path) {
      throw new Error('No main ZIP file created')
    }

    const individualZipEntries = batchResult.individual_zips || []

    // Surface a partial bake without failing the entity: the batch completes
    // even when the server dropped jobs, and flipping the scene to `failed`
    // would make a permanent content defect (a GLB referencing a texture that
    // is not in the deployment) re-bake on every backfill.
    const summary = summarizeServerJobs(batchResult.jobs || [], individualZipEntries)
    // Files hidden from a retry pass are dropped assets like any other
    // permanent server failure: reported, not retried.
    const serverFailedJobs = [...summary.failed, ...stalled]
    const completedNotPacked = summary.completedNotPacked
    report.serverFailedJobs = serverFailedJobs
    report.individualAssets.droppedByServer = serverFailedJobs.length
    report.partial = serverFailedJobs.length > 0 || completedNotPacked.length > 0
    for (const job of serverFailedJobs) {
      report.errors.push(`Server dropped ${job.assetType} ${job.hash}: ${job.error}`)
    }
    for (const hash of completedNotPacked) {
      report.errors.push(`Server completed ${hash} but produced no individual zip`)
    }
    if (report.partial) {
      logger.warn('Partial scene bake', {
        entityId,
        droppedByServer: serverFailedJobs.length,
        completedNotPacked: completedNotPacked.length
      })
    }

    // Assets dropped because the download failed on the network are not a
    // content defect: publishing this bake would leave the scene permanently
    // incomplete under a `success` result. Fail before uploading anything so
    // the queue retries the whole entity once the network is back.
    const { transient: networkDrops } = partitionServerFailures(serverFailedJobs)
    if (networkDrops.length > 0) {
      await discardBatchOutput(batchResult)
      throw new TransientError(
        `Server dropped ${networkDrops.length} asset(s) on transient network errors; not publishing a partial bake: ${describeJobs(networkDrops)}`
      )
    }

    // Upload every file the server published, under its own name, in the
    // server's order with the manifest and the boot zip last: a client
    // fetching mid-upload must never see a manifest whose dependencies are
    // not there yet. The legacy metadata ZIP (`-mobile.zip`) goes after them,
    // so its presence marks a scene whose bake is fully published.
    const mainS3Key = objectKeyFor(batchResult.zip_path)
    const individualZips: string[] = [mainS3Key]
    const uploads = orderForUpload(individualZipEntries, entityId)
    report.individualAssets.total = uploads.length

    for (const entry of uploads) {
      const s3Key = objectKeyFor(entry.zip_path)
      try {
        await storage.storeFileStrict(s3Key, entry.zip_path, contentTypeFor(s3Key))
        await fs.rm(entry.zip_path, { force: true }).catch(() => {})
        individualZips.push(s3Key)
        report.individualAssets.successful++
        report.godotLogs.push(`[${s3Key}] uploaded successfully`)
      } catch (uploadError) {
        report.individualAssets.failed++
        const errorMsg = uploadError instanceof Error ? uploadError.message : String(uploadError)
        report.errors.push(`Failed to upload ${s3Key}: ${errorMsg}`)
        report.godotLogs.push(`[${s3Key}] upload failed: ${errorMsg}`)
        if (isTransientError(uploadError)) {
          // The uplink is down: every further upload would burn its full
          // backoff for nothing and this bake is never published anyway.
          report.transient = true
          logger.warn('Transient upload failure, abandoning the remaining uploads', { entityId, s3Key })
          await discardBatchOutput(batchResult)
          throw uploadError
        }
      }
    }

    // Upload the legacy metadata ZIP last — see above.
    await storage.storeFileStrict(mainS3Key, batchResult.zip_path, contentTypeFor(mainS3Key))
    await fs.rm(batchResult.zip_path, { force: true }).catch(() => {})
    logger.info('Uploaded main ZIP', { entityId, s3Key: mainS3Key })

    logger.info('All files uploaded', {
      entityId,
      total: report.individualAssets.total,
      successful: report.individualAssets.successful,
      failed: report.individualAssets.failed,
      droppedByServer: report.individualAssets.droppedByServer
    })

    report.result = {
      success: report.individualAssets.failed === 0,
      batchId: sceneResponse.batch_id,
      optimizedAssets: report.individualAssets.successful,
      metadataZipPath: mainS3Key,
      individualZips
    }

    report.finishedAt = new Date()
    return report
  } catch (error) {
    logger.error(`Error processing scene ${entityId}`)
    logger.error(error as any)
    report.errors.push(error instanceof Error ? error.message : String(error))
    // Unclassified errors (a storage or code fault) are retried, never dropped
    report.transient = report.transient || !isContentError(error)
    report.finishedAt = new Date()
    report.result = { success: false }
    return report
  }
}

/**
 * Nothing to bake (code-only scene, or every mesh was rejected on content):
 * publish the boot bundle so the client still boots the scene from the CDN.
 * Counts like a full bake whose uploads are the code files, manifest and boot
 * zip; `bootOnly` tells the two apart in the report.
 */
async function finishWithBootBundle(
  report: ProcessReport,
  contentServerUrl: string,
  tempDir: string,
  components: Pick<AppComponents, 'storage' | 'fetch'>,
  logger: ReturnType<AppComponents['logs']['getLogger']>
): Promise<ProcessReport> {
  const entity = await fetchEntityDefinition(report.entityId, contentServerUrl, components.fetch)
  const published = await publishBootBundle({
    entityId: report.entityId,
    contentServerUrl,
    entity,
    workDir: tempDir,
    components
  })
  report.finishedAt = new Date()
  if (!published) {
    logger.warn('Scene has no entry script either, nothing to publish', { entityId: report.entityId })
    report.result = { success: true, optimizedAssets: 0, individualZips: [] }
    return report
  }
  const uploaded = published.individualZips.length - 1 // the metadata zip is not counted, as in a full bake
  report.bootOnly = true
  report.individualAssets.total = uploaded
  report.individualAssets.successful = uploaded
  for (const key of published.individualZips) report.godotLogs.push(`[${key}] uploaded successfully`)
  logger.info('Boot bundle published', { entityId: report.entityId, files: published.individualZips.join(',') })
  report.result = {
    success: true,
    optimizedAssets: uploaded,
    metadataZipPath: published.metadataZipPath,
    individualZips: published.individualZips
  }
  return report
}

/**
 * Process a wearable or emote entity - creates a single ZIP per GLTF
 */
async function processWearableOrEmote(
  entity: DeploymentToSqs,
  entityType: 'wearable' | 'emote',
  components: SceneComponents
): Promise<ProcessReport> {
  const { logs, storage, assetServer, config, fetch } = components
  const logger = logs.getLogger(`godot-optimizer:${entityType}`)

  const entityWithType = entity as DeploymentWithType
  const profileData = entityWithType._profileData

  // entityId is either the GLTF hash (from profile) or the entity hash
  const entityId = entity.entity.entityId
  const contentServerUrl = await resolveContentServerUrl(entity, config)

  const contentBaseUrl = profileData?.contentBaseUrl || `${contentServerUrl}/contents/`

  const report: ProcessReport = {
    entityId,
    entityType,
    contentServerUrl,
    startedAt: new Date(),
    finishedAt: null,
    errors: [],
    godotLogs: [],
    godotProcessLogs: [],
    individualAssets: { total: 1, successful: 0, failed: 0, droppedByServer: 0 },
    result: null
  }

  const tempDir = path.join(process.cwd(), 'temp')
  try {
    await fs.mkdir(tempDir, { recursive: true })
  } catch {
    // Ignore if already exists
  }

  try {
    const timeoutMs = parseInt(
      (await config.getString('ASSET_SERVER_TIMEOUT_MS')) || String(DEFAULT_ASSET_SERVER_TIMEOUT_MS),
      10
    )

    let gltfHash: string
    let contentMapping: Record<string, string>

    if (profileData) {
      // Profile mode: entityId is already the GLTF hash, content mapping is provided
      gltfHash = entityId
      contentMapping = profileData.contentMapping
      logger.info('Using profile data', {
        gltfHash,
        gltfFile: profileData.gltfFile,
        originalEntityId: profileData.originalEntityId
      })
    } else {
      // Standard mode: fetch entity definition and find GLTFs
      logger.info('Fetching entity definition', { entityId, entityType })
      const entityDefinition = await fetchEntityDefinition(entityId, contentServerUrl, fetch)

      const gltfFiles = entityDefinition.content.filter(
        (c: { file: string }) => c.file.toLowerCase().endsWith('.glb') || c.file.toLowerCase().endsWith('.gltf')
      )

      if (gltfFiles.length === 0) {
        // No GLTF/GLB files - treat as success with 0 assets
        logger.info(`No GLTF/GLB files found in ${entityType}, skipping`, { entityId, entityType })
        report.finishedAt = new Date()
        report.individualAssets.total = 0
        report.result = {
          success: true,
          optimizedAssets: 0,
          individualZips: []
        }
        return report
      }

      // Use first GLTF (for standard mode, we process the whole entity)
      gltfHash = gltfFiles[0].hash
      contentMapping = {}
      for (const content of entityDefinition.content) {
        contentMapping[content.file] = content.hash
      }

      logger.info('Found assets', {
        entityId,
        entityType,
        gltfs: gltfFiles.length
      })
    }

    // Pre-download content to Godot cache
    try {
      logger.info('Pre-downloading entity content', { entityId, entityType })
      const contentList = Object.entries(contentMapping).map(([file, hash]) => ({ file, hash }))
      const preloadResult = await preloadEntityContent(entityId, contentServerUrl, components, {
        contentMapping: contentList
      })
      logger.info('Pre-download complete', {
        entityId,
        entityType,
        downloaded: preloadResult.downloaded,
        failed: preloadResult.failed
      })
    } catch (preloadError) {
      logger.warn('Content pre-download failed, continuing with processing', {
        entityId,
        error: preloadError instanceof Error ? preloadError.message : String(preloadError)
      })
    }

    // 2. Build asset request
    const assetType: AssetType = entityType === 'wearable' ? 'wearable' : 'emote'
    const assets = [
      {
        url: `${contentBaseUrl}${gltfHash}`,
        type: assetType,
        hash: gltfHash,
        base_url: contentBaseUrl,
        content_mapping: contentMapping
      }
    ]

    // 3. Submit to asset server
    logger.info('Submitting asset for processing', {
      gltfHash,
      entityType
    })

    const response = await assetServer.processAssets({
      outputHash: gltfHash,
      assets
    })

    logger.info('Processing submitted', {
      gltfHash,
      batchId: response.batch_id
    })

    // 4. Wait for completion
    const result = await assetServer.waitForCompletion(response.batch_id, timeoutMs)

    // Collect job logs
    for (const job of result.jobs || []) {
      if (job.error) {
        report.godotLogs.push(`[${job.hash}] ${job.status}: ${job.error}`)
      } else {
        report.godotLogs.push(`[${job.hash}] ${job.status} (${job.elapsed_secs}s)`)
      }
    }

    if (result.status === 'failed') {
      // Log detailed job status for debugging
      const jobErrors = result.jobs
        ?.filter((j) => j.status === 'failed')
        .map((j) => `${j.job_id}: ${j.error || 'unknown'}`)
        .join('; ')
      logger.error('Asset processing failed', {
        gltfHash,
        batchId: response.batch_id,
        error: result.error || 'unknown',
        jobErrors: jobErrors || 'none'
      })

      // Check if this is "No assets completed successfully" - treat as success with 0 assets,
      // unless the jobs failed on the network (then retry instead of recording an empty success).
      const errorMsg = result.error || ''
      const networkFailures = transientBatchJobs(result.jobs)
      if (networkFailures.length > 0) {
        throw new TransientError(
          `Batch failed on transient network errors (${networkFailures.length} asset(s)): ${describeJobs(networkFailures)}`
        )
      }
      if (errorMsg.includes('No assets completed successfully') || errorMsg.includes('No processable assets')) {
        logger.info(`${entityType} has no processable assets`, { entityId, gltfHash })
        report.finishedAt = new Date()
        report.individualAssets.total = 0
        report.result = {
          success: true,
          optimizedAssets: 0,
          individualZips: []
        }
        return report
      }

      throw new ContentError(result.error || 'Processing failed')
    }

    if (!result.zip_path) {
      throw new Error('No ZIP file created')
    }

    // 5. Upload ZIP to storage
    const s3Key = objectKeyFor(result.zip_path)
    await storage.storeFileStrict(s3Key, result.zip_path, contentTypeFor(s3Key))
    // Clean up temp file from asset-server
    await fs.rm(result.zip_path, { force: true }).catch(() => {})
    logger.info('Uploaded ZIP', { gltfHash, entityType, s3Key })

    report.individualAssets.successful = 1
    report.godotLogs.push(`[${gltfHash}] completed successfully`)
    report.result = {
      success: true,
      batchId: response.batch_id,
      optimizedAssets: 1,
      individualZips: [s3Key]
    }

    report.finishedAt = new Date()
    return report
  } catch (error) {
    logger.error(`Error processing ${entityType} ${entityId}`)
    logger.error(error as any)
    const errorMsg = error instanceof Error ? error.message : String(error)
    report.errors.push(errorMsg)
    report.godotLogs.push(`[${entityId}] exception: ${errorMsg}`)
    // Unclassified errors (a storage or code fault) are retried, never dropped
    report.transient = !isContentError(error)
    report.finishedAt = new Date()
    report.result = { success: false }
    report.individualAssets.failed = 1
    return report
  }
}

async function fetchEntityDefinition(
  entityId: string,
  contentServerUrl: string,
  fetch: AppComponents['fetch']
): Promise<EntityDefinition & { id: string }> {
  const url = `${contentServerUrl}/contents/${entityId}`
  const response = await fetch.fetch(url)

  if (!response.ok) {
    // Consume body to free the connection
    await response.text().catch(() => {})
    const message = `Failed to fetch entity definition: ${response.status}`
    // Not on that content server (404) is the content's fault; anything else may pass on a retry
    throw contentDownloadError(message, response.status)
  }

  try {
    return (await response.json()) as EntityDefinition & { id: string }
  } catch (error) {
    // A body that is not JSON is the content's fault; a body cut short by the network is not
    if (!(error instanceof SyntaxError)) throw error
    throw new ContentError(`Entity definition of ${entityId} is not JSON: ${error.message}`, { cause: error })
  }
}

async function storeReport(
  report: ProcessReport,
  tempDir: string,
  storage: AppComponents['storage'],
  logger: ReturnType<AppComponents['logs']['getLogger']>
): Promise<void> {
  const reportPath = path.join(tempDir, `${report.entityId}-report.json`)
  try {
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2))

    const s3ReportKey = `${report.entityId}-report.json`
    await storage.storeFile(s3ReportKey, reportPath)
    logger.info('Stored report', { entityId: report.entityId, s3Key: s3ReportKey })
  } catch (reportError) {
    logger.error(`Failed to store report for ${report.entityId}`)
    logger.error(reportError as any)
  } finally {
    // Clean up temp report file
    await fs.rm(reportPath, { force: true }).catch(() => {})
  }
}
