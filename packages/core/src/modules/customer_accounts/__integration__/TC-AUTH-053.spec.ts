import 'reflect-metadata'
import { expect, test, type APIRequestContext } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getOrm, registerOrmEntities, type AppMikroORM } from '@open-mercato/shared/lib/db/mikro'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  CustomerUser,
  CustomerUserInvitation,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import * as customerAccountEntities from '@open-mercato/core/modules/customer_accounts/data/entities'
import { CustomerInvitationService } from '@open-mercato/core/modules/customer_accounts/services/customerInvitationService'
import { hashToken } from '@open-mercato/core/modules/customer_accounts/lib/tokenGenerator'

type TestContext = {
  tenantId: string
  organizationId: string
  roleIds: string[]
}

type Barrier = {
  reached: Promise<void>
  release: () => void
  wait: () => Promise<void>
}

type InvitationDbSnapshot = {
  id: string
  token: string
  roleIdsJson: string[] | null
  invitedByUserId: string | null
  invitedByCustomerUserId: string | null
  displayName: string | null
  expiresAt: number
  acceptedAt: number | null
  cancelledAt: number | null
}

let orm: AppMikroORM | null = null

async function getIntegrationOrm(): Promise<AppMikroORM> {
  if (!orm) {
    registerOrmEntities(
      Object.values(customerAccountEntities).filter((value) => typeof value === 'function'),
    )
    orm = await getOrm()
  }
  return orm
}

function createBarrier(): Barrier {
  let markReached!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    markReached = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    reached,
    release,
    wait: async () => {
      markReached()
      await released
    },
  }
}

function scopedEm(): EntityManager {
  if (!orm) throw new Error('ORM not initialized')
  return orm.em.fork({ clear: true, freshEventManager: true, useContext: false }) as EntityManager
}

async function loadContext(api: APIRequestContext): Promise<TestContext> {
  const adminToken = await getAuthToken(api, 'admin')
  const { tenantId, organizationId } = getTokenContext(adminToken)
  const rolesRes = await apiRequest(api, 'GET', '/api/customer_accounts/admin/roles?pageSize=10', {
    token: adminToken,
  })
  expect(rolesRes.ok(), 'roles list should succeed').toBeTruthy()
  const rolesBody = (await rolesRes.json()) as { items: Array<{ id: string; slug: string }> }
  expect(rolesBody.items.length, 'tenant should have at least one customer role').toBeGreaterThan(0)
  return {
    tenantId,
    organizationId,
    roleIds: rolesBody.items.map((role) => role.id),
  }
}

function uniqueEmail(label: string): string {
  return `qa-auth-053-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`
}

