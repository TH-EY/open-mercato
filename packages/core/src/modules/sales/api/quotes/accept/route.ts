import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { getCachedRateLimiterService } from '@open-mercato/core/bootstrap'
import { readEndpointRateLimitConfig } from '@open-mercato/shared/lib/ratelimit/config'
import { checkRateLimit, getClientIp, rateLimitErrorSchema } from '@open-mercato/shared/lib/ratelimit/helpers'
import { validateSameOriginMutationRequest } from './originGuard'
import { hashAuthToken } from '../../../../auth/lib/tokenHash'
import { SalesQuote } from '../../../data/entities'
import { quoteAcceptSchema } from '../../../data/validators'
import { acceptQuoteAndConvertToOrder, quoteLockOptions } from '../../../lib/quoteAcceptance'

export const metadata = {
  POST: { requireAuth: false },
}

const quoteAcceptRateLimitConfig = readEndpointRateLimitConfig('SALES_QUOTES_ACCEPT', {
  points: 10,
  duration: 60,
  blockDuration: 300,
  keyPrefix: 'sales_quote_accept',
})

export async function POST(req: Request) {
  try {
    const { translate } = await resolveTranslations()
    const sameOriginViolation = validateSameOriginMutationRequest(req)
    if (sameOriginViolation) {
      return NextResponse.json(
        { error: translate('sales.quotes.accept.forbidden', 'Cross-site quote acceptance is not allowed.') },
        { status: 403 },
      )
    }

    const rateLimiterService = getCachedRateLimiterService()
    const clientIp = rateLimiterService ? getClientIp(req, rateLimiterService.trustProxyDepth) : null
    if (rateLimiterService && clientIp) {
      const rateLimitResponse = await checkRateLimit(
        rateLimiterService,
        quoteAcceptRateLimitConfig,
        clientIp,
        translate('api.errors.rateLimit', 'Too many requests. Please try again later.'),
      )
      if (rateLimitResponse) return rateLimitResponse
    }

    const { token } = quoteAcceptSchema.parse(await req.json().catch(() => ({})))
    const auth = await getAuthFromRequest(req)
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const hashedToken = hashAuthToken(token)
    const tenantScope = auth?.tenantId ? { tenantId: auth.tenantId } : undefined

    const { orderId, orderNumber } = await acceptQuoteAndConvertToOrder({
      req,
      container,
      em,
      auth: null,
      scope: tenantScope,
      translate,
      loadQuoteForUpdate: async (trx) => {
        const findQuoteByToken = (acceptanceToken: string) =>
          findOneWithDecryption(
            trx,
            SalesQuote,
            {
              acceptanceToken,
              ...(auth?.tenantId ? { tenantId: auth.tenantId } : {}),
              deletedAt: null,
            },
            quoteLockOptions(),
            tenantScope,
          )
        return (await findQuoteByToken(hashedToken)) ?? (await findQuoteByToken(token))
      },
    })

    return NextResponse.json({ orderId, orderNumber })
  } catch (err) {
    if (isCrudHttpError(err)) {
      return NextResponse.json(err.body, { status: err.status })
    }
    const { translate } = await resolveTranslations()
    console.error('sales.quotes.accept failed', err)
    return NextResponse.json({ error: translate('sales.quotes.accept.failed', 'Failed to accept quote.') }, { status: 400 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Sales',
  summary: 'Accept a quote (public)',
  methods: {
    POST: {
      summary: 'Accept quote and convert to order',
      requestBody: {
        contentType: 'application/json',
        schema: quoteAcceptSchema,
      },
      responses: [
        {
          status: 200,
          description: 'Quote accepted and order created',
          schema: z.object({ orderId: z.string().uuid(), orderNumber: z.string() }),
        },
        { status: 400, description: 'Invalid or expired quote', schema: z.object({ error: z.string() }) },
        { status: 403, description: 'Cross-site request rejected', schema: z.object({ error: z.string() }) },
        { status: 404, description: 'Quote not found', schema: z.object({ error: z.string() }) },
        { status: 429, description: 'Too many requests', schema: rateLimitErrorSchema },
      ],
    },
  },
}
