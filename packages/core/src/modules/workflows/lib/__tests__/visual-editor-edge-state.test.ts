import type { Edge } from '@xyflow/react'
import { mergeVisualEditorEdges } from '../visual-editor-edge-state'

describe('mergeVisualEditorEdges', () => {
  it('preserves page-owned activity data when React Flow emits a stale edge snapshot', () => {
    const previousEdges: Edge[] = [
      {
        id: 'start_to_end',
        source: 'start',
        target: 'end',
        selected: false,
        data: {
          label: 'Start to End',
          activities: [
            { activityId: 'initial_lookup', activityName: 'Initial lookup', activityType: 'CALL_API', config: {} },
            { activityId: 'visual_lookup_added', activityName: 'Visual lookup added', activityType: 'CALL_API', config: {} },
          ],
        },
      },
    ]
    const staleReactFlowEdges: Edge[] = [
      {
        id: 'start_to_end',
        source: 'start',
        target: 'end',
        selected: true,
        data: {
          label: 'Start to End',
          activities: [
            { activityId: 'initial_lookup', activityName: 'Initial lookup', activityType: 'CALL_API', config: {} },
          ],
        },
      },
    ]

    const merged = mergeVisualEditorEdges(previousEdges, staleReactFlowEdges)

    expect(merged[0].selected).toBe(true)
    expect(merged[0].data?.activities).toEqual(previousEdges[0].data?.activities)
  })

  it('keeps brand-new edges from React Flow', () => {
    const nextEdges: Edge[] = [
      {
        id: 'new_edge',
        source: 'a',
        target: 'b',
        data: { label: 'New Edge' },
      },
    ]

    expect(mergeVisualEditorEdges([], nextEdges)).toBe(nextEdges)
  })
})
