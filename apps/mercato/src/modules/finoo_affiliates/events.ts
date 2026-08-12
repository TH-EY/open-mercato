import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'finoo_affiliates.affiliate_link.created', label: 'Affiliate Link Created', entity: 'affiliate_link', category: 'crud' },
  { id: 'finoo_affiliates.affiliate_link.updated', label: 'Affiliate Link Updated', entity: 'affiliate_link', category: 'crud' },
  { id: 'finoo_affiliates.affiliate_link.deleted', label: 'Affiliate Link Deleted', entity: 'affiliate_link', category: 'crud' },
  { id: 'finoo_affiliates.deal_attribution.created', label: 'Deal Attribution Created', entity: 'deal_attribution', category: 'crud' },
  { id: 'finoo_affiliates.deal_attribution.updated', label: 'Deal Attribution Updated', entity: 'deal_attribution', category: 'crud' },
  { id: 'finoo_affiliates.deal_attribution.deleted', label: 'Deal Attribution Deleted', entity: 'deal_attribution', category: 'crud' },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'finoo_affiliates', events })
export const emitFinooAffiliateEvent = eventsConfig.emit
export type FinooAffiliateEventId = typeof events[number]['id']

export default eventsConfig
