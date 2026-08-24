import type { EntityManager } from '@mikro-orm/postgresql'
import type {
  CommandInterceptor,
  CommandInterceptorContext,
  CommandInterceptorUndoContext,
} from '@open-mercato/shared/lib/commands/command-interceptor'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  CustomerComment,
  CustomerInteraction,
  CustomerTodoLink,
} from '@open-mercato/core/modules/customers/data/entities'
import {
  FINOO_RETENTION_EXPIRES_AT_FIELD,
  FINOO_RETENTION_STATUS_FIELD,
} from '../lib/constants'
import { getFinooCustomerRetentionReconciliationQueue } from '../lib/reconciliationQueue'

const logger = createLogger('finoo_customer_retention').child({ component: 'command-interceptors' })

type UnknownRecord = Record<string, unknown>

const CUSTOMER_REFRESH_COMMANDS = new Set([
  'customers.people.create',
  'customers.people.delete',
  'customers.comments.create',
  'customers.comments.delete',
  'customers.interactions.create',
  'customers.interactions.complete',
  'customers.interactions.cancel',
  'customers.interactions.delete',
  'customers.activities.create',
  'customers.activities.delete',
  'customers.todos.create',
  'customers.todos.unlink',
])

const PARTNER_REFRESH_COMMAND_PREFIXES = [
  'finoo_affiliates.affiliate.',
  'finoo_intermediaries.intermediary.',
  'finoo_intermediaries.invitation.',
]

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNestedString(source: unknown, ...paths: string[][]): string | null {
  for (const path of paths) {
    let current: unknown = source
    for (const key of path) current = asRecord(current)?.[key]
    const value = readString(current)
    if (value) return value
  }
  return null
}

function inputId(input: unknown): string | null {
  return readNestedString(input, ['id'], ['body', 'id'], ['query', 'id'])
}

function containsRetentionMirrorWrite(input: unknown): boolean {
  const customFields = asRecord(asRecord(input)?.customFields)
  if (!customFields) return false
  return Object.prototype.hasOwnProperty.call(customFields, FINOO_RETENTION_STATUS_FIELD)
    || Object.prototype.hasOwnProperty.call(customFields, FINOO_RETENTION_EXPIRES_AT_FIELD)
}

function inputScope(input: unknown, context: CommandInterceptorContext): {
  tenantId: string | null
  organizationId: string | null
} {
  return {
    tenantId: readNestedString(input, ['tenantId']) ?? context.auth?.tenantId ?? null,
    organizationId:
      readNestedString(input, ['organizationId'])
      ?? context.selectedOrganizationId
      ?? context.auth?.orgId
      ?? null,
  }
}

async function loadInteractionMetadata(
  input: unknown,
  context: CommandInterceptorContext,
): Promise<UnknownRecord> {
  const id = inputId(input)
  if (!id) return {}
  const scope = inputScope(input, context)
  const em = (context.container.resolve('em') as EntityManager).fork()
  const interaction = await em.findOne(CustomerInteraction, {
    id,
    ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
  }, { populate: ['entity'] })
  if (!interaction) return {}
  return {
    customerEntityId: typeof interaction.entity === 'string' ? interaction.entity : interaction.entity.id,
    tenantId: interaction.tenantId,
    organizationId: interaction.organizationId,
    interactionStatus: interaction.status,
    interactionType: interaction.interactionType,
  }
}

async function loadCommentMetadata(
  input: unknown,
  context: CommandInterceptorContext,
): Promise<UnknownRecord> {
  const id = inputId(input)
  if (!id) return {}
  const scope = inputScope(input, context)
  const em = (context.container.resolve('em') as EntityManager).fork()
  const comment = await em.findOne(CustomerComment, {
    id,
    ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
  }, { populate: ['entity'] })
  if (!comment) return {}
  return {
    customerEntityId: typeof comment.entity === 'string' ? comment.entity : comment.entity.id,
    tenantId: comment.tenantId,
    organizationId: comment.organizationId,
  }
}

async function loadTodoMetadata(
  input: unknown,
  context: CommandInterceptorContext,
): Promise<UnknownRecord> {
  const linkId = readNestedString(input, ['linkId'])
  if (!linkId) return {}
  const scope = inputScope(input, context)
  const em = (context.container.resolve('em') as EntityManager).fork()
  const interaction = await em.findOne(CustomerInteraction, {
    id: linkId,
    ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
  }, { populate: ['entity'] })
  if (interaction) {
    return {
      customerEntityId: typeof interaction.entity === 'string' ? interaction.entity : interaction.entity.id,
      tenantId: interaction.tenantId,
      organizationId: interaction.organizationId,
    }
  }
  const link = await em.findOne(CustomerTodoLink, {
    id: linkId,
    ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
  }, { populate: ['entity'] })
  if (!link) return {}
  return {
    customerEntityId: typeof link.entity === 'string' ? link.entity : link.entity.id,
    tenantId: link.tenantId,
    organizationId: link.organizationId,
  }
}

function metadataScope(
  input: unknown,
  result: unknown,
  context: CommandInterceptorContext,
): { tenantId: string | null; organizationId: string | null; customerEntityId: string | null } {
  const metadata = context.metadata ?? {}
  const fallback = inputScope(input, context)
  return {
    tenantId: readString(metadata.tenantId) ?? fallback.tenantId,
    organizationId: readString(metadata.organizationId) ?? fallback.organizationId,
    customerEntityId:
      readString(metadata.customerEntityId)
      ?? readNestedString(result, ['entityId'])
      ?? readNestedString(input, ['entityId'])
      ?? (context.commandId.startsWith('customers.people.') ? inputId(input) : null),
  }
}

