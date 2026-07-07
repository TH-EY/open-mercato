import type { Edge } from '@xyflow/react'

/**
 * React Flow owns transient edge state such as selection, while the workflow
 * editor page owns transition data edited in dialogs. When React Flow emits an
 * edge-change snapshot from an older internal edge, keep the page-owned data so
 * activity edits are not rolled back.
 */
export function mergeVisualEditorEdges(previousEdges: Edge[], nextEdges: Edge[]): Edge[] {
  if (!previousEdges.length || !nextEdges.length) return nextEdges

  const previousById = new Map(previousEdges.map((edge) => [edge.id, edge]))

  return nextEdges.map((nextEdge) => {
    const previousEdge = previousById.get(nextEdge.id)
    if (!previousEdge?.data) return nextEdge

    return {
      ...nextEdge,
      data: {
        ...(nextEdge.data ?? {}),
        ...previousEdge.data,
      },
    }
  })
}
