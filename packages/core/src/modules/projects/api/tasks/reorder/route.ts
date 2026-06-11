import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { parseScopedCommandInput } from '@open-mercato/shared/lib/api/scoped'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { projectTaskReorderSchema, type ProjectTaskReorderInput } from '../../../data/validators'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['projects.tasks.manage'] },
}

async function buildContext(req: Request): Promise<{
  ctx: CommandRuntimeContext
  translate: (key: string, fallback?: string) => string
}> {
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(req)
  const { translate } = await resolveTranslations()
  if (!auth) throw new CrudHttpError(401, { error: translate('projects.errors.unauthorized', 'Unauthorized') })
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const ctx: CommandRuntimeContext = {
    container,
    auth,
    organizationScope: scope,
    selectedOrganizationId: scope?.selectedId ?? auth.orgId ?? null,
    organizationIds: scope?.filterIds ?? (auth.orgId ? [auth.orgId] : null),
    request: req,
  }
  return { ctx, translate }
}

export async function POST(req: Request) {
  try {
    const { ctx, translate } = await buildContext(req)
    const body = await req.json().catch(() => ({}))
    const input = parseScopedCommandInput(projectTaskReorderSchema, body, ctx, translate)
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<ProjectTaskReorderInput, { moved: number }>('projects.tasks.reorder', {
      input,
      ctx,
    })
    return NextResponse.json({ ok: true, moved: result?.moved ?? 0 })
  } catch (error) {
    if (isCrudHttpError(error)) {
      return NextResponse.json(error.body, { status: error.status })
    }
    console.error('projects.tasks.reorder failed', error)
    const { translate } = await resolveTranslations()
    return NextResponse.json({ error: translate('projects.tasks.reorder.error', 'Failed to reorder tasks.') }, { status: 400 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Projects',
  summary: 'Reorder project tasks',
  methods: {
    POST: {
      summary: 'Reorder project tasks',
      description: 'Persists task status and position changes for a project Kanban board.',
      requestBody: {
        contentType: 'application/json',
        schema: projectTaskReorderSchema,
      },
      responses: [
        { status: 200, description: 'Tasks reordered', schema: z.object({ ok: z.boolean(), moved: z.number() }) },
        { status: 400, description: 'Invalid payload', schema: z.object({ error: z.string() }) },
        { status: 401, description: 'Unauthorized', schema: z.object({ error: z.string() }) },
      ],
    },
  },
}
