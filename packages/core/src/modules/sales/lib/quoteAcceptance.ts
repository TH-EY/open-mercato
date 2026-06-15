import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { sendEmail } from '@open-mercato/shared/lib/email/send'
import { SalesNote, SalesOrder, SalesQuote } from '../data/entities'
import { resolveStatusEntryIdByValue } from './statusHelpers'
import { QuoteAcceptedAdminEmail } from '../emails/QuoteAcceptedAdminEmail'

type RequestContainer = Awaited<ReturnType<typeof createRequestContainer>>

type Translate = (key: string, fallback: string, values?: Record<string, string | number>) => string

type AcceptanceScope = {
  tenantId?: string
  organizationId?: string
}

type ConvertToOrderResult = {
  result?: { orderId?: string } | null
  orderId?: string
}

type AcceptQuoteInput = {
  req: Request
  container: RequestContainer
  em: EntityManager
  auth: CommandRuntimeContext['auth'] | null
  scope?: AcceptanceScope
  translate: Translate
  loadQuoteForUpdate: (trx: EntityManager) => Promise<SalesQuote | null>
  acceptedBy?: {
    customerUserId: string
    email: string
    displayName: string
    acceptedByName: string
    acceptedTerms: true
    source: 'customer_portal'
  }
}

type PortalAcceptanceAudit = {
  source: 'customer_portal'
  acceptedAt: string
  acceptedByName: string
  acceptedByEmail: string
  acceptedByDisplayName: string
  acceptedByCustomerUserId: string
  acceptedTerms: true
}

function buildEncryptionScope(scope?: AcceptanceScope) {
  if (!scope?.tenantId) return undefined
  return {
    tenantId: scope.tenantId,
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
  }
}

