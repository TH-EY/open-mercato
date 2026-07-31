import { EntityManager } from '@mikro-orm/postgresql'
import { hash } from 'bcryptjs'
import {
  CustomerUser,
  CustomerUserInvitation,
  CustomerUserRole,
  CustomerRole,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import { generateSecureToken, hashToken } from '@open-mercato/core/modules/customer_accounts/lib/tokenGenerator'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { isOwnedCompanyEntity } from '@open-mercato/core/modules/customer_accounts/lib/customerEntityOwnership'

const BCRYPT_COST = 10
const INVITATION_TTL_MS = 72 * 60 * 60 * 1000 // 72 hours

type InvitationRollbackSnapshot = {
  email: string
  emailHash: string
  token: string
  customerEntityId?: string | null
  roleIdsJson?: string[] | null
  invitedByUserId?: string | null
  invitedByCustomerUserId?: string | null
  displayName?: string | null
  expiresAt: Date
}

type CreateInvitationResult = {
  invitation: CustomerUserInvitation
  rawToken: string
  attemptTokenHash: string
  reused: boolean
  rollbackSnapshot?: InvitationRollbackSnapshot
}

function snapshotInvitation(invitation: CustomerUserInvitation): InvitationRollbackSnapshot {
  return {
    email: invitation.email,
    emailHash: invitation.emailHash,
    token: invitation.token,
    customerEntityId: invitation.customerEntityId ?? null,
    roleIdsJson: Array.isArray(invitation.roleIdsJson) ? [...invitation.roleIdsJson] : invitation.roleIdsJson ?? null,
    invitedByUserId: invitation.invitedByUserId ?? null,
    invitedByCustomerUserId: invitation.invitedByCustomerUserId ?? null,
    displayName: invitation.displayName ?? null,
    expiresAt: new Date(invitation.expiresAt),
  }
}

export class CustomerInvitationService {
  constructor(private em: EntityManager) {}

  async createInvitation(
    email: string,
    scope: { tenantId: string; organizationId: string },
    options: {
      customerEntityId?: string | null
      roleIds: string[]
      invitedByUserId?: string | null
      invitedByCustomerUserId?: string | null
      displayName?: string | null
    },
  ): Promise<CreateInvitationResult> {
    const token = generateSecureToken()
    const emailHash = hashForLookup(email)
    const normalizedEmail = email.toLowerCase().trim()
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)
    const tokenHashed = hashToken(token)

    // Dedupe: reuse an existing pending (not accepted, not cancelled, unexpired)
    // invitation for the same recipient instead of inserting a new row. This caps
    // row/token growth and keeps a single live token per concurrently-pending
    // (tenant, organization, email) tuple.
    const existing = await findOneWithDecryption(
      this.em,
      CustomerUserInvitation,
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        emailHash,
        acceptedAt: null,
        cancelledAt: null,
        expiresAt: { $gt: new Date() },
      } as any,
      undefined,
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )

    if (existing) {
      const rollbackSnapshot = snapshotInvitation(existing)
      existing.email = normalizedEmail
      existing.token = tokenHashed
      existing.customerEntityId = options.customerEntityId || null
      existing.roleIdsJson = options.roleIds
      existing.invitedByUserId = options.invitedByUserId || null
      existing.invitedByCustomerUserId = options.invitedByCustomerUserId || null
      existing.displayName = options.displayName || null
      existing.expiresAt = expiresAt
      await this.em.flush()
      return { invitation: existing, rawToken: token, attemptTokenHash: tokenHashed, reused: true, rollbackSnapshot }
    }

    const invitation = this.em.create(CustomerUserInvitation, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      email: normalizedEmail,
      emailHash,
      token: tokenHashed,
      customerEntityId: options.customerEntityId || null,
      roleIdsJson: options.roleIds,
      invitedByUserId: options.invitedByUserId || null,
      invitedByCustomerUserId: options.invitedByCustomerUserId || null,
      displayName: options.displayName || null,
      expiresAt,
      createdAt: new Date(),
    } as any) as CustomerUserInvitation
    await this.em.persist(invitation).flush()
    return { invitation, rawToken: token, attemptTokenHash: tokenHashed, reused: false }
  }

  async removeInvitation(invitation: CustomerUserInvitation, attemptTokenHash: string): Promise<void> {
    const affected = await this.em.nativeDelete(CustomerUserInvitation, {
      id: invitation.id,
      tenantId: invitation.tenantId,
      organizationId: invitation.organizationId,
      token: attemptTokenHash,
      acceptedAt: null,
      cancelledAt: null,
      expiresAt: { $gt: new Date() },
    } as any)
    if (affected !== 1) {
      throw new Error('Invitation rollback delete did not affect exactly one pending invitation')
    }
  }

  async restoreInvitation(
    invitation: CustomerUserInvitation,
    snapshot: InvitationRollbackSnapshot,
    attemptTokenHash: string,
  ): Promise<void> {
    const restoredRoleIds = Array.isArray(snapshot.roleIdsJson) ? [...snapshot.roleIdsJson] : snapshot.roleIdsJson ?? null
    const affected = await this.em.nativeUpdate(
      CustomerUserInvitation,
      {
        id: invitation.id,
        tenantId: invitation.tenantId,
        organizationId: invitation.organizationId,
        token: attemptTokenHash,
        acceptedAt: null,
        cancelledAt: null,
        expiresAt: { $gt: new Date() },
      } as any,
      {
        email: snapshot.email,
        emailHash: snapshot.emailHash,
        token: snapshot.token,
        customerEntityId: snapshot.customerEntityId ?? null,
        roleIdsJson: restoredRoleIds,
        invitedByUserId: snapshot.invitedByUserId ?? null,
        invitedByCustomerUserId: snapshot.invitedByCustomerUserId ?? null,
        displayName: snapshot.displayName ?? null,
        expiresAt: new Date(snapshot.expiresAt),
      } as any,
    )
    if (affected !== 1) {
      throw new Error('Invitation rollback restore did not affect exactly one pending invitation')
    }

    invitation.email = snapshot.email
    invitation.emailHash = snapshot.emailHash
    invitation.token = snapshot.token
    invitation.customerEntityId = snapshot.customerEntityId ?? null
    invitation.roleIdsJson = restoredRoleIds
    invitation.invitedByUserId = snapshot.invitedByUserId ?? null
    invitation.invitedByCustomerUserId = snapshot.invitedByCustomerUserId ?? null
    invitation.displayName = snapshot.displayName ?? null
    invitation.expiresAt = new Date(snapshot.expiresAt)
  }

  async cancelInvitationAttempt(invitation: CustomerUserInvitation, attemptTokenHash: string): Promise<boolean> {
    const affected = await this.em.nativeUpdate(
      CustomerUserInvitation,
      {
        id: invitation.id,
        tenantId: invitation.tenantId,
        organizationId: invitation.organizationId,
        token: attemptTokenHash,
        acceptedAt: null,
        cancelledAt: null,
        expiresAt: { $gt: new Date() },
      } as any,
      { cancelledAt: new Date() } as any,
    )
    return affected === 1
  }

  async findByToken(token: string): Promise<CustomerUserInvitation | null> {
    const tokenHashed = hashToken(token)
    const invitation = await findOneWithDecryption(
      this.em,
      CustomerUserInvitation,
      { token: tokenHashed } as any,
    )
    if (!invitation) return null
    if (invitation.acceptedAt) return null
    if (invitation.cancelledAt) return null
    if (invitation.expiresAt.getTime() < Date.now()) return null
    return invitation
  }

  async acceptInvitation(
    token: string,
    password: string,
    displayName: string,
  ): Promise<{ user: CustomerUser; invitation: CustomerUserInvitation } | null> {
    const tokenHashed = hashToken(token)
    const passwordHash = await hash(password, BCRYPT_COST)
    const invitation = await this.findByToken(token)
    if (!invitation) return null

    return this.em.transactional(async (tx) => {
      const acceptedAt = new Date()
      const roleIds = Array.isArray(invitation.roleIdsJson) ? invitation.roleIdsJson : []
      const roles = roleIds.length > 0
        ? await findWithDecryption(
            tx,
            CustomerRole,
            {
              id: { $in: roleIds } as any,
              tenantId: invitation.tenantId,
              organizationId: invitation.organizationId,
              deletedAt: null,
            } as any,
            undefined,
            { tenantId: invitation.tenantId, organizationId: invitation.organizationId },
          )
        : []
      const foundRoleIds = new Set(roles.map((role) => role.id))
      if (roleIds.some((roleId) => !foundRoleIds.has(roleId))) return null
      if (invitation.customerEntityId) {
        const ownsCustomerEntity = await isOwnedCompanyEntity(tx, invitation.customerEntityId, {
          tenantId: invitation.tenantId,
          organizationId: invitation.organizationId,
        })
        if (!ownsCustomerEntity) return null
      }

      const affected = await tx.nativeUpdate(
        CustomerUserInvitation,
        {
          id: invitation.id,
          tenantId: invitation.tenantId,
          organizationId: invitation.organizationId,
          token: tokenHashed,
          acceptedAt: null,
          cancelledAt: null,
          expiresAt: { $gt: acceptedAt },
        } as any,
        { acceptedAt } as any,
      )
      if (affected !== 1) return null

      const emailHash = hashForLookup(invitation.email)
      const user = tx.create(CustomerUser, {
        email: invitation.email,
        emailHash,
        passwordHash,
        displayName: displayName || invitation.displayName || invitation.email,
        tenantId: invitation.tenantId,
        organizationId: invitation.organizationId,
        customerEntityId: invitation.customerEntityId || null,
        isActive: true,
        emailVerifiedAt: acceptedAt,
        failedLoginAttempts: 0,
        createdAt: acceptedAt,
      } as any) as CustomerUser
      tx.persist(user)

      for (const role of roles) {
        const userRole = tx.create(CustomerUserRole, {
          user,
          role,
          createdAt: acceptedAt,
        } as any)
        tx.persist(userRole)
      }

      invitation.acceptedAt = acceptedAt
      await tx.flush()
      return { user, invitation }
    })
  }
}
