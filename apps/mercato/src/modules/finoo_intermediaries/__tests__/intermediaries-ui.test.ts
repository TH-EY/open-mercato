/** @jest-environment jsdom */

import metadata from '../backend/finoo-intermediaries/intermediaries/page.meta'
import {
  isIntermediaryEmailDisabled,
  isIntermediarySubmitShortcut,
} from '../components/intermediaries/intermediary-dialog.client'
import { resolveIntermediaryActionIds } from '../components/intermediaries/intermediary-row-actions.client'
import type { IntermediaryDirectoryItem, IntermediaryStatus } from '../components/intermediaries/types'

function row(status: IntermediaryStatus, hasLinkedAccount = false): IntermediaryDirectoryItem {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    firstName: 'Test',
    lastName: 'Person',
    email: 'test@example.com',
    status,
    hasLinkedAccount,
    relatedDeals: 3,
    invitationExpiresAt: null,
    lastEmailStatus: null,
    lastEmailErrorCode: null,
    updatedAt: '2026-08-17T12:00:00.000Z',
  }
}

describe('intermediaries directory UI contract', () => {
  it('places the guarded page in the Customers group with the stable route metadata', () => {
    expect(metadata).toEqual(expect.objectContaining({
      requireAuth: true,
      requireFeatures: ['finoo_intermediaries.view'],
      pageTitleKey: 'finoo_intermediaries.directory.title',
      pageGroup: 'Customers',
      pageGroupKey: 'customers.nav.group',
      pageOrder: 130,
      icon: 'users',
    }))
  })

  it('hides all mutations from view-only staff', () => {
    expect(resolveIntermediaryActionIds(row('active', true), {
      canManage: false,
      canInvite: false,
      canManageAccounts: false,
    })).toEqual([])
  })

  it.each([
    ['invited', false, ['edit', 'resend', 'cancel-invitation']],
    ['expired', false, ['edit', 'resend', 'cancel-invitation']],
    ['delivery_failed', false, ['edit', 'retry', 'cancel-invitation']],
    ['active', true, ['edit', 'deactivate']],
    ['inactive', true, ['edit', 'reactivate']],
  ] as const)('exposes stable %s row actions', (status, linked, expected) => {
    expect(resolveIntermediaryActionIds(row(status, linked), {
      canManage: true,
      canInvite: true,
      canManageAccounts: true,
    })).toEqual(expected)
  })

  it('requires invite permission to reactivate an unlinked inactive record', () => {
    expect(resolveIntermediaryActionIds(row('inactive'), {
      canManage: true,
      canInvite: false,
      canManageAccounts: true,
    })).toEqual(['edit'])
  })

  it('keeps linked email immutable and lets manage-only staff edit names', () => {
    expect(isIntermediaryEmailDisabled('edit', row('active', true), true)).toBe(true)
    expect(isIntermediaryEmailDisabled('edit', row('invited'), false)).toBe(true)
    expect(isIntermediaryEmailDisabled('edit', row('invited'), true)).toBe(false)
    expect(isIntermediaryEmailDisabled('invite', null, true)).toBe(false)
  })

  it('submits embedded dialogs with Cmd/Ctrl+Enter only', () => {
    expect(isIntermediarySubmitShortcut({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true)
    expect(isIntermediarySubmitShortcut({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true)
    expect(isIntermediarySubmitShortcut({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false)
    expect(isIntermediarySubmitShortcut({ key: 'Escape', metaKey: true, ctrlKey: false })).toBe(false)
  })
})
