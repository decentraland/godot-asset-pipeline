import AdmZip from 'adm-zip'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { TransientError } from '../../src/logic/transient-error'
import { buildBootManifest, publishBootBundle, selectBootFiles } from '../../src/runners/godot-optimizer/boot-bundle'

const JS = 'bafybeicg7kvby66gtx7lstojr5el7r7b4xaxqeu4zyrzxrufspksndlxfi'
const CRDT = 'bafkreiframev2lmvbln6mk6sr7ojhwgtxwrfmfydij7hoqag7avrjdfod4'
const ENTITY = 'bafkreiggif2xd7lyrhcsrnz2laopi77z4miqywcz6z7p5rasg4rxeuektu'

const entity = {
  id: ENTITY,
  metadata: { main: 'bin/index.js' },
  content: [
    { file: 'scene.json', hash: 'bafkreiscene' },
    { file: 'main.crdt', hash: CRDT },
    { file: 'bin/index.js', hash: JS },
    { file: 'sounds/a.mp3', hash: 'bafkreisound' }
  ]
}

describe('selectBootFiles', () => {
  it('picks the scene.json main script and main.crdt by hash', () => {
    expect(selectBootFiles(entity)).toEqual({ 'main.js': JS, 'main.crdt': CRDT })
  })

  it('omits main.crdt when the deployment has none', () => {
    expect(selectBootFiles({ ...entity, content: entity.content.filter((c) => c.file !== 'main.crdt') })).toEqual({
      'main.js': JS
    })
  })

  it('matches the main path case-insensitively', () => {
    expect(selectBootFiles({ ...entity, metadata: { main: 'Bin/Index.js' } })).toEqual({
      'main.js': JS,
      'main.crdt': CRDT
    })
  })

  it('returns null without a main script', () => {
    expect(selectBootFiles({ ...entity, metadata: {} })).toBeNull()
    expect(selectBootFiles({ ...entity, metadata: { main: 'bin/missing.js' } })).toBeNull()
    expect(selectBootFiles({ content: [] })).toBeNull()
  })
})

describe('buildBootManifest', () => {
  it('has the asset server manifest shape with nothing optimized', () => {
    expect(buildBootManifest(ENTITY, { 'main.js': JS, 'main.crdt': CRDT })).toEqual({
      optimizedContent: [],
      externalSceneDependencies: {},
      originalSizes: {},
      hashSizeMap: {},
      bootFiles: { 'main.js': JS, 'main.crdt': CRDT },
      bootBundle: { file: `${ENTITY}-boot.zip` }
    })
  })
})

describe('publishBootBundle', () => {
  let workDir: string
  beforeAll(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'boot-bundle-'))
  })
  afterAll(() => rm(workDir, { recursive: true, force: true }))

  function fetchServing(bodies: Record<string, string>, status: Record<string, number> = {}) {
    return {
      fetch: jest.fn(async (url: string) => {
        const hash = url.split('/').pop() as string
        const code = status[hash] ?? (hash in bodies ? 200 : 404)
        return {
          ok: code === 200,
          status: code,
          text: async () => 'nope',
          arrayBuffer: async () => Buffer.from(bodies[hash] ?? '')
        }
      })
    }
  }

  function capturingStorage() {
    const calls: Array<{ key: string; contentType?: string; bytes: Buffer }> = []
    return {
      calls,
      storeFileStrict: jest.fn(async (key: string, filePath: string, contentType?: string) => {
        calls.push({ key, contentType, bytes: await readFile(filePath) })
      })
    }
  }

  it('publishes script, crdt, manifest, boot zip and metadata zip in that order', async () => {
    const fetch = fetchServing({ [JS]: '"use strict";console.log(1)', [CRDT]: 'crdt-bytes' })
    const storage = capturingStorage()
    const result = await publishBootBundle({
      entityId: ENTITY,
      contentServerUrl: 'https://peer.decentraland.org/content/',
      entity,
      workDir,
      components: { fetch: fetch as any, storage }
    })

    expect(fetch.fetch.mock.calls.map((c) => c[0])).toEqual([
      `https://peer.decentraland.org/content/contents/${JS}`,
      `https://peer.decentraland.org/content/contents/${CRDT}`
    ])
    expect(storage.calls.map((c) => [c.key, c.contentType])).toEqual([
      [`${JS}.js`, 'application/javascript'],
      [`${CRDT}.crdt`, 'application/octet-stream'],
      [`${ENTITY}-optimized.json`, 'application/json'],
      [`${ENTITY}-boot.zip`, 'application/zip'],
      [`${ENTITY}-mobile.zip`, 'application/zip']
    ])
    // the script is published byte-for-byte
    expect(storage.calls[0].bytes.toString()).toBe('"use strict";console.log(1)')
    // manifest bytes are the same everywhere they appear
    const manifestBytes = storage.calls[2].bytes
    expect(JSON.parse(manifestBytes.toString())).toEqual(result?.manifest)
    const boot = new AdmZip(storage.calls[3].bytes)
    expect(
      boot
        .getEntries()
        .map((e) => e.entryName)
        .sort()
    ).toEqual([JS, CRDT, `${ENTITY}-optimized.json`].sort())
    expect(boot.readFile(`${ENTITY}-optimized.json`)?.equals(manifestBytes)).toBe(true)
    expect(boot.readFile(JS)?.toString()).toBe('"use strict";console.log(1)')
    const mobile = new AdmZip(storage.calls[4].bytes)
    expect(mobile.getEntries().map((e) => e.entryName)).toEqual([`${ENTITY}-optimized.json`])

    expect(result).toEqual({
      manifest: buildBootManifest(ENTITY, { 'main.js': JS, 'main.crdt': CRDT }),
      individualZips: [
        `${ENTITY}-mobile.zip`,
        `${JS}.js`,
        `${CRDT}.crdt`,
        `${ENTITY}-optimized.json`,
        `${ENTITY}-boot.zip`
      ],
      metadataZipPath: `${ENTITY}-mobile.zip`
    })
    expect(await readdir(workDir)).toEqual([])
  })

  it('returns null and uploads nothing for an entity without a main script', async () => {
    const storage = capturingStorage()
    const result = await publishBootBundle({
      entityId: ENTITY,
      contentServerUrl: 'https://peer.decentraland.org/content',
      entity: { content: [{ file: 'scene.json', hash: 'x' }] },
      workDir,
      components: { fetch: fetchServing({}) as any, storage }
    })
    expect(result).toBeNull()
    expect(storage.storeFileStrict).not.toHaveBeenCalled()
  })

  it('fails permanently on a missing script and transiently on a 5xx', async () => {
    const storage = capturingStorage()
    const base = { entityId: ENTITY, contentServerUrl: 'https://c', entity, workDir }
    const missing = await publishBootBundle({ ...base, components: { fetch: fetchServing({}) as any, storage } }).catch(
      (e) => e
    )
    expect(missing).toBeInstanceOf(Error)
    expect(missing).not.toBeInstanceOf(TransientError)
    expect(missing.message).toBe(`Failed to download https://c/contents/${JS}: 404`)

    const flaky = await publishBootBundle({
      ...base,
      components: { fetch: fetchServing({ [JS]: 'x' }, { [JS]: 503 }) as any, storage }
    }).catch((e) => e)
    expect(flaky).toBeInstanceOf(TransientError)
    expect(storage.storeFileStrict).not.toHaveBeenCalled()
  })
})
