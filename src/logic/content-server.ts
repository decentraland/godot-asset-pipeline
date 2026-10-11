import type { IConfigComponent } from '@well-known-components/interfaces'

// Where content comes from when a job does not say (catalyst deployment
// events carry no `contentServerUrls`). Override with CATALYST_URL.
export const DEFAULT_CATALYST_URL = 'https://peer.decentraland.org'
// Only used to resolve `<name>.dcl.eth` in `--entityId` one-offs.
export const DEFAULT_WORLDS_CONTENT_SERVER_URL = 'https://worlds-content-server.decentraland.org'

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

export async function getCatalystUrl(config: IConfigComponent): Promise<string> {
  return trimTrailingSlashes((await config.getString('CATALYST_URL')) || DEFAULT_CATALYST_URL)
}

/** `<CATALYST_URL>/content`: the content server used when a job carries none. */
export async function getDefaultContentServerUrl(config: IConfigComponent): Promise<string> {
  return `${await getCatalystUrl(config)}/content`
}

export async function getWorldsContentServerUrl(config: IConfigComponent): Promise<string> {
  return trimTrailingSlashes((await config.getString('WORLDS_CONTENT_SERVER_URL')) || DEFAULT_WORLDS_CONTENT_SERVER_URL)
}

/** The job's own content server (first of `contentServerUrls`), without a trailing slash; `undefined` when absent. */
export function jobContentServerUrl(job: { contentServerUrls?: string[] }): string | undefined {
  const url = job.contentServerUrls?.find((candidate) => typeof candidate === 'string' && candidate.length > 0)
  return url ? trimTrailingSlashes(url) : undefined
}

/** The content server a job is baked from: its own, or `<CATALYST_URL>/content`. */
export async function resolveContentServerUrl(
  job: { contentServerUrls?: string[] },
  config: IConfigComponent
): Promise<string> {
  return jobContentServerUrl(job) ?? (await getDefaultContentServerUrl(config))
}

/**
 * Parses ALLOWED_CONTENT_SERVER_HOSTS (comma-separated host names, as exported
 * by the platform's service definitions). `undefined` (unset or empty) means
 * every host is allowed.
 */
export function parseAllowedHosts(value: string | undefined): ReadonlySet<string> | undefined {
  const hosts = (value || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0)
  return hosts.length > 0 ? new Set(hosts) : undefined
}

/**
 * Whether a content server URL may be fetched from. The URL travels in the
 * queue message, so pinning it to an allowlist keeps a forged message from
 * pointing the worker (and the asset server) at an arbitrary host.
 */
export function isContentServerAllowed(url: string, allowedHosts: ReadonlySet<string> | undefined): boolean {
  if (!allowedHosts) return true
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return allowedHosts.has(hostname)
}
