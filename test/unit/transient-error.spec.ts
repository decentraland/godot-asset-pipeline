import {
  ContentError,
  TransientError,
  contentDownloadError,
  isContentError,
  isPermanentStorageError,
  isStorageConfigError,
  isTransientAssetError,
  isTransientError,
  isTransientHttpStatus
} from '../../src/logic/transient-error'

describe('TransientError', () => {
  it('is an Error with the transient flag', () => {
    const error = new TransientError('boom', { cause: new Error('root') })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TransientError')
    expect(error.transient).toBe(true)
    expect(isTransientError(error)).toBe(true)
  })
})

describe('isTransientError', () => {
  it.each([
    'EAI_AGAIN',
    'ENOTFOUND',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE'
  ])('recognises node network code %s', (code) => {
    expect(isTransientError(Object.assign(new Error('request failed'), { code }))).toBe(true)
  })

  it('recognises node-fetch style messages without a code', () => {
    expect(
      isTransientError(
        new Error('request to http://localhost:8080/status/abc failed, reason: connect ECONNREFUSED 127.0.0.1:8080')
      )
    ).toBe(true)
    expect(isTransientError(new Error('Timeout waiting for batch 1234 to complete after 600000ms'))).toBe(true)
    expect(isTransientError(new Error('Failed to store file v6/x-mobile.zip after 5 attempts'))).toBe(true)
    expect(isTransientError(new Error('Failed to start Godot asset-server'))).toBe(true)
  })

  it('treats a fetch abort (unresponsive peer) as transient', () => {
    expect(isTransientError(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }))).toBe(true)
  })

  it('follows the cause chain', () => {
    const cause = Object.assign(new Error('getaddrinfo EAI_AGAIN host'), { code: 'EAI_AGAIN' })
    expect(isTransientError(Object.assign(new Error('wrapped'), { cause }))).toBe(true)
  })

  it('treats content and programming errors as permanent', () => {
    expect(isTransientError(new Error('No main ZIP file created'))).toBe(false)
    expect(isTransientError(new Error('There are some missing dependencies in the gltf'))).toBe(false)
    expect(isTransientError(Object.assign(new Error('bad'), { code: 'ENOENT' }))).toBe(false)
    expect(isTransientError(null)).toBe(false)
    expect(isTransientError('EAI_AGAIN')).toBe(false)
  })
})

describe('isTransientAssetError (godot asset-server per-asset errors)', () => {
  const dns =
    'Request error: reqwest::Error { kind: Request, url: Url { scheme: "https", host: Some(Domain("worlds-content-server.decentraland.org")), path: "/contents/bafy" }, source: hyper::Error(Connect, ConnectError("dns error", Custom { kind: Uncategorized, error: "failed to lookup address information: Temporary failure in name resolution" })) }'
  const unreachable =
    'Request error: reqwest::Error { kind: Request, url: Url { scheme: "https" }, source: hyper::Error(Connect, ConnectError("tcp connect error", Os { code: 101, kind: NetworkUnreachable, message: "Network is unreachable" })) }'

  it.each([
    ['dns', dns],
    ['unreachable', unreachable],
    ['timeout', 'Request error: reqwest::Error { kind: Request, url: Url {}, source: TimedOut }'],
    [
      'connect timeout',
      'ConnectError("tcp connect error", Os { code: 110, kind: TimedOut, message: "Connection timed out" })'
    ],
    ['5xx', 'Request error: reqwest::Error { kind: Status(503), url: Url {} }'],
    ['body', 'Request error: reqwest::Error { kind: Body, source: hyper::Error(IncompleteMessage) }']
  ])('%s is transient', (_name, message) => {
    expect(isTransientAssetError(message)).toBe(true)
  })

  it.each([
    ['missing deps', 'There are some missing dependencies in the gltf'],
    ['gltf-transform', 'gltf-transform failed (exit code Some(1)):\nstderr: Could not load the "sharp" module'],
    ['parse', 'Error loading gltf: ERR_PARSE_ERROR'],
    ['404', 'Request error: reqwest::Error { kind: Status(404), url: Url {} }'],
    ['empty texture', 'Empty texture data'],
    ['bad json', 'EOF while parsing a value at line 1 column 0'],
    ['bake timeout', 'gltf-transform failed: process timed out after 600s']
  ])('%s is permanent', (_name, message) => {
    expect(isTransientAssetError(message)).toBe(false)
  })

  it('handles missing messages', () => {
    expect(isTransientAssetError(undefined)).toBe(false)
    expect(isTransientAssetError('')).toBe(false)
  })
})

