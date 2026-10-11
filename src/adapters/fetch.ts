import { IFetchComponent } from '@well-known-components/http-server'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import * as nodeFetch from 'node-fetch'
import http from 'http'
import https from 'https'

// Create HTTP agents with limited connection pooling to prevent memory leaks
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 60000
})

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 60000
})

// Error codes that indicate transient network failures
const RETRYABLE_ERROR_CODES = new Set([
  'ENOTFOUND', // DNS resolution failure
  'ETIMEDOUT', // Connection timeout
  'ECONNRESET', // Connection reset
  'ECONNREFUSED', // Connection refused
  'EPIPE', // Broken pipe
  'ENETUNREACH', // Network unreachable
  'EHOSTUNREACH', // Host unreachable
  'EAI_AGAIN' // DNS temporary failure
])

// HTTP status codes that indicate transient server failures
const RETRYABLE_HTTP_STATUS = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504 // Gateway Timeout
])

interface FetchConfig {
  maxRetries: number
  initialDelayMs: number
  maxDelayMs: number
  timeoutMs: number
  backoffMultiplier: number
}

function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    return RETRYABLE_ERROR_CODES.has((error as { code: string }).code)
  }
  return false
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUS.has(status)
}

function calculateDelay(attempt: number, config: FetchConfig): number {
  // Exponential backoff: initialDelay * (multiplier ^ attempt)
  const exponentialDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt)
  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs)
  // Add jitter (0-25% of delay)
  const jitter = cappedDelay * Math.random() * 0.25
  return Math.floor(cappedDelay + jitter)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function createFetchComponent(deps?: {
  config?: IConfigComponent
  logs?: ILoggerComponent
}): Promise<IFetchComponent> {
  const config = deps?.config
  const logger = deps?.logs?.getLogger('fetch')

  // Load configuration with defaults
  const fetchConfig: FetchConfig = {
    maxRetries: parseInt((await config?.getString('FETCH_MAX_RETRIES')) || '3', 10),
    initialDelayMs: parseInt((await config?.getString('FETCH_INITIAL_DELAY_MS')) || '1000', 10),
    maxDelayMs: parseInt((await config?.getString('FETCH_MAX_DELAY_MS')) || '30000', 10),
    timeoutMs: parseInt((await config?.getString('FETCH_TIMEOUT_MS')) || '60000', 10),
    backoffMultiplier: parseFloat((await config?.getString('FETCH_BACKOFF_MULTIPLIER')) || '2')
  }

  const fetchComponent: IFetchComponent = {
    async fetch(url: nodeFetch.RequestInfo, init?: nodeFetch.RequestInit): Promise<nodeFetch.Response> {
      const urlString = typeof url === 'string' ? url : String(url)
      let lastError: Error | undefined

      for (let attempt = 0; attempt <= fetchConfig.maxRetries; attempt++) {
        // Create AbortController for timeout
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), fetchConfig.timeoutMs)

        try {
          // Select appropriate agent based on protocol
          const isHttps = urlString.startsWith('https')
          const agent = isHttps ? httpsAgent : httpAgent

          // Merge abort signal and agent with any existing options
          const mergedInit: nodeFetch.RequestInit = {
            ...init,
            signal: controller.signal as nodeFetch.RequestInit['signal'],
            agent
          }

          const response = await nodeFetch.default(url, mergedInit)
          clearTimeout(timeoutId)

          // Check for retryable HTTP status
          if (isRetryableStatus(response.status) && attempt < fetchConfig.maxRetries) {
            // Consume and discard the response body to free up the connection
            try {
              await response.text()
            } catch {
              // Ignore errors when consuming body
            }
            const delay = calculateDelay(attempt, fetchConfig)
            logger?.warn(
              `Retryable HTTP status ${response.status} for ${urlString}, attempt ${attempt + 1}/${fetchConfig.maxRetries + 1}, retrying in ${delay}ms`
            )
            await sleep(delay)
            continue
          }

          return response
        } catch (error) {
          clearTimeout(timeoutId)
          lastError = error instanceof Error ? error : new Error(String(error))

          // Check if error is retryable
          const isAbortError = lastError.name === 'AbortError'
          const isNetworkError = isRetryableError(error)

          if ((isAbortError || isNetworkError) && attempt < fetchConfig.maxRetries) {
            const errorCode = isAbortError ? 'TIMEOUT' : ((error as { code?: string }).code ?? 'UNKNOWN')
            const delay = calculateDelay(attempt, fetchConfig)
            logger?.warn(
              `Network error ${errorCode} for ${urlString}, attempt ${attempt + 1}/${fetchConfig.maxRetries + 1}, retrying in ${delay}ms`
            )
            await sleep(delay)
            continue
          }

          // Not retryable or retries exhausted
          throw lastError
        }
      }

      // Should not reach here, but throw last error if we do
      throw lastError ?? new Error(`Fetch failed for ${urlString} after ${fetchConfig.maxRetries} retries`)
    }
  }

  return fetchComponent
}