async function enqueueRefresh(scope: {
  tenantId: string | null
  organizationId: string | null
  customerEntityId?: string | null
}): Promise<void> {
  if (!scope.tenantId || !scope.organizationId) return
  try {
    await getFinooCustomerRetentionReconciliationQueue().enqueue({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      ...(scope.customerEntityId ? { customerEntityId: scope.customerEntityId } : {}),
    })
  } catch (error) {
    logger.error('Failed to enqueue retention refresh; hourly reconciliation will repair it', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      customerEntityId: scope.customerEntityId ?? null,
      err: error,
    })
  }
}

function snapshotPersonId(undoContext: CommandInterceptorUndoContext): string | null {
  return readNestedString(
    undoContext.logEntry,
    ['parentResourceId'],
    ['resourceId'],
    ['snapshotBefore', 'entity', 'id'],
    ['snapshotBefore', 'interaction', 'entityId'],
    ['snapshotBefore', 'entityId'],
    ['snapshotAfter', 'entity', 'id'],
    ['snapshotAfter', 'interaction', 'entityId'],
    ['snapshotAfter', 'entityId'],
  )
}

function snapshotScope(undoContext: CommandInterceptorUndoContext): {
  tenantId: string | null
  organizationId: string | null
} {
  return {
    tenantId: readNestedString(
      undoContext.logEntry,
      ['tenantId'],
      ['snapshotBefore', 'entity', 'tenantId'],
      ['snapshotBefore', 'interaction', 'tenantId'],
      ['snapshotBefore', 'tenantId'],
    ),
    organizationId: readNestedString(
      undoContext.logEntry,
      ['organizationId'],
      ['snapshotBefore', 'entity', 'organizationId'],
      ['snapshotBefore', 'interaction', 'organizationId'],
      ['snapshotBefore', 'organizationId'],
    ),
  }
}

const customerActivityInterceptor: CommandInterceptor = {
  id: 'finoo_customer_retention.customer-activity-refresh',
  targetCommand: 'customers.*',
  priority: 80,
  async beforeExecute(input, context) {
    if (
      (context.commandId === 'customers.people.create' || context.commandId === 'customers.people.update')
      && containsRetentionMirrorWrite(input)
    ) {
      return {
        ok: false,
        message: 'Retention fields are managed by the retention policy',
      }
    }
    if (context.commandId === 'customers.comments.delete') {
      return { ok: true, metadata: await loadCommentMetadata(input, context) }
    }
    if (
      context.commandId === 'customers.interactions.update'
      || context.commandId === 'customers.activities.update'
      || context.commandId === 'customers.interactions.complete'
      || context.commandId === 'customers.interactions.cancel'
      || context.commandId === 'customers.interactions.delete'
      || context.commandId === 'customers.activities.delete'
    ) {
      const metadata = await loadInteractionMetadata(input, context)
      if (
        context.commandId === 'customers.interactions.update'
        || context.commandId === 'customers.activities.update'
      ) {
        const nextStatus = readNestedString(input, ['status'], ['body', 'status'])
        const wasCompleted = metadata.interactionStatus === 'done' || metadata.interactionStatus === 'completed'
        const becomesCompleted = nextStatus === 'done' || nextStatus === 'completed'
        if (!wasCompleted && becomesCompleted) {
          return {
            ok: true,
            modifiedInput: { occurredAt: new Date() },
            metadata: { ...metadata, completionTransition: true },
          }
        }
        return { ok: true, metadata }
      }
      return { ok: true, metadata }
    }
    if (context.commandId === 'customers.todos.unlink') {
      return { ok: true, metadata: await loadTodoMetadata(input, context) }
    }
    return { ok: true }
  },
  async afterExecute(input, result, context) {
    const completionTransition = context.metadata?.completionTransition === true
    if (!CUSTOMER_REFRESH_COMMANDS.has(context.commandId) && !completionTransition) return
    await enqueueRefresh(metadataScope(input, result, context))
  },
  async beforeUndo(undoContext) {
    const scope = snapshotScope(undoContext)
    return {
      ok: true,
      metadata: {
        ...scope,
        customerEntityId: snapshotPersonId(undoContext),
      },
    }
  },
  async afterUndo(_undoContext, context) {
    if (
      !CUSTOMER_REFRESH_COMMANDS.has(context.commandId)
      && context.commandId !== 'customers.people.update'
      && context.commandId !== 'customers.interactions.update'
      && context.commandId !== 'customers.activities.update'
    ) return
    const scope = {
      tenantId: readString(context.metadata?.tenantId),
      organizationId: readString(context.metadata?.organizationId),
      customerEntityId: readString(context.metadata?.customerEntityId),
    }
    await enqueueRefresh(scope)
  },
}

const partnerLifecycleInterceptor: CommandInterceptor = {
  id: 'finoo_customer_retention.partner-lifecycle-refresh',
  targetCommand: '*',
  priority: 90,
  async afterExecute(input, _result, context) {
    if (!PARTNER_REFRESH_COMMAND_PREFIXES.some((prefix) => context.commandId.startsWith(prefix))) return
    const scope = inputScope(input, context)
    await enqueueRefresh(scope)
  },
  async beforeUndo(undoContext) {
    return { ok: true, metadata: snapshotScope(undoContext) }
  },
  async afterUndo(_undoContext, context) {
    if (!PARTNER_REFRESH_COMMAND_PREFIXES.some((prefix) => context.commandId.startsWith(prefix))) return
    await enqueueRefresh({
      tenantId: readString(context.metadata?.tenantId),
      organizationId: readString(context.metadata?.organizationId),
    })
  },
}

export const interceptors: CommandInterceptor[] = [
  customerActivityInterceptor,
  partnerLifecycleInterceptor,
]

export default interceptors
