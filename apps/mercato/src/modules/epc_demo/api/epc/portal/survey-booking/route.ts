import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { requireCustomerAuth, requireCustomerFeature } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import '@open-mercato/core/modules/customers/commands'
import {
  SurveyBookingError,
  bookSurveySlot,
  epcSurveyBookingOpenApi,
  epcSurveyBookingPostSchema,
  loadSurveyBookingState,
} from '../../../../lib/surveyBooking'
import { EPC_SURVEY_BOOKING_FEATURE } from '../../../../lib/surveyBookingTypes'

export const metadata = {
  path: '/epc/portal/survey-booking',
  GET: { requireAuth: false },
  POST: { requireAuth: false },
}

export async function GET(req: Request) {
  try {
    const auth = await requireCustomerAuth(req)
    const container = await createRequestContainer()
    const customerRbacService = container.resolve('customerRbacService') as CustomerRbacService
    await requireCustomerFeature(auth, [EPC_SURVEY_BOOKING_FEATURE], customerRbacService)

    const state = await loadSurveyBookingState({ container, auth })
    return NextResponse.json(state)
  } catch (error) {
    return handleSurveyBookingError(error, '[epc-survey-booking] failed to load state')
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireCustomerAuth(req)
    const container = await createRequestContainer()
    const customerRbacService = container.resolve('customerRbacService') as CustomerRbacService
    await requireCustomerFeature(auth, [EPC_SURVEY_BOOKING_FEATURE], customerRbacService)

    let payload: unknown
    try {
      payload = await req.json()
    } catch {
      return NextResponse.json({ ok: false, error: 'Invalid payload.' }, { status: 400 })
    }

    const parsed = epcSurveyBookingPostSchema.safeParse(payload)
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: 'Please choose an available survey slot.' }, { status: 400 })
    }

    const currentState = await loadSurveyBookingState({ container, auth })
    const existingBookingId = currentState.deals.find((deal) => deal.id === parsed.data.dealId)?.bookedSurvey?.id ?? null
    const guardResult = await runRouteMutationGuards({
      container,
      req,
      auth: {
        userId: auth.sub,
        tenantId: auth.tenantId,
        organizationId: auth.orgId,
        userFeatures: auth.resolvedFeatures,
      },
      input: {
        resourceKind: 'customers.interaction',
        resourceId: existingBookingId,
        operation: existingBookingId ? 'update' : 'create',
        mutationPayload: parsed.data,
      },
    })
    if (!guardResult.ok) {
      return guardResult.response
    }

    const effectivePayload = epcSurveyBookingPostSchema.parse({
      ...parsed.data,
      ...(guardResult.modifiedPayload ?? {}),
    })
    const result = await bookSurveySlot({
      container,
      auth,
      input: effectivePayload,
      request: req,
    })
    await guardResult.runAfterSuccess()

    return NextResponse.json({
      ok: true,
      booking: result.booking,
      state: result.state,
    })
  } catch (error) {
    return handleSurveyBookingError(error, '[epc-survey-booking] failed to book survey')
  }
}

export default GET

export const openApi = epcSurveyBookingOpenApi

function handleSurveyBookingError(error: unknown, logMessage: string): NextResponse {
  if (error instanceof Response) {
    return error as NextResponse
  }
  if (error instanceof SurveyBookingError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status })
  }
  console.error(logMessage, error)
  return NextResponse.json({ ok: false, error: 'Survey booking is unavailable right now.' }, { status: 500 })
}
