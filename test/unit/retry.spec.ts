import { backoffDelayMs, retryWithBackoff } from '../../src/logic/retry'

const instant = { sleep: async () => {}, random: () => 0 }

describe('backoffDelayMs', () => {
  it('doubles per attempt and caps at maxDelayMs', () => {
    const options = { baseDelayMs: 1000, maxDelayMs: 5000, random: () => 0 }
    expect(backoffDelayMs(1, options)).toBe(1000)
    expect(backoffDelayMs(2, options)).toBe(2000)
    expect(backoffDelayMs(3, options)).toBe(4000)
    expect(backoffDelayMs(4, options)).toBe(5000)
    expect(backoffDelayMs(10, options)).toBe(5000)
  })

  it('adds up to `jitter` of the delay', () => {
    const options = { baseDelayMs: 1000, maxDelayMs: 60000, jitter: 0.5 }
    expect(backoffDelayMs(1, { ...options, random: () => 1 })).toBe(1500)
    expect(backoffDelayMs(1, { ...options, random: () => 0.5 })).toBe(1250)
    expect(backoffDelayMs(1, { ...options, jitter: 0, random: () => 1 })).toBe(1000)
  })
})

describe('retryWithBackoff', () => {
  it('returns the first successful result and stops', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValue('ok')
    const onRetry = jest.fn()
    await expect(
      retryWithBackoff(fn, { attempts: 5, baseDelayMs: 10, maxDelayMs: 100, onRetry, ...instant })
    ).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(fn.mock.calls.map((call) => call[0])).toEqual([1, 2, 3])
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0][2]).toBe(10)
    expect(onRetry.mock.calls[1][2]).toBe(20)
  })

  it('throws the last error after the attempts are exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('still down'))
    const sleep = jest.fn(async (_ms: number) => {})
    await expect(
      retryWithBackoff(fn, { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep, random: () => 0 })
    ).rejects.toThrow('still down')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([10, 20])
  })

  it('stops early when shouldRetry says the error is permanent', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('404'))
    await expect(
      retryWithBackoff(fn, { attempts: 5, baseDelayMs: 1, maxDelayMs: 1, shouldRetry: () => false, ...instant })
    ).rejects.toThrow('404')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-positive attempts count', async () => {
    await expect(retryWithBackoff(async () => 1, { attempts: 0, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow(
      'attempts must be a positive integer'
    )
  })
})
