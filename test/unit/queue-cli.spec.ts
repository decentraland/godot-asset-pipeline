import { SendMessageCommand } from '@aws-sdk/client-sqs'
import { MANUAL_JOB_AUTH_CHAIN } from '../../src/logic/deployment-message'
import { buildSendMessageInput, parseEntityIdList, parseQueueArgs, queueEntities, uniqueIds } from '../../src/cli/queue'

const QUEUE = 'https://sqs.us-east-1.amazonaws.com/000000000000/asset-optimizer-queue'

describe('queue CLI', () => {
  describe('parseQueueArgs', () => {
    it('defaults to the main queue, scene entities and no content server', () => {
      expect(parseQueueArgs(['bafy1', 'bafy2'])).toEqual({
        priority: false,
        files: [],
        contentServerUrl: undefined,
        entityType: 'scene',
        force: false,
        dryRun: false,
        help: false,
        entityIds: ['bafy1', 'bafy2']
      })
    })

    it('reads --priority, --file, --content-server-url, --entity-type, --force and --dry-run', () => {
      expect(
        parseQueueArgs([
          '--priority',
          '--file',
          'ids.txt',
          '--content-server-url',
          'https://cs.example.org/content/',
          '--entity-type',
          'Wearable',
          '--force',
          '--dry-run'
        ])
      ).toEqual({
        priority: true,
        files: ['ids.txt'],
        contentServerUrl: 'https://cs.example.org/content',
        entityType: 'wearable',
        force: true,
        dryRun: true,
        help: false,
        entityIds: []
      })
    })

    it('rejects an unknown entity type, a bad URL and unknown flags', () => {
      expect(() => parseQueueArgs(['--entity-type', 'profile', 'x'])).toThrow(/entity-type/)
      expect(() => parseQueueArgs(['--content-server-url', 'nope', 'x'])).toThrow(/not a URL/)
      expect(() => parseQueueArgs(['--content-server-url', 'file:///etc', 'x'])).toThrow(/http/)
      expect(() => parseQueueArgs(['--nope', 'x'])).toThrow()
    })
  })

  it('reads one id per line from a file, skipping blanks and comments', () => {
    expect(parseEntityIdList('bafy1\n\n  bafy2  \r\n# a comment\nbafy3 # trailing\n')).toEqual([
      'bafy1',
      'bafy2',
      'bafy3'
    ])
  })

  it('deduplicates ids, keeping their order', () => {
    expect(uniqueIds(['b', 'a', 'b', ' a ', ''])).toEqual(['b', 'a'])
  })

  it('sends a raw DeploymentToSqs per entity', () => {
    expect(
      buildSendMessageInput(QUEUE, 'bafy', { entityType: 'wearable', contentServerUrl: 'https://cs.example.org' })
    ).toEqual({
      QueueUrl: QUEUE,
      MessageBody: JSON.stringify({
        entity: { entityId: 'bafy', entityType: 'wearable', authChain: MANUAL_JOB_AUTH_CHAIN },
        contentServerUrls: ['https://cs.example.org']
      })
    })
    expect(JSON.parse(buildSendMessageInput(QUEUE, 'bafy', { entityType: 'scene' }).MessageBody)).toEqual({
      entity: { entityId: 'bafy', entityType: 'scene', authChain: MANUAL_JOB_AUTH_CHAIN }
    })
  })

  it('marks a forced job so the worker re-bakes an already published scene', () => {
    expect(JSON.parse(buildSendMessageInput(QUEUE, 'bafy', { entityType: 'scene', force: true }).MessageBody)).toEqual({
      entity: { entityId: 'bafy', entityType: 'scene', authChain: MANUAL_JOB_AUTH_CHAIN },
      force: true
    })
  })

  it('refuses ids that are not content hashes', () => {
    expect(() => buildSendMessageInput(QUEUE, '../../x', { entityType: 'scene' })).toThrow(/Not an entity id/)
    expect(() => buildSendMessageInput(QUEUE, 'a/b', { entityType: 'scene' })).toThrow(/Not an entity id/)
  })

  it('SendMessages every entity to the queue and reports failures without stopping', async () => {
    const inputs: unknown[] = []
    const sqs = {
      async send(command: unknown) {
        expect(command).toBeInstanceOf(SendMessageCommand)
        const input = (command as SendMessageCommand).input
        inputs.push(input)
        if (input.MessageBody!.includes('bafybad')) throw new Error('AccessDenied')
        return { MessageId: `m-${JSON.parse(input.MessageBody!).entity.entityId}` }
      }
    }
    const reported: string[] = []

    const results = await queueEntities(sqs, QUEUE, ['bafy1', 'bafybad', 'bafy3'], { entityType: 'emote' }, (r) =>
      reported.push(r.entityId)
    )

    expect(results).toEqual([
      { entityId: 'bafy1', messageId: 'm-bafy1' },
      { entityId: 'bafybad', error: 'AccessDenied' },
      { entityId: 'bafy3', messageId: 'm-bafy3' }
    ])
    expect(reported.sort()).toEqual(['bafy1', 'bafy3', 'bafybad'])
    expect(inputs).toHaveLength(3)
    for (const input of inputs) {
      expect(input).toEqual({ QueueUrl: QUEUE, MessageBody: expect.stringContaining('"entityType":"emote"') })
    }
  })
})
