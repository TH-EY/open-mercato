import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { FinooIntermediaryNote } from '../data/entities'
import type { KeysetCursor } from './pagination'

export type StaffNoteView = {
  id: string
  authorCustomerUserId: string
  body: string
  createdAt: string
  updatedAt: string
}

export async function loadStaffNotes(
  em: EntityManager,
  input: {
    assignmentId: string
    tenantId: string
    organizationId: string
    pageSize: number
    cursor?: KeysetCursor | null
  },
): Promise<{ items: StaffNoteView[]; nextCursor: KeysetCursor | null }> {
  const notes = await findWithDecryption(
    em,
    FinooIntermediaryNote,
    {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      assignment: input.assignmentId,
      ...(input.cursor ? {
        $or: [
          { createdAt: { $lt: new Date(input.cursor.timestamp) } },
          { createdAt: new Date(input.cursor.timestamp), id: { $lt: input.cursor.id } },
        ],
      } : {}),
      deletedAt: null,
    } as FilterQuery<FinooIntermediaryNote>,
    { orderBy: { createdAt: 'desc', id: 'desc' }, limit: input.pageSize + 1 },
    { tenantId: input.tenantId, organizationId: input.organizationId },
  )
  const page = notes.slice(0, input.pageSize)
  const last = notes.length > input.pageSize ? page.at(-1) : null
  return {
    items: page.map((note) => ({
      id: note.id,
      authorCustomerUserId: note.authorCustomerUserId,
      body: note.body,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString(),
    })),
    nextCursor: last ? { timestamp: last.createdAt.toISOString(), id: last.id } : null,
  }
}
