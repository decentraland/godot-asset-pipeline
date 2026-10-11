import AdmZip from 'adm-zip'
import fs from 'fs/promises'
import path from 'path'
import type { IFetchComponent } from '@well-known-components/http-server'
import { IStorageComponent } from '../../adapters/storage'
import { contentDownloadError } from '../../logic/transient-error'
import { contentTypeFor } from './publish'

/**
 * Boot bundle for scenes the asset server refuses ("No processable assets
 * found in scene": no GLB/glTF to bake). A normal v6 bake publishes, next to
 * the mesh outputs, the scene code under its own hashes, the manifest
 * `<entity>-optimized.json`, the boot zip `<entity>-boot.zip` (manifest +
 * main.js + main.crdt) and the legacy `<entity>-mobile.zip` (manifest only).
 * A code-only scene deserves exactly that set minus the meshes, so the client
 * boots it from the CDN like any optimized scene.
 * The bytes of the script are the originals — the bake never rewrites code;
 * the CDN compresses `application/javascript` on the wire.
 */

export type EntityContent = { file: string; hash: string }
export type EntityDefinition = {
  id?: string
  metadata?: { main?: string }
  content: EntityContent[]
}

/** Keys are the client's normalized names, values are content hashes (what the asset server emits). */
export type BootFiles = { 'main.js': string; 'main.crdt'?: string }

export type BootManifest = {
  optimizedContent: string[]
  externalSceneDependencies: Record<string, string[]>
  originalSizes: Record<string, { width: number; height: number }>
  hashSizeMap: Record<string, number>
  bootFiles: BootFiles
  bootBundle: { file: string }
}

export type PublishedBootBundle = {
  manifest: BootManifest
  /** Object keys, metadata zip first — same shape as a full bake's `result.individualZips`. */
  individualZips: string[]
  metadataZipPath: string
}

export const CRDT_FILE = 'main.crdt'

export function manifestKey(entityId: string): string {
  return `${entityId}-optimized.json`
}

export function bootZipKey(entityId: string): string {
  return `${entityId}-boot.zip`
}

export function mobileZipKey(entityId: string): string {
  return `${entityId}-mobile.zip`
}

/** The scene's entry script (scene.json `main`) and its main.crdt, by hash; null when there is no script. */
export function selectBootFiles(entity: EntityDefinition): BootFiles | null {
  const main = entity.metadata?.main
  if (!main) return null
  const content = entity.content || []
  const exact = content.find((c) => c.file === main)
  const loose = exact ?? content.find((c) => c.file.toLowerCase() === main.toLowerCase())
  if (!loose) return null
  const crdt = content.find((c) => c.file === CRDT_FILE)
  return crdt ? { 'main.js': loose.hash, 'main.crdt': crdt.hash } : { 'main.js': loose.hash }
}

export function buildBootManifest(entityId: string, bootFiles: BootFiles): BootManifest {
  return {
    optimizedContent: [],
    externalSceneDependencies: {},
    originalSizes: {},
    hashSizeMap: {},
    bootFiles,
    bootBundle: { file: bootZipKey(entityId) }
  }
}

async function download(fetch: IFetchComponent, url: string): Promise<Buffer> {
  const response = await fetch.fetch(url)
  if (!response.ok) {
    await response.text().catch(() => {})
    const message = `Failed to download ${url}: ${response.status}`
    throw contentDownloadError(message, response.status)
  }
  return Buffer.from(await response.arrayBuffer())
}

export type PublishBootBundleParams = {
  entityId: string
  contentServerUrl: string
  entity: EntityDefinition
  /** Scratch directory; a per-entity subdirectory is created and removed. */
  workDir: string
  components: { fetch: IFetchComponent; storage: Pick<IStorageComponent, 'storeFileStrict'> }
}

/**
 * Publishes the boot-only bake. Upload order mirrors a full bake: the script
 * and crdt first, then the manifest and boot zip, the legacy metadata zip
 * last — a client fetching mid-upload never sees a manifest whose files are
 * not there yet. Returns null when the entity has no entry script.
 */
export async function publishBootBundle(params: PublishBootBundleParams): Promise<PublishedBootBundle | null> {
  const { entityId, contentServerUrl, entity, workDir, components } = params
  const bootFiles = selectBootFiles(entity)
  if (!bootFiles) return null

  const manifest = buildBootManifest(entityId, bootFiles)
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2))
  const base = `${contentServerUrl.replace(/\/$/, '')}/contents/`
  const script = await download(components.fetch, base + bootFiles['main.js'])
  const crdt = bootFiles['main.crdt'] ? await download(components.fetch, base + bootFiles['main.crdt']) : null

  // Inside the zips the code files are named by bare hash, as the asset server does.
  const boot = new AdmZip()
  boot.addFile(manifestKey(entityId), manifestBytes)
  boot.addFile(bootFiles['main.js'], script)
  if (crdt && bootFiles['main.crdt']) boot.addFile(bootFiles['main.crdt'], crdt)
  const mobile = new AdmZip()
  mobile.addFile(manifestKey(entityId), manifestBytes)

  const files: Array<{ key: string; data: Buffer }> = [
    { key: `${bootFiles['main.js']}.js`, data: script },
    ...(crdt && bootFiles['main.crdt'] ? [{ key: `${bootFiles['main.crdt']}.crdt`, data: crdt }] : []),
    { key: manifestKey(entityId), data: manifestBytes },
    { key: bootZipKey(entityId), data: boot.toBuffer() },
    { key: mobileZipKey(entityId), data: mobile.toBuffer() }
  ]

  const dir = path.join(workDir, `${entityId}-boot`)
  await fs.mkdir(dir, { recursive: true })
  try {
    const uploaded: string[] = []
    for (const file of files) {
      const filePath = path.join(dir, file.key)
      await fs.writeFile(filePath, file.data)
      await components.storage.storeFileStrict(file.key, filePath, contentTypeFor(file.key))
      uploaded.push(file.key)
    }
    const metadataZipPath = mobileZipKey(entityId)
    return {
      manifest,
      individualZips: [metadataZipPath, ...uploaded.filter((k) => k !== metadataZipPath)],
      metadataZipPath
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
