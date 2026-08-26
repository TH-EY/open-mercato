import type { IdentityFieldStatuses } from '../../lib/identity-domain'

export type IdentityStatusSharedState = {
  get?<T>(key: string): T | undefined
  set?<T>(key: string, value: T): void
  subscribe?(key: string, handler: (value: unknown) => void): () => void
}

export function identityStatusStateKey(personId: string): string {
  return `identity-statuses:${personId}`
}

export function readIdentityStatusSharedState(context: unknown): IdentityStatusSharedState | null {
  if (!context || typeof context !== 'object') return null
  const sharedState = (context as { sharedState?: unknown }).sharedState
  return sharedState && typeof sharedState === 'object'
    ? sharedState as IdentityStatusSharedState
    : null
}

export function publishIdentityStatuses(
  context: unknown,
  personId: string,
  statuses: IdentityFieldStatuses,
): void {
  readIdentityStatusSharedState(context)?.set?.(identityStatusStateKey(personId), statuses)
}
