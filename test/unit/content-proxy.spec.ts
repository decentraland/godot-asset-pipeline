import { createContentProxyComponent, filterEntityContent } from '../../src/adapters/content-proxy'
import { contentProxyHandler } from '../../src/controllers/handlers/content-proxy'

const ENTITY = 'bafyscene'
const entity = {
  id: ENTITY,
  metadata: { main: 'bin/index.js' },
  content: [
    { file: 'bin/index.js', hash: 'bafyjs' },
    { file: 'models/bad.gltf', hash: 'bafybad' },
    { file: 'models/ok.glb', hash: 'bafyok' }
  ]
}

function stubLogs() {
  const logger = { log: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() }
  return { logs: { getLogger: () => logger }, logger }
}

describe('content proxy registry', () => {
  it('builds the base url the asset server must use and remembers the exclusions', () => {
    const proxy = createContentProxyComponent({ port: 5000 })
    const base = proxy.register(ENTITY, 'https://peer.decentraland.org/content/', ['bafybad'])
    expect(base).toBe('http://127.0.0.1:5000/content-proxy/bafyscene/contents/')
    expect(proxy.lookup(ENTITY)).toEqual({
      contentServerUrl: 'https://peer.decentraland.org/content',
      exclude: new Set(['bafybad'])
    })
    proxy.unregister(ENTITY)
    expect(proxy.lookup(ENTITY)).toBeUndefined()
  })
})

describe('filterEntityContent', () => {
  it('drops excluded files and keeps everything else intact', () => {
    const filtered = filterEntityContent(entity, new Set(['bafybad']))
    expect(filtered.content.map((c) => c.hash)).toEqual(['bafyjs', 'bafyok'])
    expect(filtered.metadata).toEqual(entity.metadata)
    expect(entity.content).toHaveLength(3)
  })
})

describe('contentProxyHandler', () => {
  function upstream(bodies: Record<string, { json?: unknown; bytes?: string; status?: number; type?: string }>) {
    return {
      fetch: jest.fn(async (url: string) => {
        const hash = url.split('/').pop() as string
        const b = bodies[hash]
        if (!b) return { ok: false, status: 404, text: async () => 'missing', headers: { get: () => null } }
        return {
          ok: (b.status ?? 200) < 400,
          status: b.status ?? 200,
          text: async () => 'err',
          json: async () => b.json,
          arrayBuffer: async () => Buffer.from(b.bytes ?? ''),
          headers: { get: (name: string) => (name === 'content-type' ? (b.type ?? null) : null) }
        }
      })
    }
  }

  function call(proxy: ReturnType<typeof createContentProxyComponent>, fetch: any, hash: string) {
    return contentProxyHandler({
      params: { entityId: ENTITY, hash },
      components: { contentProxy: proxy, fetch, logs: stubLogs().logs as any }
    } as any)
  }

  it('answers 404 for an entity that is not registered', async () => {
    const proxy = createContentProxyComponent({ port: 5000 })
    const res = await call(proxy, upstream({}), ENTITY)
    expect(res.status).toBe(404)
  })

  it('serves the entity with the excluded files removed', async () => {
    const proxy = createContentProxyComponent({ port: 5000 })
    proxy.register(ENTITY, 'https://peer.decentraland.org/content', ['bafybad'])
    const fetch = upstream({ [ENTITY]: { json: entity } })
    const res = await call(proxy, fetch, ENTITY)
    expect(res.status).toBe(200)
    expect(fetch.fetch).toHaveBeenCalledWith('https://peer.decentraland.org/content/contents/bafyscene')
    expect(JSON.parse(res.body as string).content.map((c: any) => c.hash)).toEqual(['bafyjs', 'bafyok'])
  })

  it('proxies any other hash byte-for-byte with its content type', async () => {
    const proxy = createContentProxyComponent({ port: 5000 })
    proxy.register(ENTITY, 'https://peer.decentraland.org/content', [])
    const res = await call(proxy, upstream({ bafyok: { bytes: 'glb-bytes', type: 'model/gltf-binary' } }), 'bafyok')
    expect(res.status).toBe(200)
    expect((res.body as Buffer).toString()).toBe('glb-bytes')
    expect(res.headers).toEqual({ 'Content-Type': 'model/gltf-binary', 'Content-Length': '9' })
  })

  it('passes upstream errors through', async () => {
    const proxy = createContentProxyComponent({ port: 5000 })
    proxy.register(ENTITY, 'https://peer.decentraland.org/content', [])
    const res = await call(proxy, upstream({}), 'bafymissing')
    expect(res.status).toBe(404)
  })
})
