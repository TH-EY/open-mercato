import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { readOptimisticLockExpected } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { finooCustomerRetentionSettingsChangeSchema } from '../../data/validators'
import { isRetentionSettingsError } from '../../services/settingsService'
import { retentionSettingsInternals } from '../../services/settingsService'
import { resolveRetentionSettingsContext } from './_context'

const logger = createLogger('finoo_customer_retention').child({ component: 'settings-route' })

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['customers.settings.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['customers.settings.manage'] },
}

const settingResponseSchema = z.object({
  inactivityWindowDays: z.number().int().min(1).max(3650).nullable(),
  reconciliationGeneration: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Customer Retention',
  methods: {
    GET: {
      summary: 'Read organization customer-retention settings',
      responses: [{
        status: 200,
        description: 'Current customer-retention settings',
        schema: z.object({ setting: settingResponseSchema, updatedAt: z.string().datetime() }),
      }],
    },
    PUT: {
      summary: 'Update organization customer-retention settings',
      requestBody: { schema: finooCustomerRetentionSettingsChangeSchema },
      responses: [{
        status: 202,
        description: 'Settings updated and reconciliation scheduled',
        schema: z.object({
          setting: settingResponseSchema,
          progressJobId: z.string().uuid(),
          updatedAt: z.string().datetime(),
        }),
      }],
    },
  },
}

function errorResponse(error: unknown): NextResponse {
  if (isRetentionSettingsError(error)) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
  }
  if (isCrudHttpError(error)) {
    return NextResponse.json(error.body, { status: error.status })
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'validation_failed', details: error.issues },
      { status: 400 },
    )
  }
  logger.error('Retention settings request failed', { err: error })
  return NextResponse.json(
    { error: 'Retention settings request failed', code: 'internal_error' },
    { status: 500 },
  )
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const context = await resolveRetentionSettingsContext(request)
    if (context instanceof NextResponse) return context
    const setting = await context.service.get({
      tenantId: context.tenantId,
      organizationId: context.organizationId,
    })
    return NextResponse.json({ setting, updatedAt: setting.updatedAt })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const context = await resolveRetentionSettingsContext(request)
    if (context instanceof NextResponse) return context
    if (!readOptimisticLockExpected(request)) {
      return NextResponse.json(
        { error: 'Expected settings version is required', code: 'optimistic_lock_required' },
        { status: 409 },
      )
    }
    const parsedPayload = finooCustomerRetentionSettingsChangeSchema.parse(
      await readJsonSafe(request, null),
    )
    const guarded = await runRouteMutationGuards({
      container: context.container,
      req: request,
      auth: {
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        userId: context.auth.sub,
      },
      input: {
        resourceKind: 'finoo_customer_retention.settings',
        resourceId: context.organizationId,
        operation: 'update',
        mutationPayload: parsedPayload,
      },
    })
    if (!guarded.ok) return guarded.response
    const payload = finooCustomerRetentionSettingsChangeSchema.parse(
      guarded.modifiedPayload ?? parsedPayload,
    )
    const { result } = await (context.container.resolve('commandBus') as CommandBus).execute(
      'finoo_customer_retention.settings.update',
      {
        input: {
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          inactivityWindowDays: payload.inactivityWindowDays,
          previewTokenHash: payload.previewToken
            ? retentionSettingsInternals.hashPreviewToken(payload.previewToken)
            : undefined,
          actorUserId: context.auth.sub,
        },
        ctx: {
          container: context.container,
          auth: context.auth,
          organizationScope: context.organizationScope,
          selectedOrganizationId: context.organizationId,
          organizationIds: [context.organizationId],
          request,
        },
      },
    ) as { result: Awaited<ReturnType<typeof context.service.update>> }
    await guarded.runAfterSuccess()
    return NextResponse.json(
      {
        setting: result.setting,
        progressJobId: result.progressJobId,
        updatedAt: result.setting.updatedAt,
      },
      { status: 202 },
    )
  } catch (error) {
    return errorResponse(error)
  }
}
