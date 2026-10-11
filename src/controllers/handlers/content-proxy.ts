import type { IHttpServerComponent } from '@well-known-components/interfaces'
import { HandlerContextWithPath } from '../../types'
import { filterEntityContent } from '../../adapters/content-proxy'

/**
 * GET /content-proxy/:entityId/contents/:hash — see adapters/content-proxy.ts.
 * Only entities registered for a retry pass are served; the entity document
 * itself comes back with the excluded files removed, every other hash is
 * proxied as-is from the real content server.
 */
export async function contentProxyHandler(
  context: Pick<
    HandlerContextWithPath<'contentProxy' | 'fetch' | 'logs', '/content-proxy/:entityId/contents/:hash'>,
    'params' | 'components'
  >
): Promise<IHttpServerComponent.IResponse> {
  const { contentProxy, fetch, logs } = context.components
  const { entityId, hash } = context.params
  const entry = contentProxy.lookup(entityId)
  if (!entry) {
    return { status: 404, body: `No filtered view registered for entity ${entityId}` }
  }

  const upstream = `${entry.contentServerUrl}/contents/${encodeURIComponent(hash)}`
  const response = await fetch.fetch(upstream)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logs.getLogger('content-proxy').warn(`Upstream ${response.status} for ${upstream}`)
    return { status: response.status, body: text }
  }

  if (hash === entityId) {
    const entity = (await response.json()) as Parameters<typeof filterEntityContent>[0]
    const filtered = filterEntityContent(entity, entry.exclude)
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filtered)
    }
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  const headers: Record<string, string> = {
    'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
    'Content-Length': String(bytes.length)
  }
  return { status: 200, headers, body: bytes }
}
