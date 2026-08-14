import { features } from '../acl'
import { setup } from '../setup'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import '../commands/intermediaries'

describe('finoo_intermediaries module contract', () => {
  it('declares the frozen staff and portal feature ids with minimal defaults', () => {
    expect(features.map((feature) => feature.id)).toEqual([
      'finoo_intermediaries.view',
      'finoo_intermediaries.manage',
      'portal.finoo_intermediaries.view',
    ])
    expect(setup.defaultRoleFeatures).toEqual({
      superadmin: ['finoo_intermediaries.*'],
      admin: ['finoo_intermediaries.*'],
      employee: ['finoo_intermediaries.view'],
    })
    expect(setup.defaultCustomerRoleFeatures).toEqual({
      intermediary: ['portal.finoo_intermediaries.view'],
    })
  })

  it('registers every mutation as an undoable command', () => {
    const ids = [
      'finoo_intermediaries.assignment.create',
      'finoo_intermediaries.assignment.update',
      'finoo_intermediaries.assignment.delete',
      'finoo_intermediaries.partner_status.update',
      'finoo_intermediaries.note.create',
      'finoo_intermediaries.note.update',
      'finoo_intermediaries.note.delete',
    ]
    for (const id of ids) {
      const command = commandRegistry.get(id)
      expect(command).toBeDefined()
      expect(command?.isUndoable).toBe(true)
      expect(command?.undo).toEqual(expect.any(Function))
    }
  })

  it('keeps note plaintext out of generic audit snapshots', async () => {
    const command = commandRegistry.get('finoo_intermediaries.note.update')
    const snapshot = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      organizationId: '33333333-3333-4333-8333-333333333333',
      assignmentId: '44444444-4444-4444-8444-444444444444',
      authorCustomerUserId: '55555555-5555-4555-8555-555555555555',
      body: 'sensitive partner note',
      createdAt: '2026-08-13T10:00:00.000Z',
      updatedAt: '2026-08-13T10:00:00.000Z',
      deletedAt: null,
    }

    const metadata = await command?.buildLog?.({
      snapshots: { before: snapshot, after: snapshot },
    } as never)

    expect(metadata?.snapshotBefore).toMatchObject({ body: '[REDACTED]' })
    expect(metadata?.snapshotAfter).toMatchObject({ body: '[REDACTED]' })
    expect(metadata?.payload).toMatchObject({ undo: { before: snapshot, after: snapshot } })
  })

  it('denies staff command replay after FINOO manage is revoked', async () => {
    const userHasAllFeatures = jest.fn().mockResolvedValue(false)
    const ctx = {
      container: { resolve: (token: string) => {
        if (token === 'rbacService') return { userHasAllFeatures }
        throw new Error(`Unexpected dependency: ${token}`)
      } },
      auth: { sub: 'staff-1', tenantId: 'tenant-1', orgId: 'organization-1' },
      organizationScope: null,
      selectedOrganizationId: 'organization-1',
      organizationIds: ['organization-1'],
    } as unknown as CommandRuntimeContext
    const inputs: Record<string, unknown>[] = [
      {
        dealId: '11111111-1111-4111-8111-111111111111',
        intermediaryCustomerUserId: '22222222-2222-4222-8222-222222222222',
      },
      {
        assignmentId: '33333333-3333-4333-8333-333333333333',
        intermediaryCustomerUserId: '22222222-2222-4222-8222-222222222222',
        expectedUpdatedAt: '2026-08-13T10:00:00.000Z',
      },
      {
        assignmentId: '33333333-3333-4333-8333-333333333333',
        expectedUpdatedAt: '2026-08-13T10:00:00.000Z',
      },
    ]
    for (const [index, commandId] of [
      'finoo_intermediaries.assignment.create',
      'finoo_intermediaries.assignment.update',
      'finoo_intermediaries.assignment.delete',
    ].entries()) {
      const command = commandRegistry.get(commandId)
      await expect(command?.execute(inputs[index], ctx)).rejects.toMatchObject<Partial<CrudHttpError>>({ status: 403 })
    }
    expect(userHasAllFeatures).toHaveBeenCalledTimes(3)
  })

  it('denies portal command replay after its feature is revoked', async () => {
    const userHasAllFeatures = jest.fn().mockResolvedValue(false)
    const ctx = {
      container: { resolve: (token: string) => {
        if (token === 'customerRbacService') return { userHasAllFeatures }
        throw new Error(`Unexpected dependency: ${token}`)
      } },
      auth: { sub: 'customer-1', tenantId: 'tenant-1', orgId: 'organization-1' },
      organizationScope: null,
      selectedOrganizationId: 'organization-1',
      organizationIds: ['organization-1'],
    } as unknown as CommandRuntimeContext
    const assignmentId = '33333333-3333-4333-8333-333333333333'
    const noteId = '44444444-4444-4444-8444-444444444444'
    const expectedUpdatedAt = '2026-08-13T10:00:00.000Z'
    const cases = [
      ['finoo_intermediaries.partner_status.update', { assignmentId, partnerStatus: 'in_progress', expectedUpdatedAt }],
      ['finoo_intermediaries.note.create', { assignmentId, body: 'private' }],
      ['finoo_intermediaries.note.update', { assignmentId, noteId, body: 'private', expectedUpdatedAt }],
      ['finoo_intermediaries.note.delete', { assignmentId, noteId, expectedUpdatedAt }],
    ] as const
    for (const [commandId, input] of cases) {
      const command = commandRegistry.get(commandId)
      await expect(command?.execute(input, ctx)).rejects.toMatchObject<Partial<CrudHttpError>>({ status: 403 })
    }
    expect(userHasAllFeatures).toHaveBeenCalledTimes(4)
  })
})
