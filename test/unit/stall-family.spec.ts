import { expandStalledFamily, nameStem } from '../../src/runners/godot-optimizer/stall-family'

describe('nameStem', () => {
  it('strips path, extension, dotted suffixes and trailing counters', () => {
    expect(nameStem('models/building_ring_in_03.20260909135738746.glb')).toBe('building_ring_in')
    expect(nameStem('models/Building_Ring_out_18.20260909135738746.glb')).toBe('building_ring_out')
    expect(nameStem('models/objects/potion_cubes_pink.gltf')).toBe('potion_cubes_pink')
    expect(nameStem('tree-12.glb')).toBe('tree')
    expect(nameStem('scene.json')).toBe('scene')
  })
})

describe('expandStalledFamily', () => {
  const content = [
    { file: 'models/building_ring_in_01.x.glb', hash: 'in1' },
    { file: 'models/building_ring_in_02.x.glb', hash: 'in2' },
    { file: 'models/building_ring_out_01.x.glb', hash: 'out1' },
    { file: 'models/building_ring_out_02.x.glb', hash: 'out2' },
    { file: 'models/tree_01.glb', hash: 'tree1' },
    { file: 'models/bench.glb', hash: 'bench' }
  ]

  it('excludes pending siblings sharing the stalled files stem prefix', () => {
    const family = expandStalledFamily(['in1', 'out1'], ['in2', 'out2', 'tree1', 'bench', 'in1'], content)
    expect(family.sort()).toEqual(['in2', 'out2'])
  })

  it('uses the whole stem when a single file stalled', () => {
    expect(expandStalledFamily(['in1'], ['in2', 'out2', 'tree1'], content)).toEqual(['in2'])
  })

  it('widens to the common prefix once a second family has stalled', () => {
    const city = [
      ...content,
      { file: 'models/building_lane_wf_01.x.glb', hash: 'lane1' },
      { file: 'models/building_blk_south_07.x.glb', hash: 'blk7' }
    ]
    // first stall: only the ring family
    expect(expandStalledFamily(['in1', 'out1'], ['in2', 'out2', 'lane1', 'blk7', 'tree1'], city).sort()).toEqual([
      'in2',
      'out2'
    ])
    // second stall adds a lane file: stem prefix becomes building_ → every building goes
    expect(expandStalledFamily(['in1', 'out1', 'lane1'], ['blk7', 'tree1', 'bench'], city)).toEqual(['blk7'])
  })

  it('does nothing for unrelated stalled files or unknown hashes', () => {
    expect(expandStalledFamily(['in1', 'tree1'], ['in2', 'out2'], content)).toEqual([])
    expect(expandStalledFamily(['nope'], ['in2'], content)).toEqual([])
  })
})
