import { IBaseComponent } from '@well-known-components/interfaces'
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { createReadStream } from 'fs'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import path from 'path'
import { AppComponents } from '../types'
import { AwsCredentialIdentity } from '@smithy/types'
import { retryWithBackoff, RetryOptions } from '../logic/retry'
import { TransientError, isPermanentStorageError, isPermanentSystemError } from '../logic/transient-error'

/**
 * Strict uploads retry with exponential backoff: a DNS or uplink blip that
 * lasts a few seconds must not fail a bake that took minutes. Five attempts
 * spread over roughly a minute (2 s, 4 s, 8 s, 16 s + jitter), on top of the
 * SDK's own per-request retries.
 */
export const UPLOAD_RETRY_DEFAULTS: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs'> = {
  attempts: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000
}

export type UploadRetryOptions = Partial<
  Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs' | 'sleep' | 'random'>
>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type IStorageComponent = IBaseComponent & {
  /** Best-effort upload: logs and swallows failures (per-entity reports). */
  storeFile(key: string, filePath: string, contentType?: string): Promise<void>
  /**
   * Upload that must land: retries with backoff, then throws a
   * `TransientError` so the caller fails the job (and the queue retries it)
   * instead of publishing a scene with a missing dependency. A rejection a
   * retry cannot fix right away (access denied, missing bucket, any other
   * 4xx) is not retried in-process but is still a `TransientError`: it is an
   * infrastructure fault, never a reason to drop the job. Only a local file
   * error (the file to upload is missing or unreadable) is rethrown as-is.
   * `contentType` is stored on the object — the CDN compresses text types
   * (`application/javascript`, `application/json`) on the fly.
   */
  storeFileStrict(key: string, filePath: string, contentType?: string): Promise<void>
  storeFiles(files: { key: string; filePath: string }[]): Promise<void>
  /**
   * Whether an object is already published under `key` (prefix applied).
   * Never throws: an error is logged and reported as `false`, so the caller
   * bakes instead of skipping.
   */
  exists(key: string): Promise<boolean>
}

