import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { getClientIp, RATE_LIMIT_ERROR_FALLBACK } from '@open-mercato/shared/lib/ratelimit/helpers'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import type { CredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import type { IntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { FinooApplicationIntake, FinooApplicationProjection } from '../../data/entities'
import { finooApplicationPayloadSchema, parseAndSanitizeFinooApplicationPayload } from '../../data/validators'
import { FINOO_APPLICATION_INTEGRATION_ID } from '../../integration'
import { FinooApplicationBodyTooLargeError, FinooApplicationInvalidUtf8Error, decodeFinooApplicationBody, hasOversizedFinooApplicationContentLength, readFinooApplicationBody } from '../../lib/body'
import { dispatchFinooApplicationIntake } from '../../lib/dispatch'
import { resolveFinooApplicationScope } from '../../lib/scope'
import { verifyFinooApplicationSignature } from '../../lib/signature'

export const metadata = { path: '/finoo_applications/intake', POST: { requireAuth: false } }

const RATE_LIMIT = { points: 120, duration: 60, keyPrefix: 'finoo_applications:intake' }
export async function POST(request: Request): Promise<NextResponse> {
  const scope = resolveFinooApplicationScope()
  if (!scope) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return NextResponse.json({ error: 'Invalid content type' }, { status: 415 })
  }
  if (hasOversizedFinooApplicationContentLength(request)) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  const container = await createRequestContainer()
  let rateLimiter: RateLimiterService
  try {
    rateLimiter = container.resolve('rateLimiterService') as RateLimiterService
  } catch {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
  const sourceIp = getClientIp(request, rateLimiter.trustProxyDepth)
  if (!sourceIp || isIP(sourceIp) === 0) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  let rateLimitResult: Awaited<ReturnType<RateLimiterService['consume']>>
  try {
    rateLimitResult = await rateLimiter.consume(
      `${scope.tenantId}:${sourceIp}`,
      RATE_LIMIT,
    )
  } catch {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
  if (rateLimitResult.consumedPoints < 1) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
  if (!rateLimitResult.allowed) {
    const retryAfter = String(Math.ceil(rateLimitResult.msBeforeNext / 1000))
    return NextResponse.json({ error: RATE_LIMIT_ERROR_FALLBACK }, {
      status: 429,
      headers: {
        'Retry-After': retryAfter,
        'X-RateLimit-Limit': String(RATE_LIMIT.points),
        'X-RateLimit-Remaining': String(rateLimitResult.remainingPoints),
        'X-RateLimit-Reset': retryAfter,
      },
    })
  }

  let body: Uint8Array
  try {
    body = await readFinooApplicationBody(request)
  } catch (error) {
    if (error instanceof FinooApplicationBodyTooLargeError) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
    throw error
  }

  const state = container.resolve('integrationStateService') as IntegrationStateService
  let enabled = false
  let credentials: Record<string, unknown> | null = null
  try {
    enabled = await state.isEnabled(FINOO_APPLICATION_INTEGRATION_ID, scope)
    credentials = await (container.resolve('integrationCredentialsService') as CredentialsService)
      .resolve(FINOO_APPLICATION_INTEGRATION_ID, scope)
  } catch {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
  if (!enabled) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  const secret = typeof credentials?.signingSecret === 'string' ? credentials.signingSecret.trim() : ''
  if (Buffer.byteLength(secret, 'utf8') < 32) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  const verified = verifyFinooApplicationSignature(body, request.headers, secret)
  if (!verified.ok) {
    return verified.reason === 'invalid_request'
      ? NextResponse.json({ error: 'Invalid request' }, { status: 400 })
      : NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let text: string
  let parsed: unknown
  try {
    text = decodeFinooApplicationBody(body)
    parsed = JSON.parse(text)
  } catch (error) {
    if (error instanceof FinooApplicationInvalidUtf8Error || error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
    }
    throw error
  }
  let payload: ReturnType<typeof parseAndSanitizeFinooApplicationPayload>
  try {
    payload = parseAndSanitizeFinooApplicationPayload(parsed, {
      ...verified,
      receivedAt: new Date().toISOString(),
      sourceIp,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const encryption = container.resolve('tenantEncryptionService') as TenantDataEncryptionService
  let encryptionAvailable = false
  try {
    const encryptedFields = await encryption.getEncryptedFieldNames(
      'finoo_applications:finoo_application_intake',
      scope.tenantId,
      scope.organizationId,
    )
    encryptionAvailable = encryption.isEnabled()
      && Boolean((await encryption.getDek(scope.tenantId))?.key)
      && encryptedFields.includes('payload_json')
  } catch {
    encryptionAvailable = false
  }
  if (!encryptionAvailable) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }

  const em = (container.resolve('em') as EntityManager).fork()
  const digest = createHash('sha256').update(body).digest('hex')
  const existing = await findOneWithDecryption(em, FinooApplicationIntake, { ...scope, messageId: verified.messageId }, undefined, scope)
  if (existing) {
    if (existing.bodyDigest !== digest) return NextResponse.json({ error: 'Message ID conflict' }, { status: 409 })
    if (existing.state !== 'processed' && existing.state !== 'failed') {
      await dispatchFinooApplicationIntake(em, { intakeId: existing.id, ...scope })
    }
    return NextResponse.json({ ok: true, duplicate: true, intakeId: existing.id })
  }

  let intake: FinooApplicationIntake
  try {
    intake = await em.transactional(async (transactionalEm) => {
      const projection = await findOneWithDecryption(
        transactionalEm,
        FinooApplicationProjection,
        { ...scope, externalLeadId: payload.leadId },
        { fields: ['id', 'applicantEntityId'] },
        scope,
      )
      if (projection?.applicantEntityId) {
        if (!container.hasRegistration('finooIdentityErasureCompletionGuard')) {
          throw new Error('[internal] Finoo identity erasure completion guard is unavailable')
        }
        const guard = container.resolve<{
          invalidateForRawWrite(input: {
            tenantId: string
            organizationId: string
            customerEntityId: string
            em: EntityManager
          }): Promise<void>
        }>('finooIdentityErasureCompletionGuard')
        await guard.invalidateForRawWrite({
          ...scope,
          customerEntityId: projection.applicantEntityId,
          em: transactionalEm,
        })
      }
      const created = transactionalEm.create(FinooApplicationIntake, {
        ...scope,
        messageId: verified.messageId,
        bodyDigest: digest,
        externalLeadId: payload.leadId,
        sourceTimestamp: new Date(verified.sourceTimestamp * 1000),
        payloadJson: payload,
      })
      await transactionalEm.persist(created).flush()
      return created
    })
  } catch (error) {
    const duplicate = await findOneWithDecryption(em.fork(), FinooApplicationIntake, { ...scope, messageId: verified.messageId }, undefined, scope)
    if (!duplicate) throw error
    if (duplicate.bodyDigest !== digest) return NextResponse.json({ error: 'Message ID conflict' }, { status: 409 })
    await dispatchFinooApplicationIntake(em.fork(), { intakeId: duplicate.id, ...scope })
    return NextResponse.json({ ok: true, duplicate: true, intakeId: duplicate.id })
  }
  await dispatchFinooApplicationIntake(em, { intakeId: intake.id, ...scope })
  return NextResponse.json({ ok: true, intakeId: intake.id }, { status: 202 })
}

const intakeResponseSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean().optional(),
  intakeId: z.string().uuid(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'FINOO Applications',
  methods: {
    POST: {
      summary: 'Accept a signed FINOO application submission',
      requestBody: { contentType: 'application/json', schema: finooApplicationPayloadSchema },
      responses: [
        { status: 202, description: 'Application accepted for projection', schema: intakeResponseSchema },
        { status: 200, description: 'Idempotent duplicate accepted', schema: intakeResponseSchema },
        { status: 400, description: 'Malformed request metadata or payload', schema: z.object({ error: z.string() }) },
        { status: 401, description: 'Signature verification failed', schema: z.object({ error: z.string() }) },
        { status: 409, description: 'Message ID reused with different content', schema: z.object({ error: z.string() }) },
        { status: 413, description: 'Payload exceeds 64 KiB', schema: z.object({ error: z.string() }) },
        { status: 415, description: 'Content type is not JSON', schema: z.object({ error: z.string() }) },
        { status: 429, description: 'Rate limit exceeded', schema: z.object({ error: z.string() }) },
        { status: 503, description: 'Integration or encryption is unavailable', schema: z.object({ error: z.string() }) },
      ],
    },
  },
}
