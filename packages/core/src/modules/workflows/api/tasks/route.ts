/**
 * User Tasks API
 *
 * Endpoints:
 * - GET /api/workflows/tasks - List user tasks
 */

import { NextRequest, NextResponse } from 'next/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { resolveOrganizationScopeFilter } from '@open-mercato/core/modules/directory/utils/organizationScopeFilter'
import { UserTask, WorkflowInstance } from '../../data/entities'
import { buildPersonalTaskFilter, canActorClaimTask, canActorCompleteTask } from '../../lib/task-access'
import {
  workflowsTag,
  userTaskListQuerySchema,
  userTaskListResponseSchema,
  workflowErrorSchema,
} from '../openapi'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['workflows.tasks.view'],
}

/**
 * GET /api/workflows/tasks
 *
 * List user tasks with optional filters
 *
 * Query params:
 * - status: Filter by task status (PENDING, IN_PROGRESS, COMPLETED, CANCELLED)
 * - assignedTo: Filter by assigned user ID
 * - workflowInstanceId: Filter by workflow instance
 * - overdue: Filter overdue tasks (true/false)
 * - myTasks: Show only tasks assigned to or claimable by current user (true/false)
 * - limit: Number of results (default 50)
 * - offset: Pagination offset (default 0)
 */
export async function GET(request: NextRequest) {
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em')
    const auth = await getAuthFromRequest(request)

    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
    const tenantId = auth.tenantId
    const orgFilter = resolveOrganizationScopeFilter(scope, auth)

    if (!tenantId) {
      return NextResponse.json(
        { error: 'Missing tenant context' },
        { status: 400 }
      )
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const assignedTo = searchParams.get('assignedTo')
    const workflowInstanceId = searchParams.get('workflowInstanceId')
    const entityType = searchParams.get('entityType')
    const entityId = searchParams.get('entityId')
    const overdue = searchParams.get('overdue') === 'true'
    const myTasks = searchParams.get('myTasks') === 'true'
    const order = searchParams.get('order')
    const limit = parseInt(searchParams.get('limit') || '50')
    const offset = parseInt(searchParams.get('offset') || '0')

    if (!!entityType !== !!entityId) {
      return NextResponse.json(
        { error: 'entityType and entityId must be provided together' },
        { status: 400 }
      )
    }

    if (!myTasks) {
      const rbacService = container.resolve('rbacService') as {
        userHasAllFeatures: (
          userId: string,
          features: string[],
          scope: { tenantId: string | null; organizationId: string | null }
        ) => Promise<boolean>
      }
      const canManage = await rbacService.userHasAllFeatures(
        auth.sub,
        ['workflows.manage'],
        { tenantId, organizationId: scope?.selectedId ?? auth.orgId ?? null }
      )
      if (!canManage) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // Build where clause with tenant scoping
    const where: any = {
      tenantId,
      ...orgFilter.where,
    }

    if (status) {
      // Handle comma-separated status values
      const statusValues = status.split(',').map(s => s.trim()).filter(Boolean)
      if (statusValues.length === 1) {
        where.status = statusValues[0]
      } else if (statusValues.length > 1) {
        where.status = { $in: statusValues }
      }
    }

    if (assignedTo) {
      where.assignedTo = assignedTo
    }

    if (workflowInstanceId) {
      where.workflowInstanceId = workflowInstanceId
    }

    let sourceInstances: WorkflowInstance[] | null = null
    if (entityType && entityId) {
      const scopedSourceInstances: WorkflowInstance[] = await em.find(WorkflowInstance, {
        tenantId,
        ...orgFilter.where,
        $and: [
          { metadata: { $contains: { entityType } } },
          { metadata: { $contains: { entityId } } },
        ],
      })
      sourceInstances = scopedSourceInstances
      where.workflowInstanceId = { $in: scopedSourceInstances.map((instance) => instance.id) }
    }

    if (overdue) {
      where.dueDate = { $lt: new Date() }
      where.status = { $in: ['PENDING', 'IN_PROGRESS'] }
    }

    if (myTasks) {
      Object.assign(where, buildPersonalTaskFilter({
        userId: auth.sub,
        roles: auth.roles || [],
      }))
    }

    const [tasks, total]: [UserTask[], number] = await em.findAndCount(
      UserTask,
      where,
      {
        orderBy: { createdAt: order === 'oldest' ? 'ASC' : 'DESC' },
        limit,
        offset,
      }
    )

    if (!sourceInstances) {
      const instanceIds = [...new Set(tasks.map((task) => task.workflowInstanceId))]
      sourceInstances = instanceIds.length > 0
        ? await em.find(WorkflowInstance, {
            id: { $in: instanceIds },
            tenantId,
            ...orgFilter.where,
          })
        : []
    }
    const resolvedSourceInstances = sourceInstances ?? []
    const instancesById = new Map(resolvedSourceInstances.map((instance) => [instance.id, instance]))
    const actor = { userId: auth.sub, roles: auth.roles || [] }

    return NextResponse.json({
      data: tasks.map((task) => {
        const instance = instancesById.get(task.workflowInstanceId)
        return {
          ...task,
          sourceEntityType: instance?.metadata?.entityType ?? null,
          sourceEntityId: instance?.metadata?.entityId ?? null,
          canClaim: canActorClaimTask(task, actor),
          canComplete: canActorCompleteTask(task, actor),
        }
      }),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + tasks.length < total,
      },
    })
  } catch (error) {
    console.error('Error listing user tasks:', error)
    return NextResponse.json(
      {
        error: 'Failed to list user tasks',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: workflowsTag,
  summary: 'User task management',
  methods: {
    GET: {
      summary: 'List user tasks',
      description: 'Returns paginated list of user tasks with optional filtering by status, assignee, workflow instance, overdue, and myTasks flags.',
      query: userTaskListQuerySchema,
      responses: [
        { status: 200, description: 'User tasks list with pagination', schema: userTaskListResponseSchema },
      ],
      errors: [
        { status: 400, description: 'Invalid query parameters or missing tenant context', schema: workflowErrorSchema },
        { status: 401, description: 'Unauthorized', schema: workflowErrorSchema },
        { status: 500, description: 'Internal server error', schema: workflowErrorSchema },
      ],
    },
  },
}
