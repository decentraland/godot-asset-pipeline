/**
 * Which pending files to hide together with the ones that stalled.
 *
 * The asset server jams on families of generated files (one scene had 40
 * node-heavy `building_ring_in_01.<ts>.glb` … `building_ring_out_18.<ts>.glb`
 * that starve it four at a time). Excluding only the four that stalled means
 * a pass per four files; the siblings are going to stall next. Files of such
 * a family share a name stem — the basename with its extension, dotted
 * suffixes and trailing numbers removed — so when the stalled files share a
 * long enough stem prefix, every pending file with that prefix goes too.
 */

export type ContentEntry = { file: string; hash: string }

/** Minimum shared stem length before siblings are excluded; shorter prefixes are not a family. */
export const MIN_FAMILY_STEM = 6

/** `models/Building_Ring_in_03.20260909135738746.glb` → `building_ring_in` */
export function nameStem(file: string): string {
  const base = file.split('/').pop() || file
  const noExt = base.replace(/\.[^.]*$/, '')
  return noExt
    .toLowerCase()
    .replace(/\.[0-9a-z]+$/g, '') // dotted suffixes (timestamps, variants)
    .replace(/[_\-. ]*\d+$/g, '') // trailing counters
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0]
  for (const value of values.slice(1)) {
    let i = 0
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix) break
  }
  return prefix
}

/**
 * Pending hashes (not stalled themselves) that belong to the stalled files'
 * family. Empty when the stalled files have no common stem worth the name.
 * Pass every file that stalled so far, not just this pass's: the prefix then
 * widens as more families stall (`building_ring_` → `building_`).
 */
export function expandStalledFamily(stuckHashes: string[], pendingHashes: string[], content: ContentEntry[]): string[] {
  const fileOf = new Map(content.map((c) => [c.hash, c.file]))
  const stems = stuckHashes
    .map((h) => fileOf.get(h))
    .filter((f): f is string => !!f)
    .map(nameStem)
  if (stems.length === 0) return []
  const prefix = commonPrefix(stems)
  if (prefix.length < MIN_FAMILY_STEM) return []
  const stuck = new Set(stuckHashes)
  return pendingHashes.filter((h) => {
    if (stuck.has(h)) return false
    const file = fileOf.get(h)
    return !!file && nameStem(file).startsWith(prefix)
  })
}