async function notifyAdminQuoteAccepted(input: {
  quote: SalesQuote
  orderId: string
  orderNumber: string
  translate: Translate
  acceptedBy?: AcceptQuoteInput['acceptedBy']
}) {
  const adminEmail = process.env.ADMIN_EMAIL || ''
  if (!adminEmail) return

  try {
    const appUrl = process.env.APP_URL || ''
    const orderUrl = appUrl ? `${appUrl.replace(/\/$/, '')}/backend/sales/orders/${input.orderId}` : `/backend/sales/orders/${input.orderId}`

    const copy = {
      preview: input.translate('sales.quotes.accept.adminEmail.preview', 'Quote {quoteNumber} accepted', { quoteNumber: input.quote.quoteNumber }),
      heading: input.translate('sales.quotes.accept.adminEmail.heading', 'Quote {quoteNumber} accepted', { quoteNumber: input.quote.quoteNumber }),
      body: input.acceptedBy
        ? input.translate('sales.quotes.accept.adminEmail.bodyPortal', '{acceptedBy} accepted quote {quoteNumber}. An order has been created: {orderNumber}.', {
          acceptedBy: input.acceptedBy.acceptedByName,
          quoteNumber: input.quote.quoteNumber,
          orderNumber: input.orderNumber,
        })
        : input.translate('sales.quotes.accept.adminEmail.body', 'The customer accepted quote {quoteNumber}. An order has been created: {orderNumber}.', {
        quoteNumber: input.quote.quoteNumber,
        orderNumber: input.orderNumber,
      }),
      cta: input.translate('sales.quotes.accept.adminEmail.cta', 'View order'),
      footer: input.translate('sales.quotes.accept.adminEmail.footer', 'Open Mercato'),
    }

    await sendEmail({
      to: adminEmail,
      subject: input.translate('sales.quotes.accept.adminSubject', 'Quote {quoteNumber} accepted → Order {orderNumber}', {
        quoteNumber: input.quote.quoteNumber,
        orderNumber: input.orderNumber,
      }),
      react: QuoteAcceptedAdminEmail({ orderUrl, copy }),
      tenantId: input.quote.tenantId,
      organizationId: input.quote.organizationId,
    })
  } catch (err) {
    console.error('sales.quotes.accept.adminEmail failed', err)
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function buildPortalAcceptanceAudit(input: AcceptQuoteInput['acceptedBy'], acceptedAt: Date): PortalAcceptanceAudit | null {
  if (!input) return null
  return {
    source: input.source,
    acceptedAt: acceptedAt.toISOString(),
    acceptedByName: input.acceptedByName,
    acceptedByEmail: input.email,
    acceptedByDisplayName: input.displayName,
    acceptedByCustomerUserId: input.customerUserId,
    acceptedTerms: input.acceptedTerms,
  }
}

function buildAcceptanceNoteBody(quote: SalesQuote, orderNumber: string, audit: PortalAcceptanceAudit, translate: Translate): string {
  return translate(
    'sales.quotes.accept.auditNote',
    '{acceptedBy} accepted quote {quoteNumber} through the customer portal and accepted the terms. Order created: {orderNumber}.',
    {
      acceptedBy: audit.acceptedByName,
      quoteNumber: quote.quoteNumber,
      orderNumber,
    },
  )
}

export async function acceptQuoteAndConvertToOrder(input: AcceptQuoteInput): Promise<{
  quote: SalesQuote
  orderId: string
  orderNumber: string
}> {
  const commandBus = input.container.resolve('commandBus') as CommandBus
  const encryptionScope = buildEncryptionScope(input.scope)

  const { quote, orderId } = await input.em.transactional(async (trx) => {
    const quote = await input.loadQuoteForUpdate(trx)
    if (!quote) {
      throw new CrudHttpError(404, { error: input.translate('sales.quotes.accept.notFound', 'Quote not found.') })
    }

    const now = new Date()
    if (quote.validUntil && quote.validUntil.getTime() < now.getTime()) {
      throw new CrudHttpError(400, { error: input.translate('sales.quotes.accept.expired', 'This quote has expired.') })
    }

    if ((quote.status ?? null) !== 'sent') {
      throw new CrudHttpError(400, {
        error: input.translate('sales.quotes.accept.invalidStatus', 'This quote cannot be accepted in its current status.'),
      })
    }

    if (quote.convertedOrderId) {
      throw new CrudHttpError(400, {
        error: input.translate('sales.quotes.accept.alreadyConverted', 'This quote has already been converted to an order.'),
      })
    }

    const acceptanceAudit = buildPortalAcceptanceAudit(input.acceptedBy, now)

    quote.status = 'confirmed'
    quote.statusEntryId = await resolveStatusEntryIdByValue(trx, {
      tenantId: quote.tenantId,
      organizationId: quote.organizationId,
      value: 'confirmed',
    })
    if (acceptanceAudit) {
      quote.metadata = {
        ...readRecord(quote.metadata),
        portalAcceptance: acceptanceAudit,
      }
    }
    quote.updatedAt = now
    trx.persist(quote)
    await trx.flush()

    const ctx: CommandRuntimeContext = {
      container: input.container,
      auth: input.auth,
      organizationScope: null,
      selectedOrganizationId: quote.organizationId,
      organizationIds: [quote.organizationId],
      request: input.req,
      transactionalEm: trx,
    }

    const result = (await commandBus.execute('sales.quotes.convert_to_order', { input: { quoteId: quote.id }, ctx })) as ConvertToOrderResult | null
    const orderId = result?.result?.orderId ?? result?.orderId ?? quote.convertedOrderId ?? quote.id

    if (acceptanceAudit) {
      const order = await findOneWithDecryption(trx, SalesOrder, { id: orderId, deletedAt: null }, {}, encryptionScope)
      const orderNumber = order?.orderNumber ?? orderId
      const noteBody = buildAcceptanceNoteBody(quote, orderNumber, acceptanceAudit, input.translate)

      trx.persist(trx.create(SalesNote, {
        tenantId: quote.tenantId,
        organizationId: quote.organizationId,
        contextType: 'quote',
        contextId: quote.id,
        quote,
        authorUserId: acceptanceAudit.acceptedByCustomerUserId,
        appearanceIcon: 'check-circle',
        appearanceColor: 'green',
        body: noteBody,
        createdAt: now,
        updatedAt: now,
      }))

      if (order) {
        order.metadata = {
          ...readRecord(order.metadata),
          portalAcceptance: acceptanceAudit,
        }
        order.updatedAt = now
        trx.persist(order)
        trx.persist(trx.create(SalesNote, {
          tenantId: order.tenantId,
          organizationId: order.organizationId,
          contextType: 'order',
          contextId: order.id,
          order,
          authorUserId: acceptanceAudit.acceptedByCustomerUserId,
          appearanceIcon: 'check-circle',
          appearanceColor: 'green',
          body: noteBody,
          createdAt: now,
          updatedAt: now,
        }))
      }
      await trx.flush()
    }

    return { quote, orderId }
  })

  const order = await findOneWithDecryption(input.em, SalesOrder, { id: orderId, deletedAt: null }, {}, encryptionScope)
  const orderNumber = order?.orderNumber ?? orderId

  await notifyAdminQuoteAccepted({
    quote,
    orderId,
    orderNumber,
    translate: input.translate,
    acceptedBy: input.acceptedBy,
  })

  return { quote, orderId, orderNumber }
}

export function quoteLockOptions() {
  return { lockMode: LockMode.PESSIMISTIC_WRITE } as const
}
