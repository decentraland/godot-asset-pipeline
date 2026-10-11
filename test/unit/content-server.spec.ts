import {
  DEFAULT_CATALYST_URL,
  getDefaultContentServerUrl,
  isContentServerAllowed,
  jobContentServerUrl,
  parseAllowedHosts,
  resolveContentServerUrl
} from '../../src/logic/content-server'

function config(values: Record<string, string>) {
  return {
    getString: async (key: string) => values[key],
    getNumber: jest.fn(),
    requireString: jest.fn(),
    requireNumber: jest.fn()
  }
}

describe('content server resolution', () => {
  it('defaults to the mainnet catalyst content server', async () => {
    expect(await getDefaultContentServerUrl(config({}))).toBe(`${DEFAULT_CATALYST_URL}/content`)
  })

  it('derives the default content server from CATALYST_URL', async () => {
    expect(await getDefaultContentServerUrl(config({ CATALYST_URL: 'https://peer.example.org/' }))).toBe(
      'https://peer.example.org/content'
    )
  })

  it("prefers the job's own content server, without trailing slashes", async () => {
    const job = { contentServerUrls: ['https://worlds.example.org/', 'https://other.example.org'] }
    expect(jobContentServerUrl(job)).toBe('https://worlds.example.org')
    expect(await resolveContentServerUrl(job, config({ CATALYST_URL: 'https://peer.example.org' }))).toBe(
      'https://worlds.example.org'
    )
  })

  it('falls back to CATALYST_URL when the job has no usable content server', async () => {
    const cfg = config({ CATALYST_URL: 'https://peer.example.org' })
    expect(await resolveContentServerUrl({}, cfg)).toBe('https://peer.example.org/content')
    expect(await resolveContentServerUrl({ contentServerUrls: [] }, cfg)).toBe('https://peer.example.org/content')
    expect(await resolveContentServerUrl({ contentServerUrls: [''] }, cfg)).toBe('https://peer.example.org/content')
  })
})

describe('content server allowlist', () => {
  it('allows every host when unset or empty', () => {
    expect(parseAllowedHosts(undefined)).toBeUndefined()
    expect(parseAllowedHosts(' , ')).toBeUndefined()
    expect(isContentServerAllowed('https://anything.example.org/content', undefined)).toBe(true)
  })

  it('matches the URL host against the comma-separated list, case-insensitively', () => {
    const allowed = parseAllowedHosts('peer.decentraland.org, Worlds-Content-Server.decentraland.org')
    expect(isContentServerAllowed('https://peer.decentraland.org/content', allowed)).toBe(true)
    expect(isContentServerAllowed('https://WORLDS-CONTENT-SERVER.decentraland.org', allowed)).toBe(true)
    expect(isContentServerAllowed('https://peer.decentraland.org.evil.example/content', allowed)).toBe(false)
    expect(isContentServerAllowed('http://169.254.169.254/latest', allowed)).toBe(false)
  })

  it('rejects a URL that does not parse', () => {
    expect(isContentServerAllowed('not a url', parseAllowedHosts('peer.decentraland.org'))).toBe(false)
  })
})
