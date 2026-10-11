// Local one-off modes, run from the command line instead of the queue:
//   --entityId <id | pointer x,y | name.dcl.eth>  bake one entity through the in-memory queue
//   --profile <address>                           bake every wearable/emote a profile wears, then exit
import { rm } from 'fs/promises'
import { DEFAULT_ASSET_SERVER_TIMEOUT_MS } from './adapters/asset-server'
import { getCatalystUrl, getDefaultContentServerUrl, getWorldsContentServerUrl } from './logic/content-server'
import { buildDeploymentMessage, isValidEntityId } from './logic/deployment-message'
import { contentTypeFor, objectKeyFor } from './runners/godot-optimizer/publish'
import { AppComponents } from './types'

// Helper function to convert URN with token ID to pointer without token ID
function urnToPointer(urn: string): string {
  const parts = urn.split(':')
  // collections-v2 URNs: urn:decentraland:NETWORK:collections-v2:CONTRACT:ITEM_ID[:TOKEN_ID]
  // We need to keep only up to ITEM_ID (6 parts)
  if (urn.includes('collections-v2') && parts.length > 6) {
    return parts.slice(0, 6).join(':')
  }
  return urn
}

type GltfAsset = {
  gltfHash: string
  gltfFile: string
  entityType: 'wearable' | 'emote'
  contentMapping: Record<string, string>
  pointer: string
}

