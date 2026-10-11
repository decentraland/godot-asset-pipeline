/**
 * Transient vs content failures.
 *
 * A job that failed because the network blinked (DNS, unreachable host,
 * connection reset, the asset server dying mid-batch, an S3 upload that never
 * landed) or because the infrastructure is misconfigured (the task role cannot
 * write to the bucket, the disk is full) must go back to the queue: it is
 * retried with a backoff and, if it keeps failing, dead-lettered where an
 * operator can redrive it. A job that failed because the content is broken
 * (missing glTF dependency, unparsable file, entity not on the content server)
 * must NOT: re-baking it on every backfill wastes hours and never helps.
 *
 * Only a `ContentError` (or a bake report that positively blames the content)
 * acknowledges a failed job. Anything else, including an error nobody
 * classified (a code bug), is retried: deleting the message is the one outcome
 * that cannot be undone.
 *
 * `TransientError` is the explicit retry signal; `isTransientError` also
 * recognises the raw network errors node-fetch and the AWS SDK throw.
 */

export class TransientError extends Error {
  readonly transient = true
  readonly cause?: unknown

  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'TransientError'
    this.cause = options?.cause
  }
}

/** The content itself cannot be baked: the job is acknowledged (deleted), never retried. */
export class ContentError extends Error {
  readonly content = true
  readonly cause?: unknown

  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'ContentError'
    this.cause = options?.cause
  }
}

export function isContentError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return error instanceof ContentError || (error as { content?: unknown }).content === true
}

/** Node/libuv error codes that mean "the network failed", not "the request was wrong". */
export const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN', // DNS: temporary failure in name resolution
  'ENOTFOUND', // DNS: lookup failed (our hosts exist, so this is the resolver)
  'ENETUNREACH', // no route (v4-only sandbox handed an AAAA, uplink flapped)
  'EHOSTUNREACH',
  'ECONNREFUSED', // asset server not listening (crashed / restarting)
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  // The task ran out of a local resource: another task (or this one, later) can do the job
  'ENOSPC',
  'EMFILE',
  'ENFILE',
  'ENOMEM'
])

/** HTTP statuses a retry can fix. */
export const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504])

const TRANSIENT_MESSAGE_PATTERN = new RegExp(
  [
    ...TRANSIENT_ERROR_CODES,
    'socket hang up',
    'Timeout waiting for batch',
    'Failed to store file .* after \\d+ attempts',
    'Failed to start Godot asset-server',
    'Godot asset-server failed to become ready'
  ].join('|')
)

/**
 * Per-asset errors reported by the godot asset server (reqwest/hyper on the
 * Rust side, or the server's own download step). Only network-shaped errors
 * are transient; `kind: Status(404)`, glTF parse errors, missing dependencies
 * and gltf-transform failures are content defects.
 */
const TRANSIENT_ASSET_ERROR_PATTERN = new RegExp(
  [
    'dns error',
    'Temporary failure in name resolution',
    'Network is unreachable',
    'NetworkUnreachable',
    'HostUnreachable',
    'tcp connect error',
    'Connection refused',
    'ConnectionRefused',
    'connection reset',
    'ConnectionReset',
    'source: TimedOut',
    'operation timed out',
    'connection timed out',
    'error sending request',
    'IncompleteMessage',
    'hyper::Error\\(Connect',
    'kind: Request\\b',
    'kind: Body\\b',
    'kind: Status\\((?:408|425|429|5\\d\\d)\\)'
  ].join('|'),
  'i'
)

/** Local filesystem / permission errors: retrying never helps. */
export const PERMANENT_ERROR_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'EPERM'])

export function isPermanentSystemError(code: unknown): boolean {
  return typeof code === 'string' && PERMANENT_ERROR_CODES.has(code)
}

/**
 * S3 rejections that mean the bucket, the credentials or the KMS key are
 * misconfigured. Retrying in-process does not help, but they say nothing about
 * the content: the job must stay on the queue (and reach the DLQ) until the
 * infrastructure is fixed.
 */
const STORAGE_CONFIG_ERROR_NAMES: ReadonlySet<string> = new Set([
  'AccessDenied',
  'AllAccessDisabled',
  'AccountProblem',
  'AuthorizationHeaderMalformed',
  'ExpiredToken',
  'InvalidAccessKeyId',
  'InvalidBucketName',
  'InvalidToken',
  'NoSuchBucket',
  'PermanentRedirect',
  'SignatureDoesNotMatch'
])

export function isStorageConfigError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number } }
  const name = String(candidate.name ?? candidate.Code ?? '')
  if (STORAGE_CONFIG_ERROR_NAMES.has(name) || name.startsWith('KMS.')) return true
  const status = candidate.$metadata?.httpStatusCode
  return status === 401 || status === 403
}

/**
 * Whether a storage error is not worth retrying in-process: a local file
 * problem, or an AWS SDK v3 4xx (other than 408/425/429) such as an auth or
 * bucket error. Anything the SDK marks retryable, 5xx, or a raw network error
 * (which surfaces with a node `code`) is retried. Not retrying in-process does
 * not make the job a content failure: see `storage.ts`.
 */
export function isPermanentStorageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as {
    code?: unknown
    name?: unknown
    $retryable?: unknown
    $metadata?: { httpStatusCode?: number }
  }
  if (isPermanentSystemError(candidate.code)) return true
  if (candidate.$retryable) return false
  const status = candidate.$metadata?.httpStatusCode
  if (typeof status === 'number' && status >= 400 && status < 500 && !TRANSIENT_HTTP_STATUSES.has(status)) return true
  return isStorageConfigError(error)
}

export function isTransientHttpStatus(status: number): boolean {
  return TRANSIENT_HTTP_STATUSES.has(status)
}

/** Content server statuses that mean "this file or entity does not exist there". */
export const CONTENT_MISSING_HTTP_STATUSES: ReadonlySet<number> = new Set([404, 410])

/**
 * The error for a failed content server download: a `ContentError` when the
 * file or entity is not there (404/410), a `TransientError` for anything else
 * (5xx, 429, a 403 from a WAF), which may pass on a retry.
 */
export function contentDownloadError(message: string, status: number): Error {
  return CONTENT_MISSING_HTTP_STATUSES.has(status) ? new ContentError(message) : new TransientError(message)
}

export function isTransientAssetError(message: string | undefined | null): boolean {
  if (!message) return false
  return TRANSIENT_ASSET_ERROR_PATTERN.test(message)
}

export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (error instanceof TransientError) return true
  if (isContentError(error)) return false
  const candidate = error as { transient?: unknown; code?: unknown; message?: unknown; cause?: unknown }
  if (isPermanentSystemError(candidate.code)) return false
  if (candidate.transient === true) return true
  // node-fetch/undici abort after our own fetch timeout: the peer was alive but unresponsive.
  if ((error as { name?: unknown }).name === 'AbortError') return true
  if (typeof candidate.code === 'string' && TRANSIENT_ERROR_CODES.has(candidate.code)) return true
  if (typeof candidate.message === 'string' && TRANSIENT_MESSAGE_PATTERN.test(candidate.message)) return true
  if (candidate.cause && candidate.cause !== error) return isTransientError(candidate.cause)
  return false
}
