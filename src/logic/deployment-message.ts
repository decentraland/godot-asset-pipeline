import { AuthLinkType } from '@dcl/schemas/dist/misc/auth-chain'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'

// Turns an SQS message body into the job the optimizer bakes.
//
// Bodies come from three producers:
// - catalyst deployments (`type: 'catalyst-deployment'`, `subType: <entity type>`),
//   with the full entity, including `entityType`
// - world deployments (`type: 'world'`, `subType: 'deployment'`): `entity`
//   has no `entityType`, and a world is always a scene
// - the manual queue CLI (`yarn queue`): a bare DeploymentToSqs
// The queues are subscribed with raw message delivery, but an SNS envelope
// (`{Type: 'Notification', Message: '<json>'}`) is unwrapped too.

export type EntityType = 'scene' | 'wearable' | 'emote'

export const SUPPORTED_ENTITY_TYPES: ReadonlySet<string> = new Set<EntityType>(['scene', 'wearable', 'emote'])

/**
 * Entity ids are content hashes (CIDv1 base32 `bafy...`, legacy `Qm...`). The
 * id ends up in local file paths, S3 keys and content server URLs, so anything
 * else (`../x`, `a/b`) is rejected.
 */
export const ENTITY_ID_PATTERN = /^[a-zA-Z0-9]+$/

export function isValidEntityId(value: string): boolean {
  return ENTITY_ID_PATTERN.test(value)
}

const CATALYST_DEPLOYMENT = 'catalyst-deployment'
const WORLD = 'world'
const WORLD_DEPLOYMENT = 'deployment'

/** The job handed to the optimizer: a DeploymentToSqs whose entity always carries `entityId` and `entityType`. */
export type DeploymentJob = DeploymentToSqs & {
  entity: DeploymentToSqs['entity'] & { entityType: EntityType }
}

export type ParsedDeploymentMessage =
  | { ok: true; job: DeploymentJob; reason?: undefined }
  | { ok: false; reason: string; job?: undefined }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function invalid(reason: string): ParsedDeploymentMessage {
  return { ok: false, reason }
}

export function parseDeploymentMessage(body: string | undefined): ParsedDeploymentMessage {
  if (!body) return invalid('empty message body')

  let event: unknown
  try {
    event = JSON.parse(body)
    if (isRecord(event) && event.Type === 'Notification' && typeof event.Message === 'string') {
      event = JSON.parse(event.Message)
    }
  } catch (err) {
    return invalid(`body is not JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!isRecord(event)) return invalid('body is not a JSON object')
  if (!isRecord(event.entity)) return invalid('missing entity')

  const type = nonEmptyString(event.type)
  const subType = nonEmptyString(event.subType)
  if (type === WORLD && subType !== undefined && subType !== WORLD_DEPLOYMENT) {
    return invalid(`unsupported world event subType ${subType}`)
  }

  const entity = event.entity
  const entityId = nonEmptyString(entity.entityId) ?? nonEmptyString(entity.id)
  if (!entityId) return invalid('missing entity.entityId')
  if (!isValidEntityId(entityId)) return invalid(`entity id is not a content hash: ${entityId.slice(0, 100)}`)

  const rawType =
    nonEmptyString(entity.entityType) ??
    (type === CATALYST_DEPLOYMENT ? subType : undefined) ??
    (type === WORLD ? 'scene' : undefined) ??
    'scene'
  const entityType = rawType.toLowerCase()
  if (!SUPPORTED_ENTITY_TYPES.has(entityType)) return invalid(`unsupported entity type ${rawType}`)

  const job = { ...event, entity: { ...entity, entityId, entityType } }
  if (!DeploymentToSqs.validate(job)) {
    const errors = (DeploymentToSqs.validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ')
    return invalid(`not a DeploymentToSqs: ${errors || 'schema validation failed'}`)
  }

  return { ok: true, job: job as DeploymentJob }
}

// DeploymentToSqs requires a non-empty authChain. Manually queued jobs are not
// deployments and the optimizer never reads it, so they carry a placeholder
// SIGNER link (the zero address) that only satisfies the schema.
export const MANUAL_JOB_AUTH_CHAIN: DeploymentToSqs['entity']['authChain'] = [
  { type: AuthLinkType.SIGNER, payload: '0x0000000000000000000000000000000000000000', signature: '' }
]

/**
 * The DeploymentToSqs sent by the manual queue CLI and `--entityId` one-offs
 * (raw, no SNS envelope). `force` re-bakes a scene that is already published.
 */
export function buildDeploymentMessage(
  entityId: string,
  options: { entityType?: EntityType; contentServerUrl?: string; force?: boolean } = {}
): DeploymentJob {
  return {
    entity: { entityId, entityType: options.entityType ?? 'scene', authChain: MANUAL_JOB_AUTH_CHAIN },
    ...(options.contentServerUrl && { contentServerUrls: [options.contentServerUrl] }),
    ...(options.force && { force: true })
  }
}
