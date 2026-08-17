import {
  readDictionaryEntryId,
  portalActivityWhere,
  readLoadedCustomFieldValue,
  sanitizeActivitySummary,
  selectOldestCompanyLink,
  selectScopedDefinition,
} from '../lib/projection'

describe('finoo_intermediaries safe projection rules', () => {
  it('selects the oldest company link and breaks ties by id', () => {
    const selected = selectOldestCompanyLink([
      { id: 'b', createdAt: new Date('2026-08-12T10:00:00.000Z') },
      { id: 'c', createdAt: new Date('2026-08-11T10:00:00.000Z') },
      { id: 'a', createdAt: new Date('2026-08-11T10:00:00.000Z') },
    ])
    expect(selected?.id).toBe('a')
  })

  it('uses organization definitions ahead of tenant and global definitions', () => {
    const selected = selectScopedDefinition([
      { id: 'global', tenantId: null, organizationId: null },
      { id: 'tenant', tenantId: 'tenant-1', organizationId: null },
      { id: 'organization', tenantId: 'tenant-1', organizationId: 'org-1' },
    ], 'tenant-1', 'org-1')
    expect(selected?.id).toBe('organization')
  })

  it('strips markup, normalizes whitespace, and caps activity summaries', () => {
    const summary = sanitizeActivitySummary(`  <b>Call</b>\n${'x'.repeat(400)}  `)
    expect(summary).not.toContain('<')
    expect(summary).not.toContain('\n')
    expect(summary.length).toBe(300)
  })

  it('reads the prefixed contract returned by loadCustomFieldValues', () => {
    expect(readLoadedCustomFieldValue({ record: { cf_turnover: 125000 } }, 'record', 'turnover'))
      .toBe(125000)
  })

  it('accepts only UUID dictionary entry identifiers from legacy custom values', () => {
    expect(readDictionaryEntryId('11111111-1111-4111-8111-111111111111'))
      .toBe('11111111-1111-4111-8111-111111111111')
    expect(readDictionaryEntryId('legacy-industry-value')).toBeNull()
    expect(readDictionaryEntryId(null)).toBeNull()
  })

  it('includes only explicitly public non-email activities from non-internal sources', () => {
    expect(portalActivityWhere({
      personEntityId: 'person-1',
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
    })).toMatchObject({
      $or: [{ source: null }, { source: { $ne: 'internal' } }],
      interactionType: { $ne: 'email' },
      visibility: 'public',
    })
  })

  it('moves from dated activities into the null occurrence partition', () => {
    expect(portalActivityWhere({
      personEntityId: 'person-1',
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      cursor: {
        timestamp: '2026-08-13T10:00:00.000Z',
        id: '11111111-1111-4111-8111-111111111111',
      },
    })).toMatchObject({
      $and: [{
        $or: expect.arrayContaining([
          { occurredAt: null },
          { occurredAt: { $lt: new Date('2026-08-13T10:00:00.000Z') } },
        ]),
      }],
    })
  })

  it('continues within null occurrence rows by id', () => {
    expect(portalActivityWhere({
      personEntityId: 'person-1',
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      cursor: {
        timestamp: null,
        id: '11111111-1111-4111-8111-111111111111',
      },
    })).toMatchObject({
      occurredAt: null,
      id: { $lt: '11111111-1111-4111-8111-111111111111' },
    })
  })
})