export async function createS3StorageComponent(
  bucketName: string,
  prefix: string | undefined = undefined,
  endpoint: string | undefined = undefined,
  credentials: AwsCredentialIdentity | undefined = undefined,
  region: string,
  components: Pick<AppComponents, 'logs'>,
  retryOptions: UploadRetryOptions = {}
): Promise<IStorageComponent> {
  const s3Client = new S3Client({
    endpoint,
    // Path-style addressing only for a custom endpoint (LocalStack, MinIO);
    // AWS S3 uses virtual-hosted-style URLs.
    forcePathStyle: endpoint !== undefined,
    // S3-compatible emulators reject the SDK's default flexible checksums on
    // multipart uploads (BadRequest), so send them only when an operation
    // requires one. AWS S3 keeps the SDK defaults.
    ...(endpoint !== undefined
      ? { requestChecksumCalculation: 'WHEN_REQUIRED' as const, responseChecksumValidation: 'WHEN_REQUIRED' as const }
      : {}),
    credentials,
    region
  })
  const logger = components.logs.getLogger('s3-storage')
  const formattedPrefix = prefix ? `${prefix}/` : ''
  const retry: RetryOptions = { ...UPLOAD_RETRY_DEFAULTS, ...retryOptions }

  // One streaming PutObject (no whole-file buffering). Throws on failure.
  async function putOnce(keyWithPrefix: string, filePath: string, contentType?: string) {
    const fileStream = createReadStream(filePath)
    try {
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: bucketName,
          Key: keyWithPrefix,
          Body: fileStream,
          ...(contentType ? { ContentType: contentType } : {})
        }
      })
      await upload.done()
    } finally {
      fileStream.destroy()
    }
  }

  // Retries with backoff, then throws a TransientError carrying the last
  // cause. A storage rejection (bad credentials, missing bucket, 4xx) is not
  // retried here but is still transient for the job; only a local file error
  // is rethrown as-is.
  async function putWithRetry(keyWithPrefix: string, filePath: string, contentType?: string) {
    try {
      await retryWithBackoff(() => putOnce(keyWithPrefix, filePath, contentType), {
        ...retry,
        shouldRetry: (error) => !isPermanentStorageError(error),
        onRetry: (error, attempt, delayMs) =>
          logger.warn(
            `Attempt ${attempt}/${retry.attempts} failed for file ${keyWithPrefix} (${errorMessage(error)}); retrying in ${delayMs} ms`
          )
      })
      logger.info(`Successfully stored file ${keyWithPrefix} in S3`)
    } catch (error) {
      if (isPermanentSystemError((error as { code?: unknown })?.code)) {
        logger.error(`Failed to store file ${keyWithPrefix}: ${errorMessage(error)} (local file error)`)
        throw error
      }
      if (isPermanentStorageError(error)) {
        logger.error(
          `Storage rejected file ${keyWithPrefix}: ${errorMessage(error)}; check the bucket, the task role and the KMS key`
        )
        throw new TransientError(`Storage rejected file ${keyWithPrefix}: ${errorMessage(error)}`, { cause: error })
      }
      logger.error(`Failed to store file ${keyWithPrefix} after ${retry.attempts} attempts`)
      logger.error(error as any)
      throw new TransientError(
        `Failed to store file ${keyWithPrefix} after ${retry.attempts} attempts: ${errorMessage(error)}`,
        { cause: error }
      )
    }
  }

  return {
    storeFile: async function (key: string, filePath: string, contentType?: string) {
      const keyWithPrefix = `${formattedPrefix}${key}`
      try {
        await putOnce(keyWithPrefix, filePath, contentType)
        logger.info(`Stored file ${keyWithPrefix} in S3`)
      } catch (error) {
        logger.error(`Error storing file ${keyWithPrefix} in S3`)
        logger.error(error as any)
      }
    },

    storeFileStrict: async function (key: string, filePath: string, contentType?: string) {
      await putWithRetry(`${formattedPrefix}${key}`, filePath, contentType)
    },

    storeFiles: async function (files: { key: string; filePath: string }[]) {
      for (const { key, filePath } of files) {
        await putWithRetry(`${formattedPrefix}${key}`, filePath)
      }
      logger.info(`Successfully stored all ${files.length} files in S3`)
    },

    exists: async function (key: string) {
      const keyWithPrefix = `${formattedPrefix}${key}`
      try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: keyWithPrefix }))
        return true
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
        if (status === 404 || (error as { name?: unknown })?.name === 'NotFound') return false
        logger.warn(`Could not check whether ${keyWithPrefix} exists: ${errorMessage(error)}`)
        return false
      }
    }
  }
}

export function createLocalStorageComponent(
  baseDir: string,
  components: Pick<AppComponents, 'logs'>
): IStorageComponent {
  const logger = components.logs.getLogger('local-storage')
  return {
    storeFile: async function (key: string, filePath: string) {
      try {
        const fileContent = await readFile(filePath)
        const dirName = path.dirname(path.join(baseDir, key))
        await mkdir(dirName, { recursive: true })
        await writeFile(path.join(baseDir, key), fileContent)
        logger.info(`Stored file ${key} in local storage`)
      } catch (error) {
        logger.error(`Error storing file ${key} in local storage`)
        logger.error(error as any)
      }
    },

    storeFileStrict: async function (key: string, filePath: string) {
      const fileContent = await readFile(filePath)
      const dirName = path.dirname(path.join(baseDir, key))
      await mkdir(dirName, { recursive: true })
      await writeFile(path.join(baseDir, key), fileContent)
      logger.info(`Stored file ${key} in local storage`)
    },

    storeFiles: async function (files: { key: string; filePath: string }[]) {
      for (const { key, filePath } of files) {
        await this.storeFile(key, filePath)
      }
    },

    exists: async function (key: string) {
      try {
        return (await stat(path.join(baseDir, key))).isFile()
      } catch {
        return false
      }
    }
  }
}
