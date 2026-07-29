import { NextRequest, NextResponse } from 'next/server'
import type { OpenApiDocument, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { getWorkflowEndpointCatalog } from '../../lib/endpoint-catalog'
import { workflowsTag, workflowEndpointListResponseSchema, workflowErrorSchema } from '../openapi'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['workflows.definitions.view'],
}

export async function GET(
  request: NextRequest,
  context?: { openApiDocument?: OpenApiDocument },
) {
  try {
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(request)

    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
    const tenantId = auth.tenantId
    const organizationId = scope?.selectedId ?? auth.orgId

    if (!tenantId) {
      return NextResponse.json({ error: 'Missing tenant context' }, { status: 400 })
    }

    const rbacService = container.resolve('rbacService')
    const hasPermission = await rbacService.userHasAllFeatures(
      auth.sub,
      ['workflows.definitions.view'],
      { tenantId, organizationId },
    )

    if (!hasPermission) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
    }

    if (!context?.openApiDocument) {
      throw new Error('[internal] Missing generated OpenAPI document')
    }

    return NextResponse.json(
      await getWorkflowEndpointCatalog(context.openApiDocument),
    )
  } catch (error) {
    console.error('Error listing workflow endpoint catalog:', error)
    return NextResponse.json({ error: 'Failed to list workflow endpoint catalog' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: workflowsTag,
  summary: 'List the workflow endpoint catalog',
  methods: {
    GET: {
      summary: 'List endpoints available to CALL_API activities',
      description:
        'Returns the registered API paths, methods, parameters, and declared request and response schemas used by the workflow CALL_API editor.',
      responses: [
        {
          status: 200,
          description: 'Endpoint catalog projected from the registered OpenAPI surface',
          schema: workflowEndpointListResponseSchema,
        },
      ],
      errors: [
        { status: 400, description: 'Missing tenant context', schema: workflowErrorSchema },
        { status: 401, description: 'Unauthorized', schema: workflowErrorSchema },
        { status: 403, description: 'Insufficient permissions', schema: workflowErrorSchema },
        { status: 500, description: 'Internal server error', schema: workflowErrorSchema },
      ],
    },
  },
}
