import { LockMode } from '@mikro-orm/core'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { findAndCountWithDecryption, findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  FinooIdentityAuditEntry,
  FinooIdentityImportConflict,
  FinooPersonIdentity,
  type FinooIdentityAuditOperation,
} from '../data/entities'
import {
  finooIdentityConflictResolutionSchema,
  finooIdentityInputSchema,
  type FinooIdentityConflictResolutionInput,
  type FinooIdentityInput,
} from '../data/validators'
import {
  computeIdentityCompleteness,
  sanitizeIdentityFieldStatuses,
  type IdentityFieldStatuses,
} from './identity-domain'
import { defaultEncryptionMaps } from '../encryption'

export type FinooIdentitySubjectScope = {
  tenantId: string
  organizationId: string
  personId: string
}

export type FinooIdentityActorScope = FinooIdentitySubjectScope & {
  actorUserId: string
}

export type FinooIdentityActorBaseScope = Omit<FinooIdentityActorScope, 'personId'>

type FinooIdentityServiceDependencies = {
  em: EntityManager
  rbacService: Pick<RbacService, 'userHasAllFeatures'>
  encryptionService: Pick<TenantDataEncryptionService, 'isEnabled' | 'getDek' | 'getEncryptedFieldNames'>
  resolveApplicationIdentityRetention?: () => {
    erasePersonIdentityCopies(input: FinooIdentitySubjectScope & { em: EntityManager }): Promise<{
      intakesRedacted: number
      bindingsDeleted: number
    }>
  } | undefined
  invalidateIdentityErasureCompletion: (
    input: FinooIdentitySubjectScope & { em: EntityManager },
  ) => Promise<void>
  afterMutation?: (event: FinooIdentityMutationEvent) => Promise<void>
}

export type FinooIdentityMutationEvent = {
  eventId:
    | 'finoo_identities.identity.created'
    | 'finoo_identities.identity.updated'
    | 'finoo_identities.identity.erased'
    | 'finoo_identities.import_conflict.created'
    | 'finoo_identities.import_conflict.resolved'
  tenantId: string
  organizationId: string
  personId: string
  identityId?: string
  conflictId?: string
  changedFields?: string[]
  isComplete?: boolean
  resolution?: 'resolved' | 'dismissed'
}

export type AuthorizedIdentityView = {
  id: string
  pesel: string | null
  documentType: string | null
  issuingCountryCode: string | null
  documentNumber: string | null
  issuedOn: string | null
  expiresOn: string | null
  isComplete: boolean
  statuses: IdentityFieldStatuses
  updatedAt: string
}

export type IdentityWriteResult = Pick<AuthorizedIdentityView, 'id' | 'isComplete' | 'statuses' | 'updatedAt'>

export type IdentityStatusView = Pick<AuthorizedIdentityView, 'isComplete' | 'statuses'>

export type FinooIdentityUpsertRequest = {
  scope: FinooIdentityActorScope
  input: FinooIdentityInput
  request?: Request | Headers | null
}

export type FinooIdentityTechnicalImportRequest = FinooIdentitySubjectScope & {
  sourceModule: 'finoo_applications'
  sourceRecordId: string
  input: FinooIdentityInput
}

export type FinooIdentityTechnicalImportResult = {
  status: 'created' | 'unchanged' | 'conflict'
  identityId: string
  isComplete: boolean
  conflictId?: string
}

export type FinooIdentityAuditListRequest = {
  scope: FinooIdentityActorScope
  page: number
  pageSize: number
}

export type FinooIdentityAuditListResult = {
  items: Array<{
    id: string
    actorUserId: string | null
    actorKind: 'user' | 'system'
    operation: FinooIdentityAuditOperation
    outcome: 'allowed' | 'denied'
    changedFields: string[] | null
    createdAt: string
  }>
  page: number
  pageSize: number
  total: number
}

type IdentityValues = Pick<
  AuthorizedIdentityView,
  'pesel' | 'documentType' | 'issuingCountryCode' | 'documentNumber' | 'issuedOn' | 'expiresOn'
>

export type FinooIdentityConflictListRequest = {
  scope: FinooIdentityActorScope
  page: number
  pageSize: number
}