// Helper function to handle profile - processes all wearables and emotes in parallel
export async function handleProfile(
  profileAddress: string,
  components: Pick<AppComponents, 'fetch' | 'logs' | 'storage' | 'assetServer' | 'config'>
) {
  const { fetch, logs, storage, assetServer, config } = components
  const logger = logs.getLogger('profile-handler')
  const catalystUrl = await getCatalystUrl(config)
  const contentServer = `${catalystUrl}/content`
  const contentBaseUrl = `${contentServer}/contents/`

  try {
    // Profile mode runs before the consume loop, so nothing has started Godot yet
    if (!(await assetServer.isReady()) && !(await assetServer.restartGodot())) {
      logger.error('Asset-server could not be started')
      return
    }

    const concurrentLimit = parseInt((await config.getString('ASSET_SERVER_CONCURRENT_BUNDLES')) || '16', 10)
    const timeoutMs = parseInt(
      (await config.getString('ASSET_SERVER_TIMEOUT_MS')) || String(DEFAULT_ASSET_SERVER_TIMEOUT_MS),
      10
    )

    // 1. Fetch profile from lambdas
    const profileUrl = `${catalystUrl}/lambdas/profiles/${profileAddress}`
    logger.info(`Fetching profile from ${profileUrl}`)

    const profileResponse = await fetch.fetch(profileUrl)
    if (!profileResponse.ok) {
      // Consume body to free the connection
      await profileResponse.text().catch(() => {})
      throw new Error(`Failed to fetch profile: ${profileResponse.statusText}`)
    }

    const profileData = await profileResponse.json()
    const avatars = profileData.avatars || []

    if (avatars.length === 0) {
      logger.error('No avatars found in profile')
      return
    }

    const avatar = avatars[0].avatar
    const wearablesRaw: string[] = avatar?.wearables || []
    const emotesRaw: Array<{ urn: string; slot: number }> = avatar?.emotes || []

    // 2. Convert to pointers (strip token ID) and deduplicate
    const wearablePointers = new Set<string>()
    for (const urn of wearablesRaw) {
      if (!urn.includes('base-avatars')) {
        wearablePointers.add(urnToPointer(urn))
      }
    }

    const emotePointers = new Set<string>()
    for (const emote of emotesRaw) {
      const urn = emote.urn
      if (urn && urn.includes(':') && !urn.includes('base-emotes')) {
        emotePointers.add(urnToPointer(urn))
      }
    }

    logger.info(`Found ${wearablePointers.size} wearables and ${emotePointers.size} emotes (excluding base)`)

    // 3. Fetch all entities in batch
    const allPointers = [...wearablePointers, ...emotePointers]
    if (allPointers.length === 0) {
      logger.info('No custom wearables or emotes to process')
      return
    }

    logger.info(`Fetching ${allPointers.length} entities from content server...`)
    const entitiesResponse = await fetch.fetch(`${contentServer}/entities/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointers: allPointers })
    })

    if (!entitiesResponse.ok) {
      // Consume body to free the connection
      await entitiesResponse.text().catch(() => {})
      throw new Error(`Failed to fetch entities: ${entitiesResponse.statusText}`)
    }

    const entities = (await entitiesResponse.json()) as Array<{
      id: string
      pointers: string[]
      content: Array<{ file: string; hash: string }>
    }>

    logger.info(`Retrieved ${entities.length} entities`)

    // 4. Build pointer -> entity type map
    const pointerToType = new Map<string, 'wearable' | 'emote'>()
    for (const p of wearablePointers) pointerToType.set(p, 'wearable')
    for (const p of emotePointers) pointerToType.set(p, 'emote')

    // 5. Collect all GLTF assets to process
    const gltfAssets: GltfAsset[] = []

    for (const entity of entities) {
      const pointer = entity.pointers[0]
      const entityType = pointerToType.get(pointer) || 'wearable'

      const gltfFiles = entity.content.filter(
        (c) => c.file.toLowerCase().endsWith('.glb') || c.file.toLowerCase().endsWith('.gltf')
      )

      if (gltfFiles.length === 0) {
        logger.warn(`No GLTF found in entity ${entity.id}, skipping`)
        continue
      }

      const contentMapping: Record<string, string> = {}
      for (const content of entity.content) {
        contentMapping[content.file] = content.hash
      }

      for (const gltf of gltfFiles) {
        gltfAssets.push({
          gltfHash: gltf.hash,
          gltfFile: gltf.file,
          entityType,
          contentMapping,
          pointer
        })
      }
    }

    logger.info(`Processing ${gltfAssets.length} GLTFs in parallel (concurrency: ${concurrentLimit})`)

    // 6. Process in parallel batches
    let successful = 0
    let failed = 0
    const startTime = Date.now()

    for (let i = 0; i < gltfAssets.length; i += concurrentLimit) {
      const batch = gltfAssets.slice(i, i + concurrentLimit)

      logger.info(
        `Processing batch ${Math.floor(i / concurrentLimit) + 1}/${Math.ceil(gltfAssets.length / concurrentLimit)} (${batch.length} assets)`
      )

      const batchPromises = batch.map(async (asset) => {
        const variant = asset.gltfFile.toLowerCase().includes('male/')
          ? '(male)'
          : asset.gltfFile.toLowerCase().includes('female/')
            ? '(female)'
            : ''

        try {
          // Submit to asset-server
          const response = await assetServer.processAssets({
            outputHash: asset.gltfHash,
            assets: [
              {
                url: `${contentBaseUrl}${asset.gltfHash}`,
                type: asset.entityType,
                hash: asset.gltfHash,
                base_url: contentBaseUrl,
                content_mapping: asset.contentMapping
              }
            ]
          })

          // Wait for completion
          const result = await assetServer.waitForCompletion(response.batch_id, timeoutMs)

          if (result.status === 'completed' && result.zip_path) {
            const s3Key = objectKeyFor(result.zip_path)
            await storage.storeFileStrict(s3Key, result.zip_path, contentTypeFor(s3Key))
            // Clean up temp file from asset-server
            await rm(result.zip_path, { force: true }).catch(() => {})
            logger.info(`Completed: ${asset.pointer} ${variant} -> ${s3Key}`)
            return { success: true, hash: asset.gltfHash }
          } else {
            logger.error(`Failed: ${asset.pointer} ${variant}: ${result.error || 'Unknown error'}`)
            return { success: false, hash: asset.gltfHash, error: result.error }
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          logger.error(`Error: ${asset.pointer} ${variant}: ${errorMsg}`)
          return { success: false, hash: asset.gltfHash, error: errorMsg }
        }
      })

      const results = await Promise.all(batchPromises)

      for (const r of results) {
        if (r.success) {
          successful++
        } else {
          failed++
        }
      }
    }

    const elapsedSecs = ((Date.now() - startTime) / 1000).toFixed(1)
    logger.info(`Profile processing complete in ${elapsedSecs}s: ${successful} successful, ${failed} failed`)
  } catch (error) {
    logger.error(`Error processing profile: ${error}`)
  }
}

// Helper function to handle entityId logic
export async function handleEntityId(
  entityId: string,
  components: Pick<AppComponents, 'fetch' | 'logs' | 'taskQueue' | 'config'>
) {
  const { fetch, logs, taskQueue, config } = components
  const contentServer = await getDefaultContentServerUrl(config)
  const worldsContentServer = await getWorldsContentServerUrl(config)
  if (entityId.includes(',')) {
    try {
      const response = await fetch.fetch(`${contentServer}/entities/active`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ pointers: [entityId] })
      })

      if (!response.ok) {
        // Consume body to free the connection
        await response.text().catch(() => {})
        throw new Error(`Failed to fetch entity ID: ${response.statusText}`)
      }

      const data = await response.json()
      const ids = data.map((entity: { id: string }) => entity.id)

      if (ids.length > 0) {
        entityId = ids[0] // Use the first ID as the entityId
        logs.getLogger('main').log(`Resolved Entity ID from pointer: ${entityId}`)
        await taskQueue.publish(buildDeploymentMessage(entityId, { contentServerUrl: contentServer, force: true }))
      } else {
        logs.getLogger('main').error('Error: No entity ID found for the given pointer')
      }
    } catch (error) {
      logs.getLogger('main').error(`Error resolving entity ID from pointer: ${error}`)
    }
  } else if (entityId.endsWith('.dcl.eth')) {
    try {
      const response = await fetch.fetch(`${worldsContentServer}/world/${entityId}/about`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        // Consume body to free the connection
        await response.text().catch(() => {})
        throw new Error(`Failed to fetch world data: ${response.statusText}`)
      }

      const data = await response.json()
      const urn = data.configurations?.scenesUrn?.[0]
      if (urn) {
        const urnParts = urn.split(':')
        entityId = urnParts[3].split('?')[0] // Extract the entityId
        let baseUrl = urn.split('baseUrl=')[1] // Extract the baseUrl
        baseUrl = baseUrl.replace(/\/contents\/?$/, '') // Remove trailing /contents or /contents/
        logs.getLogger('main').log(`Resolved Entity ID: ${entityId}, Base URL: ${baseUrl}`)

        // Publish the resolved entityId and baseUrl
        await taskQueue.publish(buildDeploymentMessage(entityId, { contentServerUrl: baseUrl, force: true }))
      } else {
        logs.getLogger('main').error('Error: No URN found in world data')
      }
    } catch (error) {
      logs.getLogger('main').error(`Error resolving entity ID from .dcl.eth domain: ${error}`)
    }
  } else if (!isValidEntityId(entityId)) {
    logs.getLogger('main').error(`Error: ${entityId} is not an entity id, a pointer (x,y) or a <name>.dcl.eth world`)
  } else {
    // Publish the resolved or provided entityId (a one-off always bakes, even if already published)
    logs.getLogger('main').log(`Scheduled Entity ID: ${entityId}`)
    await taskQueue.publish(buildDeploymentMessage(entityId, { contentServerUrl: contentServer, force: true }))
  }
}
