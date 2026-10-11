/**
 * Exponential backoff with jitter. Pure: the clock is injectable so tests run
 * instantly and the caller decides what is retryable.
 */

export type RetryOptions = {
  /** Total attempts, including the first one. */
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** Fraction of the delay added as random jitter (0..1). Default 0.25. */
  jitter?: number
  /** Return false to stop retrying and rethrow immediately. Default: retry everything. */
  shouldRetry?: (error: unknown, attempt: number) => boolean
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export const DEFAULT_JITTER = 0.25

export function backoffDelayMs(
  attempt: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'jitter' | 'random'>
): number {
  const exponential = options.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1))
  const capped = Math.min(exponential, options.maxDelayMs)
  const jitter = options.jitter ?? DEFAULT_JITTER
  const random = options.random ?? Math.random
  return Math.round(capped * (1 + jitter * random()))
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Runs `fn` up to `attempts` times. `fn` receives the 1-based attempt number.
 * Throws the last error once attempts are exhausted or `shouldRetry` says no.
 */
export async function retryWithBackoff<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new Error(`retryWithBackoff: attempts must be a positive integer, got ${options.attempts}`)
  }
  const sleep = options.sleep ?? defaultSleep
  let lastError: unknown
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      const retryable = options.shouldRetry ? options.shouldRetry(error, attempt) : true
      if (!retryable || attempt === options.attempts) throw error
      const delayMs = backoffDelayMs(attempt, options)
      options.onRetry?.(error, attempt, delayMs)
      await sleep(delayMs)
    }
  }
  throw lastError
}