describe('isTransientHttpStatus', () => {
  it('flags retryable statuses only', () => {
    expect([408, 429, 500, 502, 503, 504].every(isTransientHttpStatus)).toBe(true)
    expect([200, 400, 401, 403, 404, 422].some(isTransientHttpStatus)).toBe(false)
  })
})

describe('isPermanentStorageError (AWS SDK / fs errors)', () => {
  it('flags local file and auth errors as permanent', () => {
    expect(isPermanentStorageError(Object.assign(new Error('no such file'), { code: 'ENOENT' }))).toBe(true)
    expect(
      isPermanentStorageError(
        Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })
      )
    ).toBe(true)
    expect(
      isPermanentStorageError(Object.assign(new Error('bad request'), { $metadata: { httpStatusCode: 400 } }))
    ).toBe(true)
  })

  it('keeps network and server errors retryable', () => {
    expect(isPermanentStorageError(Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }))).toBe(
      false
    )
    expect(
      isPermanentStorageError(
        Object.assign(new Error('slow down'), { $metadata: { httpStatusCode: 503 }, $retryable: { throttling: true } })
      )
    ).toBe(false)
    expect(isPermanentStorageError(Object.assign(new Error('throttled'), { $metadata: { httpStatusCode: 429 } }))).toBe(
      false
    )
    expect(isPermanentStorageError(new Error('socket hang up'))).toBe(false)
  })
})

describe('ContentError', () => {
  it('is the only failure that acknowledges a job, and is never transient', () => {
    const error = new ContentError('broken glTF')
    expect(isContentError(error)).toBe(true)
    expect(isTransientError(error)).toBe(false)
    expect(isContentError(new Error('No main ZIP file created'))).toBe(false)
    expect(isContentError(new TransientError('ECONNRESET'))).toBe(false)
  })

  it('blames the content only when the content server says the file is not there', () => {
    expect(contentDownloadError('x', 404)).toBeInstanceOf(ContentError)
    expect(contentDownloadError('x', 410)).toBeInstanceOf(ContentError)
    for (const status of [403, 429, 500, 503]) expect(contentDownloadError('x', status)).toBeInstanceOf(TransientError)
  })
})

describe('infrastructure faults', () => {
  it.each([
    ['AccessDenied', 403],
    ['NoSuchBucket', 404],
    ['InvalidAccessKeyId', 403],
    ['SignatureDoesNotMatch', 403],
    ['KMS.DisabledException', 400],
    ['PermanentRedirect', 301]
  ])('recognises the S3 %s rejection as a storage configuration error', (name, httpStatusCode) => {
    expect(isStorageConfigError(Object.assign(new Error(name), { name, $metadata: { httpStatusCode } }))).toBe(true)
  })

  it('does not take a server error or a missing local file for a storage configuration error', () => {
    expect(isStorageConfigError(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 503 } }))).toBe(false)
    expect(isStorageConfigError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false)
  })

  it.each(['ENOSPC', 'EMFILE', 'ENFILE', 'ENOMEM'])('treats a task out of resources (%s) as transient', (code) => {
    expect(isTransientError(Object.assign(new Error(`${code}: out of resources`), { code }))).toBe(true)
  })
})
