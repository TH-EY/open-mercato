import { z } from 'zod'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { serializeOperationMetadata } from '@open-mercato/shared/lib/commands/operationMetadata'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CustomerDeal } from '@open-mercato/core/modules/customers/data/entities'
import { FinooAffiliate, FinooAffiliateTransaction, FinooDealAttribution } from '../../data/entities'
import { finooDealAttributionUpsertSchema } from '../../data/validators'
import type { FinooAffiliateService } from '../../lib/service'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['finoo_affiliates.view'] },
  PUT: { requireAuth: true, requireFeatures: ['finoo_affiliates.manage'] },
}

const dealQuerySchema = z.object({ dealId: z.string().uuid() })

async function resolveRequest(request: Request) {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId || !auth.sub) return null
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = organizationScope.selectedId ?? auth.orgId
  if (!organizationId) return null
  return { auth, container, organizationScope, scope: { tenantId: auth.tenantId, organizationId } }
}

async function requireDeal(em: EntityManager, dealId: string, scope: { tenantId: string; organizationId: string }): Promise<CustomerDeal | null> {
  return findOneWithDecryption(
    em,
    CustomerDeal,
    { id: dealId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    scope,
  )
}

export async function GET(request: Request): Promise<Response> {
  const resolved = await resolveRequest(request)
  if (!resolved) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = dealQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid Deal id' }, { status: 400 })
  const em = resolved.container.resolve('em') as EntityManager
  if (!await requireDeal(em, parsed.data.dealId, resolved.scope)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const service = resolved.container.resolve('finooAffiliateService') as FinooAffiliateService
  const [attribution, transaction, affiliates, affiliateMemberships, statuses] = await Promise.all([
    findOneWithDecryption(
      em,
      FinooDealAttribution,
      { dealId: parsed.data.dealId, ...resolved.scope, deletedAt: null },
      undefined,
      resolved.scope,
    ),
    findOneWithDecryption(
      em,
      FinooAffiliateTransaction,
      { dealId: parsed.data.dealId, ...resolved.scope },
      undefined,
      resolved.scope,
    ),
    service.listAffiliateUsers(resolved.scope),
    findWithDecryption(
      em,
      FinooAffiliate,
      { ...resolved.scope, deletedAt: null },
      undefined,
      resolved.scope,
    ),
    service.listCommissionStatuses(resolved.scope),
  ])
  const membershipByUserId = new Map(
    affiliateMemberships.flatMap((affiliate) => (
      affiliate.customerUserId ? [[affiliate.customerUserId, affiliate] as const] : []
    )),
  )
  const transactionProjection = transaction ? {
    id: transaction.id,
    affiliateUserId: transaction.affiliateUserId,
    amount: transaction.commissionAmount,
    currency: transaction.currency,
    status: transaction.commissionStatus,
    commissionMode: transaction.commissionMode,
    acceptedAt: transaction.acceptedAt.toISOString(),
  } : null
  return NextResponse.json({
    transaction: transactionProjection,
    attribution: attribution ? {
      id: attribution.id,
      dealId: attribution.dealId,
      affiliateUserId: attribution.affiliateUserId,
      affiliateCode: attribution.affiliateCode,
      companyName: attribution.companyName ?? null,
      landingPage: attribution.landingPage ?? null,
      initialReferrer: attribution.initialReferrer ?? null,
      commissionStatusEntryId: attribution.commissionStatusEntryId,
      commissionStatus: attribution.commissionStatus,
      commissionAmount: attribution.commissionAmount,
      leadAt: attribution.leadAt.toISOString(),
      transactionAt: attribution.transactionAt?.toISOString() ?? null,
      affiliateProgramStatus: transaction?.commissionStatus ?? 'processing',
      affiliateTransactionId: transaction?.id ?? null,
      affiliateTransactionAmount: transaction?.commissionAmount ?? null,
      affiliateTransactionCurrency: transaction?.currency ?? null,
      affiliateTransactionStatus: transaction?.commissionStatus ?? null,
      affiliateTransactionCommissionMode: transaction?.commissionMode ?? null,
      affiliateTransactionAcceptedAt: transaction?.acceptedAt.toISOString() ?? null,
      updatedAt: attribution.updatedAt.toISOString(),
    } : null,
    affiliates: affiliates.flatMap((user) => {
      const membership = membershipByUserId.get(user.id)
      if (membership && !membership.isActive) return []
      return [{
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        commissionMode: membership?.commissionMode ?? null,
      }]
    }),
    statuses: statuses.map((entry) => ({ id: entry.id, value: entry.normalizedValue, label: entry.label })),
  })
}

export async function PUT(request: Request): Promise<Response> {
  const resolved = await resolveRequest(request)
  if (!resolved) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = finooDealAttributionUpsertSchema.safeParse(await readJsonSafe(request, null))
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, { status: 400 })
  const em = resolved.container.resolve('em') as EntityManager
  if (!await requireDeal(em, parsed.data.dealId, resolved.scope)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const existing = await findOneWithDecryption(
    em,
    FinooDealAttribution,
    { dealId: parsed.data.dealId, ...resolved.scope, deletedAt: null },
    undefined,
    resolved.scope,
  )
  const guarded = await runRouteMutationGuards({
    container: resolved.container,
    req: request,
    auth: {
      userId: resolved.auth.sub,
      tenantId: resolved.scope.tenantId,
      organizationId: resolved.scope.organizationId,
    },
    input: {
      resourceKind: 'finoo_affiliates.deal_attribution',
      resourceId: existing?.id ?? parsed.data.dealId,
      operation: existing ? 'update' : 'create',
      mutationPayload: parsed.data,
    },
  })
  if (!guarded.ok) return guarded.response
  const input = finooDealAttributionUpsertSchema.parse(guarded.modifiedPayload ?? parsed.data)
  const commandBus = resolved.container.resolve('commandBus') as CommandBus
  try {
    const { result, logEntry } = await commandBus.execute<Record<string, unknown>, FinooDealAttribution>(
      'finoo_affiliates.deal_attributions.upsert',
      {
        input,
        ctx: {
          container: resolved.container,
          auth: resolved.auth as never,
          organizationScope: resolved.organizationScope,
          selectedOrganizationId: resolved.scope.organizationId,
          organizationIds: [resolved.scope.organizationId],
          request,
        },
      },
    )
    await guarded.runAfterSuccess()
    const response = NextResponse.json({ id: result.id, updatedAt: result.updatedAt.toISOString() })
    if (logEntry?.undoToken && logEntry?.id && logEntry?.commandId) {
      response.headers.set('x-om-operation', serializeOperationMetadata({
        id: logEntry.id,
        undoToken: logEntry.undoToken,
        commandId: logEntry.commandId,
        actionLabel: logEntry.actionLabel ?? null,
        resourceKind: logEntry.resourceKind ?? 'finoo_affiliates.deal_attribution',
        resourceId: logEntry.resourceId ?? result.id,
        executedAt: logEntry.createdAt instanceof Date ? logEntry.createdAt.toISOString() : new Date().toISOString(),
      }))
    }
    return response
  } catch (error) {
    if (isCrudHttpError(error)) return NextResponse.json(error.body, { status: error.status })
    throw error
  }
}

const attributionSchema = z.object({
  id: z.string().uuid(),
  dealId: z.string().uuid(),
  affiliateUserId: z.string().uuid(),
  affiliateCode: z.string(),
  companyName: z.string().nullable(),
  landingPage: z.string().nullable(),
  initialReferrer: z.string().nullable(),
  commissionStatusEntryId: z.string().uuid(),
  commissionStatus: z.enum(['approved', 'waiting', 'rejected']),
  commissionAmount: z.number().int(),
  leadAt: z.string().datetime(),
  transactionAt: z.string().datetime().nullable(),
  affiliateProgramStatus: z.enum(['processing', 'approved', 'rejected', 'paid_out']),
  affiliateTransactionId: z.string().uuid().nullable(),
  affiliateTransactionAmount: z.number().int().nullable(),
  affiliateTransactionCurrency: z.string().nullable(),
  affiliateTransactionStatus: z.enum(['processing', 'approved', 'rejected', 'paid_out']).nullable(),
  affiliateTransactionCommissionMode: z.enum(['legacy_deal_amount', 'percentage', 'fixed']).nullable(),
  affiliateTransactionAcceptedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
})

const transactionSchema = z.object({
  id: z.string().uuid(),
  affiliateUserId: z.string().uuid(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.enum(['processing', 'approved', 'rejected', 'paid_out']),
  commissionMode: z.enum(['legacy_deal_amount', 'percentage', 'fixed']),
  acceptedAt: z.string().datetime(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Affiliates',
  methods: {
    GET: {
      summary: 'Get Finoo affiliate and commission fields for a Deal',
      query: dealQuerySchema,
      responses: [{ status: 200, description: 'Deal attribution editor data', schema: z.object({ transaction: transactionSchema.nullable(), attribution: attributionSchema.nullable(), affiliates: z.array(z.object({ id: z.string().uuid(), displayName: z.string(), email: z.string().email(), commissionMode: z.enum(['percentage', 'fixed']).nullable() })), statuses: z.array(z.object({ id: z.string().uuid(), value: z.string(), label: z.string() })) }) }],
    },
    PUT: {
      summary: 'Create or update Finoo affiliate and commission fields for a Deal',
      requestBody: { schema: finooDealAttributionUpsertSchema },
      responses: [{ status: 200, description: 'Deal attribution saved', schema: z.object({ id: z.string().uuid(), updatedAt: z.string().datetime() }) }],
    },
  },
}
