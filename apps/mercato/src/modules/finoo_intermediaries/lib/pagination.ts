import { z } from 'zod'

const cursorPayloadSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
})

const nullableCursorPayloadSchema = cursorPayloadSchema.extend({
  timestamp: z.string().datetime({ offset: true }).nullable(),
})

export type KeysetCursor = z.infer<typeof cursorPayloadSchema>
export type NullableKeysetCursor = z.infer<typeof nullableCursorPayloadSchema>

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeCursor(value: string | undefined): KeysetCursor | null {
  if (!value) return null
  try {
    return cursorPayloadSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

export function encodeNullableCursor(cursor: NullableKeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeNullableCursor(value: string | undefined): NullableKeysetCursor | null {
  if (!value) return null
  try {
    return nullableCursorPayloadSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}
