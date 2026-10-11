import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import { test } from '../components'

// The asset server calls this route through the real HTTP server: this
// checks the route wiring and path params against a real listener. The
// "content server" is a throwaway local HTTP server serving <base>/contents/<hash>.
test('content proxy route', function ({ components }) {
  const ENTITY = 'bafyproxyentity'
  const files: Record<string, { type: string; body: string }> = {
    [ENTITY]: {
      type: 'application/json',
      body: JSON.stringify({
        id: ENTITY,
        metadata: { main: 'bin/index.js' },
        content: [
          { file: 'bin/index.js', hash: 'bafyproxyjs' },
          { file: 'models/bad.gltf', hash: 'bafyproxybad' }
        ]
      })
    },
    bafyproxyjs: { type: 'application/javascript', body: 'console.log("js")' }
  }
  let upstream: Server
  let upstreamUrl: string

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      const match = /^\/content\/contents\/([^/?]+)$/.exec(req.url || '')
      const file = match ? files[match[1]] : undefined
      if (!file) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': file.type }).end(file.body)
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/content`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  it('answers 404 for an unregistered entity', async () => {
    const r = await components.localFetch.fetch(`/content-proxy/${ENTITY}/contents/${ENTITY}`)
    expect(r.status).toBe(404)
  })

  it('serves the filtered entity and proxies other files', async () => {
    const base = components.contentProxy.register(ENTITY, upstreamUrl, ['bafyproxybad'])
    expect(base).toContain(`/content-proxy/${ENTITY}/contents/`)

    const entity = await components.localFetch.fetch(`/content-proxy/${ENTITY}/contents/${ENTITY}`)
    expect(entity.status).toBe(200)
    const body = await entity.json()
    expect(body.content.map((c: { hash: string }) => c.hash)).toEqual(['bafyproxyjs'])

    const js = await components.localFetch.fetch(`/content-proxy/${ENTITY}/contents/bafyproxyjs`)
    expect(js.status).toBe(200)
    expect(await js.text()).toBe('console.log("js")')

    const missing = await components.localFetch.fetch(`/content-proxy/${ENTITY}/contents/bafyproxynone`)
    expect(missing.status).toBe(404)
    components.contentProxy.unregister(ENTITY)
  })
})
