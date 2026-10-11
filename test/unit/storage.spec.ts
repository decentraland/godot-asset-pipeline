import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { createLocalStorageComponent, createS3StorageComponent } from '../../src/adapters/storage'
import { TransientError, isTransientError } from '../../src/logic/transient-error'

const uploadDone = jest.fn()
const s3Send = jest.fn()
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: s3Send })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input }))
}))
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({ done: uploadDone }))
}))

function stubLogs() {
  const logger = { log: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() }
  return { logs: { getLogger: () => logger }, logger }
}

describe('S3 storage strict uploads', () => {
  let dir: string
  let filePath: string
  const instant = { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'storage-spec-'))
    filePath = path.join(dir, 'file.zip')
    await writeFile(filePath, 'zip')
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))
  beforeEach(() => uploadDone.mockReset())

  it('retries a failed upload and succeeds', async () => {
    uploadDone.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo EAI_AGAIN s3'), { code: 'EAI_AGAIN' }))
    uploadDone.mockResolvedValue({})
    const { logs, logger } = stubLogs()
    const storage = await createS3StorageComponent('bucket', 'v6', undefined, undefined, 'auto', { logs }, instant)

    await expect(storage.storeFileStrict('scene.zip', filePath, 'application/zip')).resolves.toBeUndefined()
    expect(uploadDone).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Attempt 1\/3 failed for file v6\/scene.zip \(getaddrinfo EAI_AGAIN s3\)/)
    )
  })

  it('throws a TransientError carrying the cause once attempts are exhausted', async () => {
    const cause = Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' })
    uploadDone.mockRejectedValue(cause)
    const { logs } = stubLogs()
    const storage = await createS3StorageComponent('bucket', 'v6', undefined, undefined, 'auto', { logs }, instant)

    const error = await storage.storeFileStrict('scene.zip', filePath).catch((e) => e)
    expect(error).toBeInstanceOf(TransientError)
    expect(error.message).toBe('Failed to store file v6/scene.zip after 3 attempts: connect ENETUNREACH')
    expect(error.cause).toBe(cause)
    expect(uploadDone).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['AccessDenied', 403],
    ['NoSuchBucket', 404],
    ['InvalidAccessKeyId', 403],
    ['KMS.DisabledException', 400]
  ])(
    'does not retry a %s rejection in-process but fails the job transiently (infrastructure, not content)',
    async (name, httpStatusCode) => {
      const denied = Object.assign(new Error(name), { name, $metadata: { httpStatusCode } })
      uploadDone.mockRejectedValue(denied)
      const { logs } = stubLogs()
      const storage = await createS3StorageComponent('bucket', 'v6', undefined, undefined, 'auto', { logs }, instant)

      const error = await storage.storeFileStrict('scene.zip', filePath).catch((e) => e)
      expect(error).toBeInstanceOf(TransientError)
      expect(error.cause).toBe(denied)
      expect(isTransientError(error)).toBe(true)
      expect(uploadDone).toHaveBeenCalledTimes(1)
    }
  )

  it('rethrows a local file error untouched', async () => {
    const { logs } = stubLogs()
    const storage = await createS3StorageComponent('bucket', 'v6', undefined, undefined, 'auto', { logs }, instant)
    uploadDone.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    })

    const error = await storage.storeFileStrict('scene.zip', filePath).catch((e) => e)
    expect(error).not.toBeInstanceOf(TransientError)
    expect(error.code).toBe('ENOENT')
    expect(uploadDone).toHaveBeenCalledTimes(1)
  })

  it('storeFile stays best-effort (logs, never throws)', async () => {
    uploadDone.mockRejectedValue(new Error('down'))
    const { logs, logger } = stubLogs()
    const storage = await createS3StorageComponent('bucket', undefined, undefined, undefined, 'auto', { logs }, instant)

    await expect(storage.storeFile('report.json', filePath)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith('Error storing file report.json in S3')
  })
})

describe('storage exists', () => {
  beforeEach(() => s3Send.mockReset())

  it('HEADs the prefixed key on S3', async () => {
    s3Send.mockResolvedValueOnce({})
    const storage = await createS3StorageComponent('bucket', 'v6', undefined, undefined, 'auto', stubLogs())
    await expect(storage.exists('bafy-mobile.zip')).resolves.toBe(true)
    expect(s3Send.mock.calls[0][0].input).toEqual({ Bucket: 'bucket', Key: 'v6/bafy-mobile.zip' })
  })

  it('reports a missing object as false', async () => {
    s3Send.mockRejectedValueOnce(
      Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
    )
    const storage = await createS3StorageComponent('bucket', 'v6', undefined, undefined, 'auto', stubLogs())
    await expect(storage.exists('bafy-mobile.zip')).resolves.toBe(false)
  })

  it('never throws: an unexpected error is logged and reported as false (the job bakes)', async () => {
    s3Send.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { $metadata: { httpStatusCode: 403 } }))
    const { logs, logger } = stubLogs()
    const storage = await createS3StorageComponent('bucket', 'v6', undefined, undefined, 'auto', { logs })
    await expect(storage.exists('bafy-mobile.zip')).resolves.toBe(false)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('checks the local directory in local mode', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'storage-exists-'))
    try {
      await writeFile(path.join(dir, 'there.zip'), 'zip')
      const storage = createLocalStorageComponent(dir, stubLogs())
      await expect(storage.exists('there.zip')).resolves.toBe(true)
      await expect(storage.exists('missing.zip')).resolves.toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
