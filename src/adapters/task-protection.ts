import type { ILoggerComponent } from '@well-known-components/interfaces'

// ECS task scale-in protection. While a bake runs, the task asks its ECS
// agent not to be picked for scale-in; a 90-minute bake cannot finish inside
// the stop timeout. Outside ECS (no ECS_AGENT_URI) every call is a no-op.
// Failures are logged and never fatal: the worst case is a scale-in mid-bake,
// and the released message is redelivered to another task.
// https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection-endpoint.html

export interface ITaskProtection {
  enable(): Promise<void>
  disable(): Promise<void>
}

// The agent caps ExpiresInMinutes at 48 h
export const MAX_PROTECTION_MINUTES = 2_880
// Added on top of the bake budget to cover downloads and uploads
export const PROTECTION_MARGIN_MINUTES = 30

const REQUEST_TIMEOUT_MS = 5_000

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export type TaskProtectionOptions = {
  // ECS_AGENT_URI, injected by ECS into every task container
  agentUri: string | undefined
  // How long a protection lasts if it is never disabled (the process died)
  expiresInMinutes: number
  // Test hook
  fetch?: FetchLike
}

/** Protection lifetime for a bake budget: the budget plus a margin, within the agent's cap. */
export function protectionMinutesFor(bakeBudgetMs: number): number {
  const minutes = Math.ceil(bakeBudgetMs / 60_000) + PROTECTION_MARGIN_MINUTES
  return Math.max(1, Math.min(minutes, MAX_PROTECTION_MINUTES))
}

export function createTaskProtection(
  components: { logs: ILoggerComponent },
  options: TaskProtectionOptions
): ITaskProtection {
  const logger = components.logs.getLogger('task-protection')
  const agentUri = options.agentUri?.replace(/\/+$/, '')
  if (!agentUri) {
    return { async enable() {}, async disable() {} }
  }

  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const url = `${agentUri}/task-protection/v1/state`

  async function setProtection(body: { ProtectionEnabled: boolean; ExpiresInMinutes?: number }): Promise<void> {
    try {
      const response = await doFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      const text = await response.text().catch(() => '')
      // The agent answers 200 with a `failure` object when ECS refused the change
      if (!response.ok || text.includes('"failure"')) {
        logger.warn(`Task protection update rejected (HTTP ${response.status}): ${text}`, {
          protectionEnabled: String(body.ProtectionEnabled)
        })
        return
      }
      logger.debug('Task protection updated', { protectionEnabled: String(body.ProtectionEnabled) })
    } catch (err) {
      logger.warn(`Task protection update failed: ${err instanceof Error ? err.message : String(err)}`, {
        protectionEnabled: String(body.ProtectionEnabled)
      })
    }
  }

  return {
    async enable() {
      await setProtection({ ProtectionEnabled: true, ExpiresInMinutes: options.expiresInMinutes })
    },
    async disable() {
      await setProtection({ ProtectionEnabled: false })
    }
  }
}
