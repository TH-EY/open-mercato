import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { finooPayoutConfirmSchema } from '../data/validators'
import { FinooAffiliatePayout } from '../data/entities'
import { emitFinooAffiliateEvent } from '../events'
import { createAffiliatePayout } from '../lib/payouts'

const inputSchema = finooPayoutConfirmSchema.extend({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})

const createPayoutCommand: CommandHandler<Record<string, unknown>, FinooAffiliatePayout> = {
  id: 'finoo_affiliates.payout.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = inputSchema.parse(rawInput)
    if (!ctx.systemActor) throw new CrudHttpError(403, { error: 'Forbidden' })
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const result = await createAffiliatePayout(
      em,
      ctx.container,
      input,
      { tenantId: input.tenantId, organizationId: input.organizationId },
    )
    if (!result.payout.createdEventPublishedAt) {
      await emitFinooAffiliateEvent('finoo_affiliates.affiliate_payout.created', {
        id: result.payout.id,
        affiliateId: result.payout.affiliateId,
        affiliateUserId: result.payout.affiliateUserId,
        paymentReference: result.payout.paymentReference,
        amount: result.payout.amount,
        currency: result.payout.currency,
        transactionIds: result.transactionIds,
        tenantId: result.payout.tenantId,
        organizationId: result.payout.organizationId,
      }, { persistent: true })
      const publishedAt = new Date()
      await em.nativeUpdate(
        FinooAffiliatePayout,
        {
          id: result.payout.id,
          tenantId: result.payout.tenantId,
          organizationId: result.payout.organizationId,
          createdEventPublishedAt: null,
        },
        { createdEventPublishedAt: publishedAt },
      )
      result.payout.createdEventPublishedAt = publishedAt
    }
    return result.payout
  },
  async buildLog({ result }) {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('finooAffiliates.audit.payouts.create', 'Create affiliate payout'),
      resourceKind: 'finoo_affiliates.affiliate_payout',
      resourceId: result.id,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      payload: { paymentReference: result.paymentReference, amount: result.amount, currency: result.currency },
    }
  },
}

registerCommand(createPayoutCommand)
