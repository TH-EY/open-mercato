/** @jest-environment node */

import { FinooIntermediary } from '../data/entities'
import { serializeDirectoryItem } from '../lib/directory-api'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const intermediaryId = '33333333-3333-4333-8333-333333333333'
const userId = '44444444-4444-4444-8444-444444444444'

function intermediary(): FinooIntermediary {
  const record = new FinooIntermediary()
  record.id = intermediaryId
  record.tenantId = tenantId
  record.organizationId = organizationId
  record.firstName = 'Pat'
  record.lastName = 'Example'
  record.email = 'pat@example.com'
  record.emailHash = 'secret-email-hash'
  record.customerUserId = userId
  record.invitationId = '55555555-5555-4555-8555-555555555555'
  record.lifecycleState = 'invited'
  record.invitationExpiresAt = new Date('2026-08-17T10:00:00.000Z')
  record.lastEmailStatus = 'failed'
  record.lastEmailErrorCode = 'provider response with sensitive detail'
  record.createdAt = new Date('2026-08-16T10:00:00.000Z')
  record.updatedAt = new Date('2026-08-17T11:00:00.000Z')
  return record
}

describe('intermediary directory API projection', () => {
  it('computes effective expiry without mutating stored state and exposes no linkage/hash details', () => {
    const record = intermediary()
    const item = serializeDirectoryItem(record, 7, new Date('2026-08-17T12:00:00.000Z'))

    expect(item).toEqual({
      id: intermediaryId,
      firstName: 'Pat',
      lastName: 'Example',
      email: 'pat@example.com',
      status: 'expired',
      hasLinkedAccount: true,
      relatedDeals: 7,
      invitationExpiresAt: '2026-08-17T10:00:00.000Z',
      lastEmailStatus: 'failed',
      lastEmailErrorCode: null,
      updatedAt: '2026-08-17T11:00:00.000Z',
    })
    expect(record.lifecycleState).toBe('invited')
    const serialized = JSON.stringify(item)
    expect(serialized).not.toContain('secret-email-hash')
    expect(serialized).not.toContain(userId)
    expect(serialized).not.toContain(record.invitationId as string)
    expect(serialized).not.toContain('provider response')
  })

  it('allows only the module-owned sanitized delivery error code', () => {
    const record = intermediary()
    record.lastEmailErrorCode = 'email_delivery_failed'
    expect(serializeDirectoryItem(record, 0).lastEmailErrorCode).toBe('email_delivery_failed')
  })
})