function inviteScope(ctx: TestContext): { tenantId: string; organizationId: string } {
  return { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
}

async function cleanupEmail(ctx: TestContext, email: string): Promise<void> {
  const em = scopedEm()
  const emailHash = hashForLookup(email)
  const conn = em.getConnection()
  await conn.execute(
    `delete from customer_user_sessions where user_id in (
      select id from customer_users where tenant_id = ? and email_hash = ?
    )`,
    [ctx.tenantId, emailHash],
  )
  await conn.execute(
    `delete from customer_user_roles where user_id in (
      select id from customer_users where tenant_id = ? and email_hash = ?
    )`,
    [ctx.tenantId, emailHash],
  )
  await conn.execute('delete from customer_users where tenant_id = ? and email_hash = ?', [ctx.tenantId, emailHash])
  await conn.execute('delete from customer_user_invitations where tenant_id = ? and email_hash = ?', [
    ctx.tenantId,
    emailHash,
  ])
}

async function readInvitation(invitationId: string): Promise<CustomerUserInvitation> {
  const invitation = await scopedEm().findOne(CustomerUserInvitation, { id: invitationId } as any)
  expect(invitation, `invitation ${invitationId} should exist`).toBeTruthy()
  return invitation!
}

async function readInvitationSnapshot(invitationId: string): Promise<InvitationDbSnapshot> {
  const invitation = await readInvitation(invitationId)
  return {
    id: invitation.id,
    token: invitation.token,
    roleIdsJson: Array.isArray(invitation.roleIdsJson) ? [...invitation.roleIdsJson] : null,
    invitedByUserId: invitation.invitedByUserId ?? null,
    invitedByCustomerUserId: invitation.invitedByCustomerUserId ?? null,
    displayName: invitation.displayName ?? null,
    expiresAt: invitation.expiresAt.getTime(),
    acceptedAt: invitation.acceptedAt?.getTime() ?? null,
    cancelledAt: invitation.cancelledAt?.getTime() ?? null,
  }
}

async function countUsersByEmail(ctx: TestContext, email: string): Promise<number> {
  return scopedEm().count(CustomerUser, {
    tenantId: ctx.tenantId,
    emailHash: hashForLookup(email),
    deletedAt: null,
  } as any)
}

async function countSessionsForEmail(ctx: TestContext, email: string): Promise<number> {
  const conn = scopedEm().getConnection()
  const rows = await conn.execute<{ count: string }[]>(
    `select count(*)::text as count
       from customer_user_sessions s
       join customer_users u on u.id = s.user_id
      where u.tenant_id = ? and u.email_hash = ? and s.deleted_at is null`,
    [ctx.tenantId, hashForLookup(email)],
  )
  return Number(rows[0]?.count ?? 0)
}

async function createInvite(
  ctx: TestContext,
  email: string,
  options: {
    roleIds: string[]
    invitedByUserId?: string | null
    displayName?: string | null
  },
) {
  return new CustomerInvitationService(scopedEm()).createInvitation(email, inviteScope(ctx), {
    roleIds: options.roleIds,
    invitedByUserId: options.invitedByUserId ?? null,
    displayName: options.displayName ?? null,
  })
}

function assertSnapshotUnchanged(actual: InvitationDbSnapshot, expected: InvitationDbSnapshot): void {
  expect(actual).toEqual(expected)
}

const inviterA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const inviterB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const inviterSeed = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

test.describe('TC-AUTH-053: customer invitation concurrency barriers', () => {
  test.beforeAll(async () => {
    await getIntegrationOrm()
  })

  test.afterAll(async () => {
    await orm?.close(true)
    orm = null
  })

  test('old-token acceptance blocked after lookup creates no user/session after resend rotation; new token remains usable', async ({ request }) => {
    const ctx = await loadContext(request)
    const email = uniqueEmail('old-token-race')
    await cleanupEmail(ctx, email)

    try {
      const roleId = ctx.roleIds[0]
      const first = await createInvite(ctx, email, {
        roleIds: [roleId],
        invitedByUserId: inviterA,
        displayName: 'Old Attempt',
      })

      const barrier = createBarrier()
      const oldAcceptService = new CustomerInvitationService(scopedEm())
      const originalFindByToken = oldAcceptService.findByToken.bind(oldAcceptService)
      oldAcceptService.findByToken = async (token: string) => {
        const invitation = await originalFindByToken(token)
        expect(invitation?.id, 'old-token lookup should see the original pending invitation before rotation').toBe(first.invitation.id)
        await barrier.wait()
        return invitation
      }

      const oldAcceptPromise = oldAcceptService.acceptInvitation(first.rawToken, 'Password034!', 'Old Accepted')
      await barrier.reached

      const second = await createInvite(ctx, email, {
        roleIds: [roleId],
        invitedByUserId: inviterB,
        displayName: 'New Attempt',
      })
      expect(second.invitation.id).toBe(first.invitation.id)
      expect(second.attemptTokenHash).toBe(hashToken(second.rawToken))

      barrier.release()
      await expect(oldAcceptPromise).resolves.toBeNull()
      await expect(countUsersByEmail(ctx, email)).resolves.toBe(0)
      await expect(countSessionsForEmail(ctx, email)).resolves.toBe(0)

      const accepted = await new CustomerInvitationService(scopedEm()).acceptInvitation(
        second.rawToken,
        'Password034!',
        'New Accepted',
      )
      expect(accepted?.user.email).toBe(email.toLowerCase())
      await expect(countUsersByEmail(ctx, email)).resolves.toBe(1)

      const acceptedRow = await readInvitation(first.invitation.id)
      expect(acceptedRow.token).toBe(hashToken(second.rawToken))
      expect(acceptedRow.acceptedAt).toBeTruthy()
      expect(acceptedRow.cancelledAt).toBeFalsy()
    } finally {
      await cleanupEmail(ctx, email)
    }
  })

  test('fresh failed attempt compensation after successful reuse touches zero rows and preserves the successful attempt', async ({ request }) => {
    const ctx = await loadContext(request)
    const email = uniqueEmail('fresh-compensation-race')
    await cleanupEmail(ctx, email)

    try {
      const roleA = ctx.roleIds[0]
      const roleB = ctx.roleIds[1] ?? roleA
      const attemptA = await createInvite(ctx, email, {
        roleIds: [roleA],
        invitedByUserId: inviterA,
        displayName: 'Attempt A',
      })

      const compensationBarrier = createBarrier()
      const compensation = (async () => {
        await compensationBarrier.wait()
        await expect(
          new CustomerInvitationService(scopedEm()).removeInvitation(attemptA.invitation, attemptA.attemptTokenHash),
        ).rejects.toThrow('Invitation rollback delete did not affect exactly one pending invitation')
        await expect(
          new CustomerInvitationService(scopedEm()).cancelInvitationAttempt(attemptA.invitation, attemptA.attemptTokenHash),
        ).resolves.toBe(false)
      })()
      await compensationBarrier.reached

      const attemptB = await createInvite(ctx, email, {
        roleIds: [roleB],
        invitedByUserId: inviterB,
        displayName: 'Attempt B',
      })
      expect(attemptB.invitation.id).toBe(attemptA.invitation.id)
      const attemptBSnapshot = await readInvitationSnapshot(attemptB.invitation.id)

      compensationBarrier.release()
      await compensation

      assertSnapshotUnchanged(await readInvitationSnapshot(attemptB.invitation.id), attemptBSnapshot)
      expect(await new CustomerInvitationService(scopedEm()).findByToken(attemptB.rawToken)).toBeTruthy()
    } finally {
      await cleanupEmail(ctx, email)
    }
  })

  test('stale restore compensation after successful reuse touches zero rows and preserves token roles provenance and expiry', async ({ request }) => {
    const ctx = await loadContext(request)
    const email = uniqueEmail('restore-compensation-race')
    await cleanupEmail(ctx, email)

    try {
      const roleSeed = ctx.roleIds[0]
      const roleA = ctx.roleIds[1] ?? roleSeed
      const roleB = ctx.roleIds[2] ?? roleA
      const seed = await createInvite(ctx, email, {
        roleIds: [roleSeed],
        invitedByUserId: inviterSeed,
        displayName: 'Seed Attempt',
      })
      const attemptA = await createInvite(ctx, email, {
        roleIds: [roleA],
        invitedByUserId: inviterA,
        displayName: 'Attempt A',
      })
      expect(attemptA.invitation.id).toBe(seed.invitation.id)
      expect(attemptA.rollbackSnapshot).toBeTruthy()

      const compensationBarrier = createBarrier()
      const compensation = (async () => {
        await compensationBarrier.wait()
        await expect(
          new CustomerInvitationService(scopedEm()).restoreInvitation(
            attemptA.invitation,
            attemptA.rollbackSnapshot!,
            attemptA.attemptTokenHash,
          ),
        ).rejects.toThrow('Invitation rollback restore did not affect exactly one pending invitation')
        await expect(
          new CustomerInvitationService(scopedEm()).cancelInvitationAttempt(attemptA.invitation, attemptA.attemptTokenHash),
        ).resolves.toBe(false)
      })()
      await compensationBarrier.reached

      const attemptB = await createInvite(ctx, email, {
        roleIds: [roleB],
        invitedByUserId: inviterB,
        displayName: 'Attempt B',
      })
      const attemptBSnapshot = await readInvitationSnapshot(attemptB.invitation.id)

      compensationBarrier.release()
      await compensation

      assertSnapshotUnchanged(await readInvitationSnapshot(attemptB.invitation.id), attemptBSnapshot)
      expect(await new CustomerInvitationService(scopedEm()).findByToken(attemptB.rawToken)).toBeTruthy()
    } finally {
      await cleanupEmail(ctx, email)
    }
  })

  test('accepted invitation cannot be restored or cancelled by a delayed rollback attempt', async ({ request }) => {
    const ctx = await loadContext(request)
    const email = uniqueEmail('accepted-before-rollback')
    await cleanupEmail(ctx, email)

    try {
      const roleSeed = ctx.roleIds[0]
      const roleA = ctx.roleIds[1] ?? roleSeed
      const seed = await createInvite(ctx, email, {
        roleIds: [roleSeed],
        invitedByUserId: inviterSeed,
        displayName: 'Seed Attempt',
      })
      const attemptA = await createInvite(ctx, email, {
        roleIds: [roleA],
        invitedByUserId: inviterA,
        displayName: 'Attempt A',
      })
      expect(attemptA.invitation.id).toBe(seed.invitation.id)
      expect(attemptA.rollbackSnapshot).toBeTruthy()

      const accepted = await new CustomerInvitationService(scopedEm()).acceptInvitation(
        attemptA.rawToken,
        'Password034!',
        'Accepted User',
      )
      expect(accepted?.user.email).toBe(email.toLowerCase())
      const acceptedSnapshot = await readInvitationSnapshot(attemptA.invitation.id)
      expect(acceptedSnapshot.acceptedAt).not.toBeNull()

      await expect(
        new CustomerInvitationService(scopedEm()).restoreInvitation(
          attemptA.invitation,
          attemptA.rollbackSnapshot!,
          attemptA.attemptTokenHash,
        ),
      ).rejects.toThrow('Invitation rollback restore did not affect exactly one pending invitation')
      await expect(
        new CustomerInvitationService(scopedEm()).cancelInvitationAttempt(attemptA.invitation, attemptA.attemptTokenHash),
      ).resolves.toBe(false)

      assertSnapshotUnchanged(await readInvitationSnapshot(attemptA.invitation.id), acceptedSnapshot)
      await expect(countUsersByEmail(ctx, email)).resolves.toBe(1)
    } finally {
      await cleanupEmail(ctx, email)
    }
  })
})
