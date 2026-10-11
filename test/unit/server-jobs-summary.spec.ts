import { summarizeServerJobs } from '../../src/runners/godot-optimizer'
import { JobStatus } from '../../src/adapters/asset-server'

function job(overrides: Partial<JobStatus>): JobStatus {
  return {
    job_id: 'job',
    hash: 'hash',
    asset_type: 'scene',
    status: 'completed',
    progress: 1,
    elapsed_secs: 1,
    ...overrides
  }
}

describe('summarizeServerJobs', () => {
  it('reports nothing when every job completed and was packed', () => {
    const jobs = [job({ hash: 'glb1' }), job({ hash: 'tex1', asset_type: 'texture' })]
    const zips = [{ hash: 'glb1' }, { hash: 'tex1' }]
    expect(summarizeServerJobs(jobs, zips)).toEqual({ failed: [], completedNotPacked: [] })
  })

  it('lists a GLB the server dropped for missing external textures', () => {
    const jobs = [
      job({ hash: 'glb1' }),
      job({
        hash: 'glb2',
        status: 'failed',
        error: 'external texture dependencies not baked: tex9'
      }),
      job({ hash: 'tex9', asset_type: 'texture', status: 'failed', error: 'Failed to load image' })
    ]
    const zips = [{ hash: 'glb1' }]
    expect(summarizeServerJobs(jobs, zips)).toEqual({
      failed: [
        { hash: 'glb2', assetType: 'scene', error: 'external texture dependencies not baked: tex9' },
        { hash: 'tex9', assetType: 'texture', error: 'Failed to load image' }
      ],
      completedNotPacked: []
    })
  })

  it('flags a completed job that has no individual zip', () => {
    const jobs = [job({ hash: 'glb1' }), job({ hash: 'glb2' })]
    const zips = [{ hash: 'glb1' }]
    const summary = summarizeServerJobs(jobs, zips)
    expect(summary.failed).toEqual([])
    expect(summary.completedNotPacked).toEqual(['glb2'])
  })

  it('defaults a missing error message', () => {
    const summary = summarizeServerJobs([job({ hash: 'x', status: 'failed' })], [])
    expect(summary.failed[0].error).toBe('unknown error')
  })
})
