import { IBaseComponent } from '@well-known-components/interfaces'

export type RunnerComponentArg = {
  readonly isRunning: boolean
}

export type IRunnerComponent = IBaseComponent & {
  runTask(delegate: (opt: RunnerComponentArg) => Promise<void>): void
}

export type RunnerOptions = {
  // How long stop() waits for the running loops to return. A loop that is
  // mid-bake cannot finish in time (a bake can take 90 min, ECS stops a task
  // within seconds), and the task queue hands its job back on stop, so the
  // program exits once this grace period is over.
  stopGraceMs?: number
}

export const DEFAULT_STOP_GRACE_MS = 5_000

// Runs loops while the application is enabled. On stop, isRunning turns false
// and stop() waits (up to the grace period) for the loops to return.
export function createRunnerComponent(options: RunnerOptions = {}): IRunnerComponent {
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
  const delegates: Promise<any>[] = []
  let isRunning = false

  return {
    async start() {
      if (isRunning) throw new Error('Cannot run twice')
      isRunning = true
    },
    async stop() {
      isRunning = false
      let timer: NodeJS.Timeout | undefined
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, stopGraceMs)
      })
      try {
        await Promise.race([Promise.allSettled(delegates), grace])
      } finally {
        clearTimeout(timer)
      }
    },
    runTask(delegate) {
      if (!isRunning) throw new Error('You can only run tasks while the component is running')
      delegates.push(
        delegate({
          get isRunning() {
            return isRunning
          }
        })
      )
    }
  }
}
