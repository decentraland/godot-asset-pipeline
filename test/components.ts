// This file is the "test-environment" analogous for src/components.ts
// Here we define the test components to be used in the testing environment

import { createServer } from 'net'
import { createRunner, createLocalFetchCompoment } from '@well-known-components/test-helpers'

import { main } from '../src/service'
import { TestComponents } from '../src/types'
import { initComponents as originalInitComponents } from '../src/components'
import { IAssetServerComponent } from '../src/adapters/asset-server'

/**
 * Behaves like Jest "describe" function, used to describe a test for a
 * use case, it creates a whole new program and components to run an
 * isolated test.
 *
 * State is persistent within the steps of the test.
 */
export const test = createRunner<TestComponents>({
  main,
  initComponents
})

// Each test program listens on its own free port: test files run in parallel
// workers, and the default port (5000) can be taken on a dev machine (macOS
// AirPlay Receiver listens there).
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

// No Godot in tests: the consume loop checks (and would restart) the asset
// server before every claim, so it gets a stub that is always ready and fails
// any bake it is asked for.
function stubAssetServer(): IAssetServerComponent {
  const noBake = async (): Promise<never> => {
    throw new Error('no asset server in tests')
  }
  return {
    isReady: async () => true,
    restartGodot: async () => true,
    processScene: noBake,
    processAssets: noBake,
    getBatchStatus: noBake,
    waitForCompletion: noBake,
    getGodotLogs: () => [],
    clearGodotLogs: () => undefined,
    getPanicCount: () => 0
  }
}

async function initComponents(): Promise<TestComponents> {
  process.env.HTTP_SERVER_PORT = String(await freePort())
  const components = await originalInitComponents()

  const { config } = components

  return {
    ...components,
    assetServer: stubAssetServer(),
    localFetch: await createLocalFetchCompoment(config)
  }
}
