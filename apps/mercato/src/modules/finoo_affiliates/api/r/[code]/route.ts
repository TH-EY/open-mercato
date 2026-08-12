import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getCachedRateLimiterService } from '@open-mercato/core/bootstrap'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { readEndpointRateLimitConfig, readRateLimitConfig } from '@open-mercato/shared/lib/ratelimit/config'
import { getClientIp } from '@open-mercato/shared/lib/ratelimit/helpers'
import { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import type { FinooAffiliateService } from '../../../lib/service'
import {
  buildAffiliateDestination,
  buildAffiliateRateLimitKey,
  hashAffiliateVisitor,
  shouldCountAffiliateRequest,
} from '../../../lib/tracking'

const VISITOR_COOKIE = 'finoo_affiliate_visitor'
const VISITOR_COOKIE_SECONDS = 24 * 60 * 60
const codeSchema = z.string().regex(/^[A-Za-z0-9_-]{20,32}$/)
const logger = createLogger('finoo_affiliates').child({ component: 'tracked-redirect' })
const globalRateLimit = readRateLimitConfig()
const integrationTest = process.env.OM_INTEGRATION_TEST?.trim().toLowerCase() === 'true'
const integrationRateLimiter = integrationTest
  ? new RateLimiterService({
    enabled: true,
    strategy: 'memory',
    keyPrefix: 'finoo-integration',
    trustProxyDepth: 1,
  })
  : null
const clickRateLimit = readEndpointRateLimitConfig('FINOO_AFFILIATE_CLICK', {
  points: 120,
  duration: 60,
  blockDuration: 300,
  keyPrefix: 'finoo_affiliates:click',
})
const redirectRateLimit = readEndpointRateLimitConfig('FINOO_AFFILIATE_REDIRECT', {
  points: 300,
  duration: 60,
  blockDuration: 300,
  keyPrefix: 'finoo_affiliates:redirect',
})

export const metadata = {
  GET: { requireAuth: false },
  HEAD: { requireAuth: false },
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    if (!value.length) return null
    try {
      return decodeURIComponent(value)
    } catch {
      return null
    }
  }
  return null
}

function notFound(): Response {
  return Response.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
}

function unavailable(): Response {
  return Response.json({ error: 'Service unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
}

function rateLimited(retryAfterMs: number): Response {
  return Response.json(
    { error: 'Too many requests' },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      },
    },
  )
}

async function redirect(request: Request, context: { params: Promise<{ code: string }> | { code: string } }): Promise<Response> {
  const { code: rawCode } = await context.params
  const codeResult = codeSchema.safeParse(rawCode)
  if (!codeResult.success) return notFound()
  const rateLimiterService = globalRateLimit.enabled
    ? getCachedRateLimiterService()
    : integrationRateLimiter
  const clientIdentity = rateLimiterService
    ? getClientIp(request, rateLimiterService.trustProxyDepth)
    : null
  const rateLimitOperational = globalRateLimit.enabled || integrationTest
  if (rateLimitOperational) {
    if (!rateLimiterService || !clientIdentity) return unavailable()
    const endpointLimit = await rateLimiterService.consume(
      buildAffiliateRateLimitKey('redirect', clientIdentity),
      redirectRateLimit,
    )
    if (endpointLimit.consumedPoints === 0) return unavailable()
    if (!endpointLimit.allowed) return rateLimited(endpointLimit.msBeforeNext)
  }

  const container = await createRequestContainer()
  const service = container.resolve('finooAffiliateService') as FinooAffiliateService
  const link = await service.findActiveLinkByCode(codeResult.data)
  if (!link) return notFound()

  let destination: URL
  try {
    destination = buildAffiliateDestination(new URL(await service.requireAllowedDestination(link.destinationUrl)), link.code)
  } catch {
    return notFound()
  }

  const headers = new Headers({ Location: destination.toString(), 'Cache-Control': 'no-store' })
  const countable = shouldCountAffiliateRequest(request)
  const withinRateLimit = countable && rateLimitOperational && rateLimiterService && clientIdentity
    ? await rateLimiterService.consume(
      buildAffiliateRateLimitKey(link.id, clientIdentity),
      clickRateLimit,
    )
    : null
  const shouldRecord = countable && rateLimitOperational && (
    withinRateLimit?.allowed === true
    && withinRateLimit.consumedPoints > 0
  )
  if (shouldRecord) {
    const existingToken = readCookie(request, VISITOR_COOKIE)
    const visitorToken = existingToken ?? randomUUID()
    try {
      await service.recordUniqueVisit(link, hashAffiliateVisitor(visitorToken, link.id), new Date())
    } catch (error) {
      logger.error('Affiliate visit persistence failed', {
        err: error,
        affiliateLinkId: link.id,
        tenantId: link.tenantId,
        organizationId: link.organizationId,
      })
    }
    if (!existingToken) {
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
      headers.append('Set-Cookie', `${VISITOR_COOKIE}=${encodeURIComponent(visitorToken)}; Path=/; Max-Age=${VISITOR_COOKIE_SECONDS}; HttpOnly; SameSite=Lax${secure}`)
    }
  }
  return new Response(null, { status: 302, headers })
}

export const GET = redirect
export const HEAD = redirect

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Affiliates',
  pathParams: z.object({ code: codeSchema }),
  methods: {
    GET: {
      summary: 'Redirect through a tracked Finoo affiliate link',
      responses: [
        { status: 302, description: 'Redirect to the allowlisted application destination' },
        { status: 404, description: 'Link is unavailable', schema: z.object({ error: z.string() }) },
        { status: 429, description: 'Request rate limit exceeded', schema: z.object({ error: z.string() }) },
        { status: 503, description: 'Trusted client identity or rate limiting is unavailable', schema: z.object({ error: z.string() }) },
      ],
    },
  },
}
