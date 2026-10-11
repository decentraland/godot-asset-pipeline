/**
 * Local content proxy: lets the consumer re-run a scene through the asset
 * server with some of its files hidden.
 *
 * The godot asset server fetches the scene entity and every file it lists
 * from `content_base_url`. When a job panics inside the server (seen with
 * `FromGodot::from_variant() failed -- cannot convert from NIL to OBJECT` on
 * some glTFs) it never reaches a terminal state and the batch hangs forever.
 * The only lever the server exposes is the entity itself, so the retry pass
 * points `content_base_url` at this consumer's own HTTP server, which serves
 * the entity with the offending files removed and proxies everything else
 * byte-for-byte to the real content server (through the retrying fetch).
 */

export type ContentProxyEntry = {
  contentServerUrl: string
  exclude: ReadonlySet<string>
}

export interface IContentProxyComponent {
  /** Registers a filtered view of an entity; returns the `content_base_url` the asset server must use. */
  register(entityId: string, contentServerUrl: string, exclude: Iterable<string>): string
  unregister(entityId: string): void
  lookup(entityId: string): ContentProxyEntry | undefined
  baseUrlFor(entityId: string): string
}

export const CONTENT_PROXY_PATH = '/content-proxy'

export function createContentProxyComponent(options: { port: number; host?: string }): IContentProxyComponent {
  const host = options.host ?? '127.0.0.1'
  const entries = new Map<string, ContentProxyEntry>()

  function baseUrlFor(entityId: string): string {
    return `http://${host}:${options.port}${CONTENT_PROXY_PATH}/${encodeURIComponent(entityId)}/contents/`
  }

  return {
    register(entityId, contentServerUrl, exclude) {
      entries.set(entityId, { contentServerUrl: contentServerUrl.replace(/\/$/, ''), exclude: new Set(exclude) })
      return baseUrlFor(entityId)
    },
    unregister(entityId) {
      entries.delete(entityId)
    },
    lookup(entityId) {
      return entries.get(entityId)
    },
    baseUrlFor
  }
}

export type EntityLike = { content?: Array<{ file: string; hash: string }> } & Record<string, unknown>

/** The entity as the asset server should see it: every excluded file gone. */
export function filterEntityContent<T extends EntityLike>(entity: T, exclude: ReadonlySet<string>): T {
  const content = (entity.content || []).filter((item) => !exclude.has(item.hash))
  return { ...entity, content }
}
