import {
  MANUAL_JOB_AUTH_CHAIN,
  buildDeploymentMessage,
  parseDeploymentMessage
} from '../../src/logic/deployment-message'

const authChain = [{ type: 'SIGNER', payload: '0xabc', signature: '' }]

// As published on the event bus by the catalyst deployments relay
const catalystEvent = {
  type: 'catalyst-deployment',
  subType: 'wearable',
  entity: {
    entityId: 'bafywearable',
    entityType: 'wearable',
    pointers: ['urn:decentraland:matic:collections-v2:0xabc:0'],
    authChain,
    entityTimestamp: 1700000000000,
    metadata: { id: 'urn:decentraland:matic:collections-v2:0xabc:0' }
  },
  contentServerUrls: ['https://peer.decentraland.org/content']
}

// As published by the worlds content server
const worldEvent = {
  type: 'world',
  subType: 'deployment',
  key: 'bafyworld',
  timestamp: 1700000000000,
  entity: { entityId: 'bafyworld', authChain },
  contentServerUrls: ['https://worlds.example.org']
}

function envelope(event: unknown) {
  return JSON.stringify({ Type: 'Notification', MessageId: 'sns-1', Message: JSON.stringify(event) })
}

describe('parseDeploymentMessage', () => {
  it('parses a raw catalyst deployment event', () => {
    const parsed = parseDeploymentMessage(JSON.stringify(catalystEvent))
    expect(parsed).toEqual({
      ok: true,
      job: expect.objectContaining({
        entity: expect.objectContaining({ entityId: 'bafywearable', entityType: 'wearable', authChain }),
        contentServerUrls: ['https://peer.decentraland.org/content']
      })
    })
  })

  it('unwraps an SNS envelope', () => {
    const raw = parseDeploymentMessage(JSON.stringify(worldEvent))
    const wrapped = parseDeploymentMessage(envelope(worldEvent))
    expect(wrapped.ok).toBe(true)
    expect(wrapped).toEqual(raw)
  })

  it('takes the entity type from the catalyst event subType when the entity has none', () => {
    const { entityType: _ignored, ...entity } = catalystEvent.entity
    const parsed = parseDeploymentMessage(JSON.stringify({ ...catalystEvent, subType: 'emote', entity }))
    expect(parsed.ok && parsed.job.entity.entityType).toBe('emote')
  })

  it('bakes a world deployment as a scene', () => {
    const parsed = parseDeploymentMessage(JSON.stringify(worldEvent))
    expect(parsed.ok && parsed.job.entity).toEqual({ entityId: 'bafyworld', entityType: 'scene', authChain })
    expect(parsed.ok && parsed.job.contentServerUrls).toEqual(['https://worlds.example.org'])
  })

  it('falls back to entity.id for the entity id', () => {
    const parsed = parseDeploymentMessage(JSON.stringify({ entity: { id: 'bafyid', authChain } }))
    expect(parsed.ok && parsed.job.entity).toEqual({ id: 'bafyid', entityId: 'bafyid', entityType: 'scene', authChain })
  })

  it('defaults a bare DeploymentToSqs (manual queue) to a scene', () => {
    const parsed = parseDeploymentMessage(JSON.stringify({ entity: { entityId: 'bafy', authChain } }))
    expect(parsed.ok && parsed.job.entity.entityType).toBe('scene')
  })

  it.each([
    ['an empty body', ''],
    ['non-JSON', 'not json'],
    ['a JSON array', '[]'],
    ['a message without entity', JSON.stringify({ contentServerUrls: [] })],
    ['an entity without id', JSON.stringify({ entity: { authChain } })],
    ['an entity without authChain', JSON.stringify({ entity: { entityId: 'bafy' } })],
    ['an empty authChain', JSON.stringify({ entity: { entityId: 'bafy', authChain: [] } })],
    [
      'a non-string content server url',
      JSON.stringify({ entity: { entityId: 'bafy', authChain }, contentServerUrls: [1] })
    ],
    [
      'an unsupported entity type',
      JSON.stringify({
        ...catalystEvent,
        subType: 'profile',
        entity: { ...catalystEvent.entity, entityType: 'profile' }
      })
    ],
    ['a world undeployment', JSON.stringify({ ...worldEvent, subType: 'undeployment' })],
    ['an envelope with a broken Message', JSON.stringify({ Type: 'Notification', Message: '{' })],
    ['a path-traversal entity id', JSON.stringify({ entity: { entityId: '../../x', authChain } })],
    ['an entity id with a slash', JSON.stringify({ entity: { entityId: 'bafy/../x', authChain } })],
    ['a path-traversal entity.id', JSON.stringify({ entity: { id: '..', authChain } })]
  ])('rejects %s', (_name, body) => {
    const parsed = parseDeploymentMessage(body)
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.reason).toEqual(expect.any(String))
  })
})

describe('buildDeploymentMessage', () => {
  it('builds a DeploymentToSqs the parser accepts', () => {
    const message = buildDeploymentMessage('bafy', { entityType: 'emote', contentServerUrl: 'https://cs.example.org' })
    expect(message).toEqual({
      entity: { entityId: 'bafy', entityType: 'emote', authChain: MANUAL_JOB_AUTH_CHAIN },
      contentServerUrls: ['https://cs.example.org']
    })
    expect(parseDeploymentMessage(JSON.stringify(message))).toEqual({ ok: true, job: message })
  })

  it('carries force for a re-bake', () => {
    expect(buildDeploymentMessage('bafy', { force: true })).toEqual({
      entity: { entityId: 'bafy', entityType: 'scene', authChain: MANUAL_JOB_AUTH_CHAIN },
      force: true
    })
  })

  it('leaves the content server to the worker when none is given', () => {
    expect(buildDeploymentMessage('bafy')).toEqual({
      entity: { entityId: 'bafy', entityType: 'scene', authChain: MANUAL_JOB_AUTH_CHAIN }
    })
  })
})
