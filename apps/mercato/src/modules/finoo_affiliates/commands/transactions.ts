import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { ensureOrganizationScope, ensureTenantScope } from '@open-mercato/shared/lib/commands/scope'
import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { z } from 'zod'
import { FinooAffiliateTransaction, type FinooAffiliateTransactionStatus } from '../data/entities'
import { finooAffiliateTransactionTransitionSchema } from '../data/validators'
import { emitFinooAffiliateEvent } from '../events'
import type { FinooScope } from '../lib/service'
import { createAffiliateTransactionForDeal, transitionAffiliateTransaction, undoAffiliateTransactionTransition } from '../lib/transactions'

const createSchema = z.object({
  dealId: z.string().uuid(),
  includeDeletedDeal: z.boolean().optional(),
})

type TransactionSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  commissionStatus: FinooAffiliateTransactionStatus
  updatedAt: string
}

type TransitionUndoPayload = { before: TransactionSnapshot; after: TransactionSnapshot }

function transactionSnapshot(transaction: FinooAffiliateTransaction): TransactionSnapshot {
  return {
    id: transaction.id,
    tenantId: transaction.tenantId,
    organizationId: transaction.organizationId,
    commissionStatus: transaction.commissionStatus,
    updatedAt: transaction.updatedAt.toISOString(),
  }
}

async function loadTransaction(em: EntityManager, id: string, scope: FinooScope): Promise<FinooAffiliateTransaction> {
  const transaction = await findOneWithDecryption(em, FinooAffiliateTransaction, { id, ...scope }, undefined, scope)
  if (!transaction) throw new CrudHttpError(404, { error: 'Not found' })
  return transaction
}

function requireScope(ctx: CommandRuntimeContext): FinooScope {
  const tenantId = ctx.auth?.tenantId
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId
  if (!tenantId || !organizationId) throw new CrudHttpError(403, { error: 'Forbidden' })
  ensureTenantScope(ctx, tenantId)
  ensureOrganizationScope(ctx, organizationId)
  return { tenantId, organizationId }
}

const createTransactionCommand: CommandHandler<Record<string, unknown>, FinooAffiliateTransaction | null> = {
  id: 'finoo_affiliates.transaction.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = createSchema.parse(rawInput)
    if (input.includeDeletedDeal && !ctx.systemActor) {
      throw new CrudHttpError(403, { error: 'Forbidden' })
    }
    const scope = requireScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const result = await createAffiliateTransactionForDeal(em, input.dealId, scope, {
      includeDeletedDeal: input.includeDeletedDeal,
    })
    if (result.transaction && !result.transaction.createdEventPublishedAt) {
      await emitFinooAffiliateEvent('finoo_affiliates.affiliate_transaction.created', {
        id: result.transaction.id,
        dealId: result.transaction.dealId,
        affiliateId: result.transaction.affiliateId,
        affiliateUserId: result.transaction.affiliateUserId,
        commissionStatus: result.transaction.commissionStatus,
        commissionAmount: result.transaction.commissionAmount,
        tenantId: result.transaction.tenantId,
        organizationId: result.transaction.organizationId,
      }, { persistent: true })
      const publishedAt = new Date()
      await em.nativeUpdate(
        FinooAffiliateTransaction,
        { id: result.transaction.id, ...scope, createdEventPublishedAt: null },
        { createdEventPublishedAt: publishedAt },
      )
      result.transaction.createdEventPublishedAt = publishedAt
    }
    return result.transaction
  },
}

const transitionTransactionCommand: CommandHandler<Record<string, unknown>, FinooAffiliateTransaction> = {
  id: 'finoo_affiliates.transaction.transition',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const id = z.string().uuid().parse(rawInput.id)
    const scope = requireScope(ctx)
    const em = ctx.container.resolve('em') as EntityManager
    return { before: transactionSnapshot(await loadTransaction(em, id, scope)) }
  },
  async execute(rawInput, ctx) {
    const id = z.string().uuid().parse(rawInput.id)
    const input = finooAffiliateTransactionTransitionSchema.parse(rawInput)
    const scope = requireScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const { transaction } = await transitionAffiliateTransaction(em, ctx.container, { id, ...input }, scope)
    await emitFinooAffiliateEvent('finoo_affiliates.affiliate_transaction.updated', {
      id: transaction.id,
      dealId: transaction.dealId,
      affiliateId: transaction.affiliateId,
      affiliateUserId: transaction.affiliateUserId,
      commissionStatus: transaction.commissionStatus,
      commissionAmount: transaction.commissionAmount,
      tenantId: transaction.tenantId,
      organizationId: transaction.organizationId,
    }, { persistent: true })
    return transaction
  },
  captureAfter: (_input, result) => transactionSnapshot(result),
  async buildLog({ snapshots, result }) {
    const before = snapshots.before as TransactionSnapshot | undefined
    if (!before) return null
    const after = transactionSnapshot(result)
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('finooAffiliates.audit.transactions.transition', 'Update affiliate transaction status'),
      resourceKind: 'finoo_affiliates.affiliate_transaction',
      resourceId: result.id,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotBefore: before,
      snapshotAfter: after,
      payload: { undo: { before, after } satisfies TransitionUndoPayload },
    }
  },
  async undo({ logEntry, ctx }) {
    const payload = extractUndoPayload<TransitionUndoPayload>(logEntry)
    if (!payload) return
    const scope = { tenantId: payload.before.tenantId, organizationId: payload.before.organizationId }
    const transaction = await undoAffiliateTransactionTransition(
      (ctx.container.resolve('em') as EntityManager).fork(),
      {
        id: payload.before.id,
        scope,
        beforeStatus: payload.before.commissionStatus,
        afterStatus: payload.after.commissionStatus,
        afterUpdatedAt: payload.after.updatedAt,
      },
    )
    await emitFinooAffiliateEvent('finoo_affiliates.affiliate_transaction.updated', {
      id: transaction.id,
      dealId: transaction.dealId,
      affiliateId: transaction.affiliateId,
      affiliateUserId: transaction.affiliateUserId,
      commissionStatus: transaction.commissionStatus,
      commissionAmount: transaction.commissionAmount,
      tenantId: transaction.tenantId,
      organizationId: transaction.organizationId,
    }, { persistent: true })
  },
}

registerCommand(createTransactionCommand)
registerCommand(transitionTransactionCommand)
