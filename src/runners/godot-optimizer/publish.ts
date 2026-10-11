import path from 'path'

/**
 * How a finished bake is published to the bucket. The asset server names
 * every output file exactly as the client requests it (`{hash}.scn`,
 * `{hash}.res`, `{hash}.js`, `{hash}.crdt`, `{entity}-optimized.json`,
 * `{entity}-boot.zip`, `{entity}-static.zip`, and the legacy
 * `{hash}-mobile.zip` for wearables/emotes), so the object key is the
 * basename — never rebuilt from the hash here.
 */
export function objectKeyFor(filePath: string): string {
  return path.basename(filePath)
}

/**
 * Content type stored on the object. The CDN compresses text types on the fly
 * (Genesis Plaza's main.js: 2.26 MB → 390 KB as brotli); zips and Godot
 * resources are already compressed and must not be.
 */
export function contentTypeFor(key: string): string {
  if (key.endsWith('.js')) return 'application/javascript'
  if (key.endsWith('.json')) return 'application/json'
  if (key.endsWith('.zip')) return 'application/zip'
  return 'application/octet-stream'
}

/**
 * Upload order for a scene batch: the server's order, except that the
 * manifest and the boot zip always go last. A client fetching mid-upload must
 * never see a manifest whose dependencies are not in the bucket yet.
 *
 * Each file is listed once. The asset server lists a job per content entry,
 * and a deployment can carry the same bytes under two paths (same hash), so
 * the batch can name one file twice — the first upload deletes it, the second
 * would fail with ENOENT.
 */
export function orderForUpload<T extends { zip_path: string }>(entries: T[], entityId: string): T[] {
  const last = [`${entityId}-optimized.json`, `${entityId}-boot.zip`]
  const rank = (entry: T) => last.indexOf(objectKeyFor(entry.zip_path))
  const seen = new Set<string>()
  const unique = entries.filter((entry) => {
    const key = objectKeyFor(entry.zip_path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique.sort((a, b) => rank(a) - rank(b))
}
