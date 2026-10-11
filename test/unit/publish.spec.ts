import { contentTypeFor, objectKeyFor, orderForUpload } from '../../src/runners/godot-optimizer/publish'

describe('objectKeyFor', () => {
  it('publishes a file under the name the asset server gave it', () => {
    expect(objectKeyFor('/tmp/output/bafkreiabc.scn')).toBe('bafkreiabc.scn')
    expect(objectKeyFor('/tmp/output/bafkreiabc.res')).toBe('bafkreiabc.res')
    expect(objectKeyFor('/tmp/output/bafybeijs.js')).toBe('bafybeijs.js')
    expect(objectKeyFor('/tmp/output/scene1-optimized.json')).toBe('scene1-optimized.json')
    expect(objectKeyFor('/tmp/output/scene1-boot.zip')).toBe('scene1-boot.zip')
    // v5-era server and wearables/emotes: unchanged key
    expect(objectKeyFor('/tmp/output/bafkreiabc-mobile.zip')).toBe('bafkreiabc-mobile.zip')
  })
})

describe('contentTypeFor', () => {
  it('marks text files so the CDN compresses them and leaves binaries alone', () => {
    expect(contentTypeFor('bafybeijs.js')).toBe('application/javascript')
    expect(contentTypeFor('scene1-optimized.json')).toBe('application/json')
    expect(contentTypeFor('scene1-boot.zip')).toBe('application/zip')
    expect(contentTypeFor('scene1-mobile.zip')).toBe('application/zip')
    expect(contentTypeFor('bafkreiabc.scn')).toBe('application/octet-stream')
    expect(contentTypeFor('bafkreiabc.res')).toBe('application/octet-stream')
    expect(contentTypeFor('bafkreicrdt.crdt')).toBe('application/octet-stream')
  })
})

describe('orderForUpload', () => {
  const entry = (name: string) => ({ hash: name, zip_path: `/out/${name}` })

  it('keeps the server order but moves the manifest and the boot zip to the end', () => {
    const entries = [
      entry('scene1-boot.zip'),
      entry('a.scn'),
      entry('scene1-optimized.json'),
      entry('b.res'),
      entry('c.js'),
      entry('scene1-static.zip')
    ]
    expect(orderForUpload(entries, 'scene1').map((e) => e.hash)).toEqual([
      'a.scn',
      'b.res',
      'c.js',
      'scene1-static.zip',
      'scene1-optimized.json',
      'scene1-boot.zip'
    ])
  })

  it('lists a file once when the batch names it twice (same hash under two paths)', () => {
    const entries = [entry('tex.res'), entry('a.scn'), entry('tex.res')]
    expect(orderForUpload(entries, 'scene1').map((e) => e.hash)).toEqual(['tex.res', 'a.scn'])
  })

  it('does not touch a v5 batch or the input array', () => {
    const entries = [entry('a-mobile.zip'), entry('b-mobile.zip')]
    const ordered = orderForUpload(entries, 'scene1')
    expect(ordered.map((e) => e.hash)).toEqual(['a-mobile.zip', 'b-mobile.zip'])
    expect(ordered).not.toBe(entries)
  })
})
