import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { checkAuthRateLimit } from '@open-mercato/core/modules/auth/lib/rateLimitCheck'
import { readEndpointRateLimitConfig } from '@open-mercato/shared/lib/ratelimit/config'
import '@open-mercato/core/modules/customers/commands'
import {
  createEpcLeadFromCapture,
  epcLeadCaptureOpenApi,
  epcLeadCaptureSchema,
  resolveEpcLeadCaptureCorsConfig,
  resolveEpcLeadCaptureScope,
} from '../../../lib/leadCapture'

const epcLeadCaptureIpRateLimitConfig = readEndpointRateLimitConfig('EPC_LEAD_CAPTURE_IP', {
  points: 8,
  duration: 300,
  blockDuration: 300,
  keyPrefix: 'epc-lead-capture-ip',
})

export const metadata = {
  path: '/epc/lead-capture',
  OPTIONS: {
    requireAuth: false,
  },
  POST: {
    requireAuth: false,
  },
}

export async function OPTIONS(req: Request) {
  const cors = resolveEpcLeadCaptureCorsConfig(req.headers.get('origin'), req.url)
  if (!cors.allowed) {
    return new NextResponse(null, { status: 403, headers: cors.headers })
  }
  return new NextResponse(null, { status: 204, headers: cors.headers })
}

export async function POST(req: Request) {
  const cors = resolveEpcLeadCaptureCorsConfig(req.headers.get('origin'), req.url)
  if (!cors.allowed) {
    return NextResponse.json({ ok: false, error: 'Origin is not allowed.' }, { status: 403, headers: cors.headers })
  }

  const { error: rateLimitError } = await checkAuthRateLimit({
    req,
    ipConfig: epcLeadCaptureIpRateLimitConfig,
  })
  if (rateLimitError) return withCors(rateLimitError, cors.headers)

  let payload: unknown
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid payload' }, { status: 400, headers: cors.headers })
  }

  const parsed = epcLeadCaptureSchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Please check the form and try again.' }, { status: 400, headers: cors.headers })
  }

  if (parsed.data.companyWebsite.length > 0) {
    return NextResponse.json({ ok: true }, { headers: cors.headers })
  }

  const scope = resolveEpcLeadCaptureScope()
  if (!scope) {
    console.error('[epc-lead-capture] missing EPC_LEAD_TENANT_ID or EPC_LEAD_ORGANIZATION_ID')
    return NextResponse.json({ ok: false, error: 'Lead capture is not configured.' }, { status: 500, headers: cors.headers })
  }

  try {
    const container = await createRequestContainer()
    const result = await createEpcLeadFromCapture({
      input: parsed.data,
      scope,
      container,
      request: req,
    })
    return NextResponse.json({ ok: true, dealId: result.dealId }, { headers: cors.headers })
  } catch (err) {
    console.error('[epc-lead-capture] failed to create lead', err)
    return NextResponse.json({ ok: false, error: 'Failed to submit your request. Please try again.' }, { status: 500, headers: cors.headers })
  }
}

export default POST

export const openApi = epcLeadCaptureOpenApi

function withCors(response: Response, headers: Record<string, string>): Response {
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value)
  }
  return response
}
