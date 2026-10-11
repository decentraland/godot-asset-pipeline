import { Router } from '@well-known-components/http-server'
import { GlobalContext } from '../types'
import { contentProxyHandler } from './handlers/content-proxy'
import { pingHandler } from './handlers/ping-handler'

// /health/live (+ /health/ready, /health/startup) and /metrics are registered
// by the status-check and metrics components (components.ts).
export async function setupRouter(_globalContext: GlobalContext): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>()

  router.get('/ping', pingHandler)
  // Filtered entity view for the asset server's retry pass (adapters/content-proxy.ts)
  router.get('/content-proxy/:entityId/contents/:hash', contentProxyHandler)

  return router
}
