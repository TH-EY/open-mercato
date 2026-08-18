import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import {
  finooPayoutBatchConfirmSchema,
  finooPayoutLegacyConfirmSchema,
} from '../data/validators'
import { FinooAffiliatePayout } from '../data/entities'
import { emitFinooAffiliateEvent } from '../events'
import { createAffiliatePayout, createAffiliatePayoutBatch } from '../lib/payouts'

const scopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})
const inputSchema = finooPayoutLegacyConfirmSchema.and(scopeSchema)
const batchInputSchema = finooPayoutBatchConfirmSchema.and(scopeSchema)

async function publishPayoutCreated(
  em: EntityManager,
  payout: FinooAffiliatePayout,
  transactionIds: string[],
): Promise<void> {
  if (payout.createdEventPublishedAt) return
  await emitFinooAffiliateEvent('finoo_affiliates.affiliate_payout.created', {
    id: payout.id,
    affiliateId: payout.affiliateId,
    affiliateUserId: payout.affiliateUserId,
    paymentReference: payout.paymentReference,
    amount: payout.amount,
    currency: payout.currency,
    transactionIds,
    tenantId: payout.tenantId,
    organizationId: payout.organizationId,
  }, { persistent: true })
  const publishedAt = new Date()
  await em.nativeUpdate(
    FinooAffiliatePayout,
    {
      id: payout.id,
      tenantId: payout.tenantId,
      organizationId: payout.organizationId,
      createdEventPublishedAt: null,
    },
    { createdEventPublishedAt: publishedAt },
  )
  payout.createdEventPublishedAt = publishedAt
}

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
    await publishPayoutCreated(em, result.payout, result.transactionIds)
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

type BatchCommandResult = {
  payouts: FinooAffiliatePayout[]
  paymentReferences: string[]
}

const createPayoutBatchCommand: CommandHandler<Record<string, unknown>, BatchCommandResult> = {
  id: 'finoo_affiliates.payout_batch.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = batchInputSchema.parse(rawInput)
    if (!ctx.systemActor) throw new CrudHttpError(403, { error: 'Forbidden' })
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const result = await createAffiliatePayoutBatch(
      em,
      ctx.container,
      input.groups,
      input.batchId,
      { tenantId: input.tenantId, organizationId: input.organizationId },
    )
    for (const item of result.payouts) {
      await publishPayoutCreated(em, item.payout, item.transactionIds)
    }
    return {
      payouts: result.payouts.map((item) => item.payout),
      paymentReferences: result.payouts.map((item) => item.payout.paymentReference),
    }
  },
  async buildLog({ result }) {
    const { translate } = await resolveTranslations()
    const first = result.payouts[0]
    return {
      actionLabel: translate('finooAffiliates.audit.payouts.createBatch', 'Create affiliate payout batch'),
      resourceKind: 'finoo_affiliates.affiliate_payout_batch',
      resourceId: result.paymentReferences.sort().join(','),
      tenantId: first?.tenantId,
      organizationId: first?.organizationId,
      payload: { payoutIds: result.payouts.map((payout) => payout.id), paymentReferences: result.paymentReferences },
    }
  },
}

registerCommand(createPayoutCommand)
registerCommand(createPayoutBatchCommand)
