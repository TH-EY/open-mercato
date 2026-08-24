import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { readOptimisticLockExpected } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { finooCustomerRetentionPreviewSchema } from '../../../data/validators'
import { isRetentionSettingsError } from '../../../services/settingsService'
import { resolveRetentionSettingsContext } from '../_context'

const logger = createLogger('finoo_customer_retention').child({ component: 'settings-preview-route' })

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['customers.settings.manage'] },
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Finoo Customer Retention',
  methods: {
    POST: {
      summary: 'Preview an organization customer-retention policy change',
      requestBody: { schema: finooCustomerRetentionPreviewSchema },
      responses: [{
        status: 200,
        description: 'Short-lived retention impact preview',
        schema: z.object({
          token: z.string(),
          expiresAt: z.string().datetime(),
          updatedAt: z.string().datetime(),
          totalEligible: z.number().int().nonnegative(),
          newlyExpired: z.number().int().nonnegative(),
          alreadyExpired: z.number().int().nonnegative(),
        }),
      }],
    },
  },
}

export async function POST(request: Request): Promise<Response> {
  try {
    const context = await resolveRetentionSettingsContext(request)
    if (context instanceof NextResponse) return context
    if (!readOptimisticLockExpected(request)) {
      return NextResponse.json(
        { error: 'Expected settings version is required', code: 'optimistic_lock_required' },
        { status: 409 },
      )
    }
    const parsedPayload = finooCustomerRetentionPreviewSchema.parse(await readJsonSafe(request, null))
    const guarded = await runRouteMutationGuards({
      container: context.container,
      req: request,
      auth: {
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        userId: context.auth.sub,
      },
      input: {
        resourceKind: 'finoo_customer_retention.settings_preview',
        resourceId: context.organizationId,
        operation: 'update',
        mutationPayload: parsedPayload,
      },
    })
    if (!guarded.ok) return guarded.response
    const payload = finooCustomerRetentionPreviewSchema.parse(
      guarded.modifiedPayload ?? parsedPayload,
    )
    const { result } = await (context.container.resolve('commandBus') as CommandBus).execute(
      'finoo_customer_retention.settings.preview',
      {
        input: {
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          inactivityWindowDays: payload.inactivityWindowDays,
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
    ) as { result: Awaited<ReturnType<typeof context.service.preview>> }
    await guarded.runAfterSuccess()
    return NextResponse.json({
      token: result.token,
      expiresAt: result.expiresAt,
      updatedAt: result.updatedAt,
      totalEligible: result.totalEligible,
      newlyExpired: result.newlyExpired,
      alreadyExpired: result.alreadyExpired,
    })
  } catch (error) {
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
    logger.error('Retention preview request failed', { err: error })
    return NextResponse.json(
      { error: 'Retention preview request failed', code: 'internal_error' },
      { status: 500 },
    )
  }
}
