import { createModuleEvents } from '@open-mercato/shared/modules/events'
import type { EmitOptions } from '@open-mercato/shared/modules/events'
import type { EffectiveIntermediaryStatus } from './lib/domain'

const events = [
  { id: 'finoo_intermediaries.intermediary.invited', label: 'Intermediary Invited', entity: 'intermediary', category: 'lifecycle' },
  { id: 'finoo_intermediaries.intermediary.updated', label: 'Intermediary Updated', entity: 'intermediary', category: 'crud' },
  { id: 'finoo_intermediaries.intermediary.activated', label: 'Intermediary Activated', entity: 'intermediary', category: 'lifecycle' },
  { id: 'finoo_intermediaries.intermediary.deactivated', label: 'Intermediary Deactivated', entity: 'intermediary', category: 'lifecycle' },
  { id: 'finoo_intermediaries.intermediary.reactivated', label: 'Intermediary Reactivated', entity: 'intermediary', category: 'lifecycle' },
  { id: 'finoo_intermediaries.intermediary.invitation_cancelled', label: 'Intermediary Invitation Cancelled', entity: 'intermediary', category: 'lifecycle' },
  { id: 'finoo_intermediaries.intermediary.invitation_delivery_failed', label: 'Intermediary Invitation Delivery Failed', entity: 'intermediary', category: 'lifecycle' },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'finoo_intermediaries',
  events,
})

export type FinooIntermediaryEventId = typeof events[number]['id']
export type FinooIntermediaryEventPayload = {
  id: string
  tenantId: string
  organizationId: string
  status: EffectiveIntermediaryStatus
  actorUserId?: string | null
  invitationId?: string | null
  customerUserId?: string | null
}

export function emitFinooIntermediaryEvent(
  eventId: FinooIntermediaryEventId,
  payload: FinooIntermediaryEventPayload,
  options?: EmitOptions,
): Promise<void> {
  return eventsConfig.emit(eventId, payload, options)
}

export default eventsConfig
