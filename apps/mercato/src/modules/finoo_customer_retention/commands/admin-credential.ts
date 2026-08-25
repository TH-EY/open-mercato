import { LockMode, type EntityManager } from '@mikro-orm/postgresql'
import { Session, User } from '@open-mercato/core/modules/auth/data/entities'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { buildPasswordSchema } from '@open-mercato/shared/lib/auth/passwordPolicy'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { compare, hash } from 'bcryptjs'
import { z } from 'zod'

export const FINOO_ADMIN_EMAIL = 'admin@finoo.om.they.dev'

const ensureAdminCredentialSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  password: buildPasswordSchema({ maxLength: 256 }),
})

export type EnsureAdminCredentialResult = {
  id: string
  tenantId: string
  organizationId: string
  email: string
  credential: 'unchanged' | 'updated'
}

export async function persistExactFinooAdminCredential(input: {
  em: EntityManager
  tenantId: string
  organizationId: string
  userId: string
  password: string
}): Promise<EnsureAdminCredentialResult> {
  return input.em.transactional(async (transactionalEm) => {
    const user = await findOneWithDecryption(
      transactionalEm,
      User,
      {
        id: input.userId,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
      { tenantId: input.tenantId, organizationId: input.organizationId },
    )
    if (!user || user.email !== FINOO_ADMIN_EMAIL) {
      throw new Error('[internal] Finoo admin does not exist in the requested exact scope')
    }

    let credential: EnsureAdminCredentialResult['credential'] = 'unchanged'
    if (!user.passwordHash || !await compare(input.password, user.passwordHash)) {
      user.passwordHash = await hash(input.password, 10)
      await transactionalEm.flush()
      await transactionalEm.nativeDelete(Session, { user: input.userId })
      credential = 'updated'
    }

    return {
      id: user.id,
      tenantId: String(user.tenantId),
      organizationId: String(user.organizationId),
      email: user.email,
      credential,
    }
  })
}

async function invalidateUserAccessCache(ctx: CommandRuntimeContext, userId: string): Promise<void> {
  try {
    const rbacService = ctx.container.resolve('rbacService') as {
      invalidateUserCache: (id: string) => Promise<void>
    }
    await rbacService.invalidateUserCache(userId)
  } catch {
    // RBAC is optional in CLI bootstrap contexts.
  }
  try {
    const cache = ctx.container.resolve('cache') as {
      deleteByTags?: (tags: string[]) => Promise<void>
    }
    await cache.deleteByTags?.([`rbac:user:${userId}`])
  } catch {
    // Cache is optional in CLI bootstrap contexts.
  }
}

export const ensureAdminCredentialCommand: CommandHandler<unknown, EnsureAdminCredentialResult> = {
  id: 'finoo_customer_retention.admin.ensure_credential',
  isUndoable: false,
  async execute(rawInput, ctx) {
    if (ctx.systemActor !== true || ctx.auth !== null) {
      throw new Error('[internal] Finoo admin credential command requires a system actor')
    }
    const input = ensureAdminCredentialSchema.parse(rawInput)
    const result = await persistExactFinooAdminCredential({
      em: ctx.container.resolve('em') as EntityManager,
      ...input,
    })
    if (result.credential === 'updated') {
      await invalidateUserAccessCache(ctx, result.id)
    }
    return result
  },
}
