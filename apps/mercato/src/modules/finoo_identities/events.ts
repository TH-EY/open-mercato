import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  {
    id: 'finoo_identities.identity.created',
    label: 'FINOO Identity Created',
    entity: 'identity',
    category: 'crud',
    excludeFromTriggers: true,
  },
  {
    id: 'finoo_identities.identity.updated',
    label: 'FINOO Identity Updated',
    entity: 'identity',
    category: 'crud',
    excludeFromTriggers: true,
  },
  {
    id: 'finoo_identities.identity.erased',
    label: 'FINOO Identity Erased',
    entity: 'identity',
    category: 'lifecycle',
    excludeFromTriggers: true,
  },
  {
    id: 'finoo_identities.import_conflict.created',
    label: 'FINOO Identity Import Conflict Created',
    entity: 'import_conflict',
    category: 'crud',
    excludeFromTriggers: true,
  },
  {
    id: 'finoo_identities.import_conflict.resolved',
    label: 'FINOO Identity Import Conflict Resolved',
    entity: 'import_conflict',
    category: 'lifecycle',
    excludeFromTriggers: true,
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'finoo_identities',
  events,
})

export const emitFinooIdentityEvent = eventsConfig.emit
export type FinooIdentityEventId = typeof events[number]['id']

export default eventsConfig
