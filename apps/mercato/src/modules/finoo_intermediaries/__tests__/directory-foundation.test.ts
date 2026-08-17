import { MetadataStorage } from '@mikro-orm/core'
import { FinooIntermediary } from '../data/entities'
import { eventsConfig } from '../events'
import { searchConfig } from '../search'

describe('finoo_intermediaries directory foundation', () => {
  it('declares a scoped, optimistic-lockable intermediary entity additively', () => {
    const path = (FinooIntermediary as unknown as Record<symbol, string>)[MetadataStorage.PATH_SYMBOL]
    const metadata = MetadataStorage.getMetadata(FinooIntermediary.name, path)

    expect(metadata?.tableName).toBe('finoo_intermediaries')
    expect(metadata?.properties.tenantId.fieldName).toBe('tenant_id')
    expect(metadata?.properties.organizationId.fieldName).toBe('organization_id')
    expect(metadata?.properties.firstName.fieldName).toBe('first_name')
    expect(metadata?.properties.lastName.fieldName).toBe('last_name')
    expect(metadata?.properties.emailHash.fieldName).toBe('email_hash')
    expect(metadata?.properties.updatedAt.fieldName).toBe('updated_at')
    expect(metadata?.properties.updatedAt.onUpdate).toEqual(expect.any(Function))
    expect(metadata?.indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'finoo_intermediaries_scope_email_hash_uq',
      'finoo_intermediaries_scope_invitation_uq',
      'finoo_intermediaries_scope_customer_user_uq',
      'finoo_intermediaries_list_idx',
    ]))
    expect(metadata?.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      'finoo_intermediaries_lifecycle_state_chk',
      'finoo_intermediaries_email_kind_chk',
      'finoo_intermediaries_email_status_chk',
    ]))
    expect(new FinooIntermediary().lifecycleState).toBe('delivery_failed')
  })

  it('searches names, restricts email to exact hash lookup, and disables vector source', () => {
    const entity = searchConfig.entities[0]

    expect(entity).toMatchObject({
      entityId: 'finoo_intermediaries:finoo_intermediary',
      strategies: ['fulltext', 'tokens'],
      fieldPolicy: {
        searchable: ['first_name', 'last_name'],
        hashOnly: ['email'],
      },
    })
    expect(entity?.buildSource).toBeUndefined()
    expect(entity?.fieldPolicy?.excluded).toEqual(expect.arrayContaining([
      'email_hash',
      'invitation_id',
      'last_email_error_code',
    ]))
    expect(entity?.formatResult?.({
      record: { id: 'intermediary-1', first_name: 'Patryk', last_name: 'Madaj', email: 'secret@example.com' },
      customFields: {},
    })).toEqual({ title: 'Patryk Madaj', icon: 'user-round' })
  })

  it('declares only the approved singular lifecycle event ids', () => {
    expect(eventsConfig.moduleId).toBe('finoo_intermediaries')
    expect(eventsConfig.events.map((event) => event.id)).toEqual([
      'finoo_intermediaries.intermediary.invited',
      'finoo_intermediaries.intermediary.updated',
      'finoo_intermediaries.intermediary.activated',
      'finoo_intermediaries.intermediary.deactivated',
      'finoo_intermediaries.intermediary.reactivated',
      'finoo_intermediaries.intermediary.invitation_cancelled',
      'finoo_intermediaries.intermediary.invitation_delivery_failed',
    ])
    expect(eventsConfig.events.every((event) => event.entity === 'intermediary')).toBe(true)
  })
})