export type FinooIdentityConflictListResult = {
  items: Array<{
    id: string
    sourceModule: string
    sourceRecordId: string
    changedFields: string[]
    state: 'open'
    current: IdentityValues & { updatedAt: string }
    candidate: IdentityValues
    createdAt: string
    updatedAt: string
  }>
  page: number
  pageSize: number
  total: number
}

export type FinooIdentityConflictResolutionRequest = {
  scope: FinooIdentityActorBaseScope
  conflictId: string
  input: FinooIdentityConflictResolutionInput
}

export type FinooIdentityConflictResolutionResult = {
  conflictId: string
  identityId: string
  state: 'resolved' | 'dismissed'
  isComplete: boolean
  statuses: IdentityFieldStatuses
  identityUpdatedAt: string
  conflictUpdatedAt: string
}

export type FinooIdentityErasureResult = {
  identitiesDeleted: number
  conflictsDeleted: number
  legacyValuesDeleted: number
  auditEntriesAnonymized: number
  applicationIntakesRedacted: number
  applicationBindingsDeleted: number
}

export type FinooIdentityPostCommitEffect = () => Promise<void>

const IDENTITY_FIELDS = [
  'pesel',
  'documentType',
  'issuingCountryCode',
  'documentNumber',
  'issuedOn',
  'expiresOn',
] as const

const technicalImportScopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  personId: z.string().uuid(),
  sourceModule: z.literal('finoo_applications'),
  sourceRecordId: z.string().uuid(),
})

