import type { EntityManager } from '@mikro-orm/postgresql'
import { LockMode } from '@mikro-orm/core'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLockWithGuards } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { FinooAffiliate } from '../data/entities'
import { finooAffiliateProfileSchema } from '../data/validators'
import { emitFinooAffiliateEvent } from '../events'

const updateProfileCommand: CommandHandler<Record<string, unknown>, FinooAffiliate> = {
  id: 'finoo_affiliates.affiliate.update_profile',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = finooAffiliateProfileSchema.parse(rawInput)
    const tenantId = ctx.auth?.tenantId
    const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId
    const customerUserId = ctx.auth?.sub
    if (!tenantId || !organizationId || !customerUserId) throw new CrudHttpError(403, { error: 'Forbidden' })
    const scope = { tenantId, organizationId }
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const affiliate = await em.transactional(async (transactionalEm) => {
      const locked = await findOneWithDecryption(
        transactionalEm,
        FinooAffiliate,
        { ...scope, customerUserId, isActive: true, deletedAt: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scope,
      )
      if (!locked) throw new CrudHttpError(404, { error: 'AFFILIATE_NOT_FOUND' })
      await enforceCommandOptimisticLockWithGuards(ctx.container, {
        resourceKind: 'finoo_affiliates.affiliate',
        resourceId: locked.id,
        current: locked.updatedAt,
        expected: input.updatedAt,
        request: ctx.request,
      })
      locked.accountHolderName = input.accountHolderName.trim() || null
      locked.accountNumber = input.accountNumber.trim().replace(/\s+/g, '') || null
      await transactionalEm.flush()
      return locked
    })
    await emitFinooAffiliateEvent('finoo_affiliates.affiliate.profile_updated', {
      id: affiliate.id,
      tenantId,
      organizationId,
    }, { persistent: true })
    return affiliate
  },
  buildLog() {
    return { skipLog: true }
  },
}

registerCommand(updateProfileCommand)