export function createFinooIdentityService(dependencies: FinooIdentityServiceDependencies) {
  async function publishMutation(event: FinooIdentityMutationEvent): Promise<void> {
    await dependencies.afterMutation?.(event)
  }

  async function requireRawDataEncryption(scope: Omit<FinooIdentitySubjectScope, 'personId'>): Promise<void> {
    if (!dependencies.encryptionService.isEnabled()) {
      throw new CrudHttpError(503, { error: 'identity_encryption_unavailable',
      })
    }
    const dek = await dependencies.encryptionService.getDek(scope.tenantId)
    if (!dek?.key) throw new CrudHttpError(503, { error: 'identity_encryption_unavailable',
      })
    for (const map of defaultEncryptionMaps) {
      const encryptedFields = await dependencies.encryptionService.getEncryptedFieldNames(
        map.entityId,
        scope.tenantId,
        scope.organizationId,
      )
      if (!map.fields.every(({ field }) => encryptedFields.includes(field))) {
        throw new CrudHttpError(503, { error: 'identity_encryption_unavailable',
        })
      }
    }
  }

  async function lockScopedPerson(em: EntityManager, scope: FinooIdentitySubjectScope): Promise<void> {
    await em.execute(
      'select pg_advisory_xact_lock(hashtext(?))',
      [`finoo_identity:${scope.tenantId}:${scope.organizationId}:${scope.personId}`],
    )
  }

  function appendAudit(
    em: EntityManager,
    scope: Omit<FinooIdentitySubjectScope, 'personId'> & { personId?: string | null },
    operation: FinooIdentityAuditOperation,
    outcome: 'allowed' | 'denied',
    changedFields: string[] | null,
    actor: { kind: 'user' | 'system'; userId: string | null },
    auditSubjectId?: string,
  ): void {
    const subjectId = scope.personId ?? auditSubjectId
    if (!subjectId) throw new Error('[internal] Missing identity audit subject')
    const audit = em.create(FinooIdentityAuditEntry, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      actorUserId: actor.userId,
      actorKind: actor.kind,
      personId: scope.personId ?? null,
      subjectDigest: hashForLookup(
        subjectId,
        `finoo_identity_audit:${scope.tenantId}:${scope.organizationId}`,
      ),
      operation,
      outcome,
      changedFields,
    })
    em.persist(audit)
  }

  async function requireFeature(
    scope: FinooIdentityActorScope,
    feature: 'finoo_identities.view' | 'finoo_identities.manage',
    operation: FinooIdentityAuditOperation,
  ): Promise<void> {
    const allowed = await dependencies.rbacService.userHasAllFeatures(
      scope.actorUserId,
      [feature],
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )
    if (allowed) return
    appendAudit(dependencies.em, scope, operation, 'denied', null, { kind: 'user', userId: scope.actorUserId,
    })
    await dependencies.em.flush()
    throw new CrudHttpError(403, { error: 'identity_access_denied' })
  }

  async function requireFeatureWithoutPerson(
    scope: FinooIdentityActorBaseScope,
    feature: 'finoo_identities.view' | 'finoo_identities.manage',
    operation: FinooIdentityAuditOperation,
    auditSubjectId: string,
  ): Promise<void> {
    const allowed = await dependencies.rbacService.userHasAllFeatures(
      scope.actorUserId,
      [feature],
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )
    if (allowed) return
    const rows = await dependencies.em.execute<Array<{ person_id: string }>>(
      `select person_id
       from finoo_identity_import_conflicts
       where id = ? and tenant_id = ? and organization_id = ?
       limit 1`,
      [auditSubjectId, scope.tenantId, scope.organizationId],
    )
    const personId = rows[0]?.person_id
    appendAudit(
      dependencies.em,
      personId ? { ...scope, personId } : scope,
      operation,
      'denied',
      null,
      { kind: 'user', userId: scope.actorUserId },
      auditSubjectId,
    )
    await dependencies.em.flush()
    throw new CrudHttpError(403, { error: 'identity_access_denied' })
  }

  async function requireScopedPerson(em: EntityManager, scope: FinooIdentitySubjectScope): Promise<void> {
    const person = await findOneWithDecryption(
      em,
      CustomerEntity,
      {
        id: scope.personId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        kind: 'person',
        deletedAt: null,
      },
      undefined,
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )
    if (!person) throw new CrudHttpError(404, { error: 'person_not_found' })
  }

  return {
    async authorizeIdentityManagementActor(scope: FinooIdentityActorScope): Promise<void> {
      await requireFeature(scope, 'finoo_identities.manage', 'update')
    },

    async authorizeConflictManagementActor(request: {
      scope: FinooIdentityActorBaseScope
      conflictId: string
      operation: 'resolve_conflict' | 'dismiss_conflict'
    }): Promise<void> {
      await requireFeatureWithoutPerson(
        request.scope,
        'finoo_identities.manage',
        request.operation,
        request.conflictId,
      )
    },

    async readForAuthorizedActor(scope: FinooIdentityActorScope): Promise<AuthorizedIdentityView> {
      await requireFeature(scope, 'finoo_identities.view', 'read')
      await requireRawDataEncryption(scope)
      await requireScopedPerson(dependencies.em, scope)
      const identity = await findOneWithDecryption(
        dependencies.em,
        FinooPersonIdentity,
        {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          personId: scope.personId,
          deletedAt: null,
        },
        undefined,
        { tenantId: scope.tenantId, organizationId: scope.organizationId },
      )
      if (!identity) {
        throw new CrudHttpError(404, { error: 'identity_not_found' })
      }
      const completeness = computeIdentityCompleteness(identity)
      appendAudit(dependencies.em, scope, 'read', 'allowed', null, { kind: 'user', userId: scope.actorUserId,
      })
      await dependencies.em.flush()
      return {
        id: identity.id,
        pesel: identity.pesel ?? null,
        documentType: identity.documentType ?? null,
        issuingCountryCode: identity.issuingCountryCode ?? null,
        documentNumber: identity.documentNumber ?? null,
        issuedOn: identity.issuedOn ?? null,
        expiresOn: identity.expiresOn ?? null,
        isComplete: completeness.isComplete,
        statuses: completeness.statuses,
        updatedAt: identity.updatedAt.toISOString(),
      }
    },

    async readStatusForPersonViewer(scope: FinooIdentityActorScope): Promise<IdentityStatusView> {
      const allowed = await dependencies.rbacService.userHasAllFeatures(
        scope.actorUserId,
        ['customers.people.view'],
        { tenantId: scope.tenantId, organizationId: scope.organizationId },
      )
      if (!allowed) throw new CrudHttpError(403, { error: 'person_access_denied' })
      await requireScopedPerson(dependencies.em, scope)
      const identity = await dependencies.em.findOne(
        FinooPersonIdentity,
        {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          personId: scope.personId,
          deletedAt: null,
        },
        { fields: ['personId', 'isComplete', 'fieldStatuses'] },
      )
      const missing = computeIdentityCompleteness({})
      return {
        isComplete: identity?.isComplete ?? false,
        statuses: identity ? sanitizeIdentityFieldStatuses(identity.fieldStatuses) : missing.statuses,
      }
    },

    async upsertForAuthorizedActor(request: FinooIdentityUpsertRequest): Promise<IdentityWriteResult> {
      await requireFeature(request.scope, 'finoo_identities.manage', 'update')
      await requireRawDataEncryption(request.scope)
      const input = finooIdentityInputSchema.parse(request.input)
      const mutation = await dependencies.em.transactional(async (transactionalEm) => {
        await dependencies.invalidateIdentityErasureCompletion({
          tenantId: request.scope.tenantId,
          organizationId: request.scope.organizationId,
          personId: request.scope.personId,
          em: transactionalEm,
        })
        await lockScopedPerson(transactionalEm, request.scope)
        await requireScopedPerson(transactionalEm, request.scope)
        const scope = {
          tenantId: request.scope.tenantId,
          organizationId: request.scope.organizationId,
        }
        let identity = await findOneWithDecryption(
          transactionalEm,
          FinooPersonIdentity,
          { ...scope, personId: request.scope.personId, deletedAt: null },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
          scope,
        )
        const operation: FinooIdentityAuditOperation = identity ? 'update' : 'create'
        if (identity) {
          enforceCommandOptimisticLock({
            resourceKind: 'finoo_identities.identity',
            resourceId: identity.id,
            current: identity.updatedAt,
            request: request.request,
          })
        } else {
          identity = transactionalEm.create(FinooPersonIdentity, {
            ...scope,
            personId: request.scope.personId,
          })
          transactionalEm.persist(identity)
        }
        const previous = {
          pesel: identity.pesel ?? null,
          documentType: identity.documentType ?? null,
          issuingCountryCode: identity.issuingCountryCode ?? null,
          documentNumber: identity.documentNumber ?? null,
          issuedOn: identity.issuedOn ?? null,
          expiresOn: identity.expiresOn ?? null,
        }
        const changedFields = IDENTITY_FIELDS.filter((field) => previous[field] !== (input[field] ?? null))
        identity.pesel = input.pesel
        identity.documentType = input.documentType ?? null
        identity.issuingCountryCode = input.issuingCountryCode ?? null
        identity.documentNumber = input.documentNumber ?? null
        identity.issuedOn = input.issuedOn ?? null
        identity.expiresOn = input.expiresOn ?? null
        const completeness = computeIdentityCompleteness(identity)
        identity.isComplete = completeness.isComplete
        identity.fieldStatuses = completeness.statuses
        appendAudit(
          transactionalEm,
          request.scope,
          operation,
          'allowed',
          [...changedFields],
          { kind: 'user', userId: request.scope.actorUserId },
        )
        await transactionalEm.flush()
        return {
          result: {
            id: identity.id,
            isComplete: completeness.isComplete,
            statuses: completeness.statuses,
            updatedAt: identity.updatedAt.toISOString(),
          },
          eventId: operation === 'create'
            ? 'finoo_identities.identity.created' as const
            : 'finoo_identities.identity.updated' as const,
          changedFields: [...changedFields],
        }
      })
      await publishMutation({
        eventId: mutation.eventId,
        tenantId: request.scope.tenantId,
        organizationId: request.scope.organizationId,
        personId: request.scope.personId,
        identityId: mutation.result.id,
        changedFields: mutation.changedFields,
        isComplete: mutation.result.isComplete,
      })
      return mutation.result
    },

    async createFromTechnicalImport(request: FinooIdentityTechnicalImportRequest): Promise<FinooIdentityTechnicalImportResult> {
      technicalImportScopeSchema.parse(request)
      await requireRawDataEncryption(request)
      const input = finooIdentityInputSchema.parse(request.input)
      const mutation = await dependencies.em.transactional(async (transactionalEm) => {
        await dependencies.invalidateIdentityErasureCompletion({
          tenantId: request.tenantId,
          organizationId: request.organizationId,
          personId: request.personId,
          em: transactionalEm,
        })
        await lockScopedPerson(transactionalEm, request)
        await requireScopedPerson(transactionalEm, request)
        const scope = { tenantId: request.tenantId, organizationId: request.organizationId,
        }
        const existing = await findOneWithDecryption(
          transactionalEm,
          FinooPersonIdentity,
          { ...scope, personId: request.personId, deletedAt: null },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
          scope,
        )
        if (existing) {
          const existingValues = {
            pesel: existing.pesel ?? null,
            documentType: existing.documentType ?? null,
            issuingCountryCode: existing.issuingCountryCode ?? null,
            documentNumber: existing.documentNumber ?? null,
            issuedOn: existing.issuedOn ?? null,
            expiresOn: existing.expiresOn ?? null,
          }
          const changedFields = IDENTITY_FIELDS.filter((field) => existingValues[field] !== (input[field] ?? null))
          const currentCompleteness = computeIdentityCompleteness(existing)
          if (changedFields.length === 0) {
            appendAudit(
              transactionalEm,
              request,
              'import',
              'allowed',
              [],
              { kind: 'system', userId: null,
            },
            )
            await transactionalEm.flush()
            return {
              result: {
                status: 'unchanged' as const,
                identityId: existing.id,
                isComplete: currentCompleteness.isComplete,
              },
              event: null,
            }
          }
          const candidateDigest = hashForLookup(
            createHash('sha256').update(JSON.stringify(input)).digest('hex'),
            `finoo_identity_import:${request.tenantId}:${request.organizationId}:${request.sourceModule}:${request.sourceRecordId}`,
          )
          let conflict = await transactionalEm.findOne(
            FinooIdentityImportConflict,
            {
              ...scope,
              sourceModule: request.sourceModule,
              sourceRecordId: request.sourceRecordId,
              candidateDigest,
              state: 'open',
            },
            { fields: ['id'] },
          )
          const conflictCreated = !conflict
          if (!conflict) {
            conflict = transactionalEm.create(FinooIdentityImportConflict, {
              ...scope,
              personId: request.personId,
              sourceModule: request.sourceModule,
              sourceRecordId: request.sourceRecordId,
              candidateDigest,
              candidatePesel: input.pesel,
              candidateDocumentType: input.documentType ?? null,
              candidateIssuingCountryCode: input.issuingCountryCode ?? null,
              candidateDocumentNumber: input.documentNumber ?? null,
              candidateIssuedOn: input.issuedOn ?? null,
              candidateExpiresOn: input.expiresOn ?? null,
              changedFields: [...changedFields],
              state: 'open',
            })
            transactionalEm.persist(conflict)
          }
          appendAudit(
            transactionalEm,
            request,
            'import',
            'allowed',
            [...changedFields],
            { kind: 'system', userId: null },
          )
          await transactionalEm.flush()
          return {
            result: {
              status: 'conflict' as const,
              identityId: existing.id,
              isComplete: currentCompleteness.isComplete,
              conflictId: conflict.id,
            },
            event: conflictCreated ? {
              eventId: 'finoo_identities.import_conflict.created' as const,
              conflictId: conflict.id,
              changedFields: [...changedFields],
              isComplete: currentCompleteness.isComplete,
            } : null,
          }
        }
        const completeness = computeIdentityCompleteness(input)
        const identity = transactionalEm.create(FinooPersonIdentity, {
          ...scope,
          personId: request.personId,
          pesel: input.pesel,
          documentType: input.documentType ?? null,
          issuingCountryCode: input.issuingCountryCode ?? null,
          documentNumber: input.documentNumber ?? null,
          issuedOn: input.issuedOn ?? null,
          expiresOn: input.expiresOn ?? null,
          isComplete: completeness.isComplete,
          fieldStatuses: completeness.statuses,
        })
        transactionalEm.persist(identity)
        appendAudit(
          transactionalEm,
          request,
          'import',
          'allowed',
          [...IDENTITY_FIELDS],
          { kind: 'system', userId: null },
        )
        await transactionalEm.flush()
        return {
          result: {
            status: 'created' as const,
            identityId: identity.id,
            isComplete: completeness.isComplete,
          },
          event: {
            eventId: 'finoo_identities.identity.created' as const,
            identityId: identity.id,
            changedFields: [...IDENTITY_FIELDS],
            isComplete: completeness.isComplete,
          },
        }
      })
      if (mutation.event) {
        await publishMutation({
          ...mutation.event,
          tenantId: request.tenantId,
          organizationId: request.organizationId,
          personId: request.personId,
        })
      }
      return mutation.result
    },

    async listAuditForAuthorizedActor(request: FinooIdentityAuditListRequest): Promise<FinooIdentityAuditListResult> {
      await requireFeature(request.scope, 'finoo_identities.view', 'read')
      await requireScopedPerson(dependencies.em, request.scope)
      const [entries, total] = await dependencies.em.findAndCount(
        FinooIdentityAuditEntry,
        {
          tenantId: request.scope.tenantId,
          organizationId: request.scope.organizationId,
          personId: request.scope.personId,
        },
        {
          orderBy: { createdAt: 'desc' },
          limit: request.pageSize,
          offset: (request.page - 1) * request.pageSize,
        },
      )
      appendAudit(
        dependencies.em,
        request.scope,
        'read',
        'allowed',
        null,
        { kind: 'user', userId: request.scope.actorUserId },
      )
      await dependencies.em.flush()
      return {
        items: entries.map((entry) => ({
          id: entry.id,
          actorUserId: entry.actorUserId ?? null,
          actorKind: entry.actorKind,
          operation: entry.operation,
          outcome: entry.outcome,
          changedFields: entry.changedFields ?? null,
          createdAt: entry.createdAt.toISOString(),
        })),
        page: request.page,
        pageSize: request.pageSize,
        total,
      }
    },

    async listConflictsForAuthorizedActor(
      request: FinooIdentityConflictListRequest,
    ): Promise<FinooIdentityConflictListResult> {
      await requireFeature(request.scope, 'finoo_identities.view', 'review_conflict')
      await requireRawDataEncryption(request.scope)
      await requireScopedPerson(dependencies.em, request.scope)
      const scope = {
        tenantId: request.scope.tenantId,
        organizationId: request.scope.organizationId,
      }
      const identity = await findOneWithDecryption(
        dependencies.em,
        FinooPersonIdentity,
        { ...scope, personId: request.scope.personId, deletedAt: null },
        undefined,
        scope,
      )
      if (!identity) throw new CrudHttpError(404, { error: 'identity_not_found' })
      const [conflicts, total] = await findAndCountWithDecryption(
        dependencies.em,
        FinooIdentityImportConflict,
        { ...scope, personId: request.scope.personId, state: 'open' },
        {
          orderBy: { createdAt: 'desc' },
          limit: request.pageSize,
          offset: (request.page - 1) * request.pageSize,
        },
        scope,
      )
      const current = {
        pesel: identity.pesel ?? null,
        documentType: identity.documentType ?? null,
        issuingCountryCode: identity.issuingCountryCode ?? null,
        documentNumber: identity.documentNumber ?? null,
        issuedOn: identity.issuedOn ?? null,
        expiresOn: identity.expiresOn ?? null,
        updatedAt: identity.updatedAt.toISOString(),
      }
      appendAudit(
        dependencies.em,
        request.scope,
        'review_conflict',
        'allowed',
        null,
        { kind: 'user', userId: request.scope.actorUserId },
      )
      await dependencies.em.flush()
      return {
        items: conflicts.map((conflict) => ({
          id: conflict.id,
          sourceModule: conflict.sourceModule,
          sourceRecordId: conflict.sourceRecordId,
          changedFields: [...conflict.changedFields],
          state: 'open',
          current,
          candidate: {
            pesel: conflict.candidatePesel ?? null,
            documentType: conflict.candidateDocumentType ?? null,
            issuingCountryCode: conflict.candidateIssuingCountryCode ?? null,
            documentNumber: conflict.candidateDocumentNumber ?? null,
            issuedOn: conflict.candidateIssuedOn ?? null,
            expiresOn: conflict.candidateExpiresOn ?? null,
          },
          createdAt: conflict.createdAt.toISOString(),
          updatedAt: conflict.updatedAt.toISOString(),
        })),
        page: request.page,
        pageSize: request.pageSize,
        total,
      }
    },

    async resolveConflictForAuthorizedActor(
      request: FinooIdentityConflictResolutionRequest,
    ): Promise<FinooIdentityConflictResolutionResult> {
      const input = finooIdentityConflictResolutionSchema.parse(request.input)
      await requireFeatureWithoutPerson(
        request.scope,
        'finoo_identities.manage',
        input.action === 'replace' ? 'resolve_conflict' : 'dismiss_conflict',
        request.conflictId,
      )
      await requireRawDataEncryption(request.scope)
      const mutation = await dependencies.em.transactional(async (transactionalEm) => {
        const scope = {
          tenantId: request.scope.tenantId,
          organizationId: request.scope.organizationId,
        }
        const conflictScope = await findOneWithDecryption(
          transactionalEm,
          FinooIdentityImportConflict,
          {
            id: request.conflictId,
            ...scope,
            state: 'open',
          },
          { fields: ['personId'] },
          scope,
        )
        if (!conflictScope) throw new CrudHttpError(404, { error: 'identity_conflict_not_found',
          })
        const actorScope: FinooIdentityActorScope = {
          ...request.scope,
          personId: conflictScope.personId,
        }
        await dependencies.invalidateIdentityErasureCompletion({
          tenantId: actorScope.tenantId,
          organizationId: actorScope.organizationId,
          personId: actorScope.personId,
          em: transactionalEm,
        })
        const conflict = await findOneWithDecryption(
          transactionalEm,
          FinooIdentityImportConflict,
          {
            id: request.conflictId,
            ...scope,
            personId: actorScope.personId,
            state: 'open',
          },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
          scope,
        )
        if (!conflict) throw new CrudHttpError(404, { error: 'identity_conflict_not_found',
          })
        await lockScopedPerson(transactionalEm, actorScope)
        const identity = await findOneWithDecryption(
          transactionalEm,
          FinooPersonIdentity,
          { ...scope, personId: conflict.personId, deletedAt: null },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
          scope,
        )
        if (!identity) throw new CrudHttpError(404, { error: 'identity_not_found' })
        enforceCommandOptimisticLock({
          resourceKind: 'finoo_identities.import_conflict',
          resourceId: conflict.id,
          expected: input.updatedAt,
          current: conflict.updatedAt,
        })
        enforceCommandOptimisticLock({
          resourceKind: 'finoo_identities.identity',
          resourceId: identity.id,
          expected: input.identityUpdatedAt,
          current: identity.updatedAt,
        })

        if (input.action === 'replace') {
          const candidate = finooIdentityInputSchema.parse({
            pesel: conflict.candidatePesel,
            documentType: conflict.candidateDocumentType,
            issuingCountryCode: conflict.candidateIssuingCountryCode,
            documentNumber: conflict.candidateDocumentNumber,
            issuedOn: conflict.candidateIssuedOn,
            expiresOn: conflict.candidateExpiresOn,
          })
          identity.pesel = candidate.pesel
          identity.documentType = candidate.documentType ?? null
          identity.issuingCountryCode = candidate.issuingCountryCode ?? null
          identity.documentNumber = candidate.documentNumber ?? null
          identity.issuedOn = candidate.issuedOn ?? null
          identity.expiresOn = candidate.expiresOn ?? null
        }

        const completeness = computeIdentityCompleteness(identity)
        identity.isComplete = completeness.isComplete
        identity.fieldStatuses = completeness.statuses
        conflict.candidatePesel = null
        conflict.candidateDocumentType = null
        conflict.candidateIssuingCountryCode = null
        conflict.candidateDocumentNumber = null
        conflict.candidateIssuedOn = null
        conflict.candidateExpiresOn = null
        conflict.state = input.action === 'replace' ? 'resolved' : 'dismissed'
        conflict.resolvedAt = new Date()
        const operation: FinooIdentityAuditOperation = input.action === 'replace'
          ? 'resolve_conflict'
          : 'dismiss_conflict'
        appendAudit(
          transactionalEm,
          actorScope,
          operation,
          'allowed',
          [...conflict.changedFields],
          { kind: 'user', userId: request.scope.actorUserId },
        )
        await transactionalEm.flush()
        return {
          result: {
            conflictId: conflict.id,
            identityId: identity.id,
            state: conflict.state,
            isComplete: completeness.isComplete,
            statuses: completeness.statuses,
            identityUpdatedAt: identity.updatedAt.toISOString(),
            conflictUpdatedAt: conflict.updatedAt.toISOString(),
          },
          personId: conflict.personId,
          changedFields: [...conflict.changedFields],
        }
      })
      await publishMutation({
        eventId: 'finoo_identities.import_conflict.resolved',
        tenantId: request.scope.tenantId,
        organizationId: request.scope.organizationId,
        personId: mutation.personId,
        identityId: mutation.result.identityId,
        conflictId: mutation.result.conflictId,
        changedFields: mutation.changedFields,
        isComplete: mutation.result.isComplete,
        resolution: mutation.result.state,
      })
      if (mutation.result.state === 'resolved') {
        await publishMutation({
          eventId: 'finoo_identities.identity.updated',
          tenantId: request.scope.tenantId,
          organizationId: request.scope.organizationId,
          personId: mutation.personId,
          identityId: mutation.result.identityId,
          changedFields: mutation.changedFields,
          isComplete: mutation.result.isComplete,
        })
      }
      return mutation.result
    },

    async anonymizeAndDeleteForPerson(request: FinooIdentitySubjectScope & {
      systemActor: true
        transactionalEm?: EntityManager
        registerPostCommitEffect?: (effect: FinooIdentityPostCommitEffect) => void
      }): Promise<FinooIdentityErasureResult> {
      if (request.systemActor !== true) throw new CrudHttpError(403, { error: 'identity_erasure_denied' })
      await requireRawDataEncryption(request)
      const applicationIdentityRetention = dependencies.resolveApplicationIdentityRetention?.()
      if (!applicationIdentityRetention) {
        throw new CrudHttpError(503, { error: 'identity_retention_unavailable',
        })
      }
      const eraseWithinTransaction = async (transactionalEm: EntityManager) => {
        await lockScopedPerson(transactionalEm, request)
        const scope = { tenantId: request.tenantId, organizationId: request.organizationId,
        }
        const application = await applicationIdentityRetention.erasePersonIdentityCopies({
          em: transactionalEm,
          ...scope,
          personId: request.personId,
        })
        const conflicts = await transactionalEm.execute<Array<{ id: string }>>(
          `delete from finoo_identity_import_conflicts
           where tenant_id = ? and organization_id = ? and person_id = ?
           returning id`,
          [request.tenantId, request.organizationId, request.personId],
        )
        const identities = await transactionalEm.execute<Array<{ id: string }>>(
          `delete from finoo_person_identities
           where tenant_id = ? and organization_id = ? and person_id = ?
           returning id`,
          [request.tenantId, request.organizationId, request.personId],
        )
        const legacyValues = await transactionalEm.execute<Array<{ id: string }>>(
          `delete from custom_field_values legacy
           where legacy.tenant_id = ? and legacy.organization_id = ?
             and legacy.entity_id = 'customers:customer_person_profile'
             and legacy.record_id in (
               select profile.id::text
               from customer_people profile
               where profile.tenant_id = ? and profile.organization_id = ? and profile.entity_id = ?
             )
             and (
               legacy.field_key in (
                 'national_identification_number', 'id_type', 'id_country_code',
                 'id_number', 'id_issued_date', 'id_expiry_date'
               )
               or (
                 legacy.field_key ~ '^(cf_|cf:)+'
                 and regexp_replace(legacy.field_key, '^(cf_|cf:)+', '') in (
               'national_identification_number', 'id_type', 'id_country_code',
               'id_number', 'id_issued_date', 'id_expiry_date'
             )
               )
             )
           returning legacy.id`,
          [request.tenantId, request.organizationId, request.tenantId, request.organizationId, request.personId],
        )
        const anonymized = await transactionalEm.execute<Array<{ id: string }>>(
          `update finoo_identity_audit_entries
           set person_id = null
           where tenant_id = ? and organization_id = ? and person_id = ?
           returning id`,
          [request.tenantId, request.organizationId, request.personId],
        )
        transactionalEm.persist(transactionalEm.create(FinooIdentityAuditEntry, {
          ...scope,
          actorUserId: null,
          actorKind: 'system',
          personId: null,
          subjectDigest: hashForLookup(
            request.personId,
            `finoo_identity_audit:${request.tenantId}:${request.organizationId}`,
          ),
          operation: 'erase',
          outcome: 'allowed',
          changedFields: null,
        }))
        await transactionalEm.flush()
        return {
          identitiesDeleted: identities.length,
          conflictsDeleted: conflicts.length,
          legacyValuesDeleted: legacyValues.length,
          auditEntriesAnonymized: anonymized.length,
          applicationIntakesRedacted: application.intakesRedacted,
          applicationBindingsDeleted: application.bindingsDeleted,
        }
      }
      const result = request.transactionalEm
        ? await eraseWithinTransaction(request.transactionalEm)
        : await dependencies.em.transactional(eraseWithinTransaction)
      const publishErasure = () =>
        publishMutation({
        eventId: 'finoo_identities.identity.erased',
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        personId: request.personId,
      })
      if (request.registerPostCommitEffect) request.registerPostCommitEffect(publishErasure)
      else await publishErasure()
      return result
    },
  }
}

export type FinooIdentityService = ReturnType<typeof createFinooIdentityService>
