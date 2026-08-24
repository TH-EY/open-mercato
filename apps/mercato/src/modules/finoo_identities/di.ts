import { asFunction, asValue } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { invalidateCrudCache } from '@open-mercato/shared/lib/crud/cache'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { FinooIdentityAuditEntry, FinooIdentityImportConflict, FinooPersonIdentity } from './data/entities'
import { createFinooIdentityService, type FinooIdentityMutationEvent } from './lib/service'
import { emitFinooIdentityEvent } from './events'

const logger = createLogger('finoo_identities').child({ component: 'mutation-effects' })

export async function runFinooIdentityPostCommitEffects(
  container: AppContainer,
  event: FinooIdentityMutationEvent,
): Promise<void> {
  const effects = await Promise.allSettled([
    invalidateCrudCache(
      container,
      'customers.person',
      {
        id: event.personId,
        tenantId: event.tenantId,
        organizationId: event.organizationId,
      },
      event.tenantId,
      event.eventId,
    ),
    emitFinooIdentityEvent(event.eventId, {
      tenantId: event.tenantId,
      organizationId: event.organizationId,
      personId: event.personId,
      identityId: event.identityId,
      conflictId: event.conflictId,
      changedFields: event.changedFields,
      isComplete: event.isComplete,
      resolution: event.resolution,
    }, { persistent: true }),
  ])
  for (const effect of effects) {
    if (effect.status === 'rejected') {
      logger.error('FINOO identity post-commit effect failed', {
        error: effect.reason,
        eventId: event.eventId,
        tenantId: event.tenantId,
        organizationId: event.organizationId,
      })
    }
  }
}

export function register(container: AppContainer): void {
  container.register({
    FinooPersonIdentity: asValue(FinooPersonIdentity),
    FinooIdentityImportConflict: asValue(FinooIdentityImportConflict),
    FinooIdentityAuditEntry: asValue(FinooIdentityAuditEntry),
    finooIdentityService: asFunction(({
      em,
      rbacService,
      tenantEncryptionService,
    }: {
      em: EntityManager
      rbacService: RbacService
      tenantEncryptionService: TenantDataEncryptionService
    }) => createFinooIdentityService({
      em,
      rbacService,
      encryptionService: tenantEncryptionService,
      resolveApplicationIdentityRetention: () => {
        if (!container.hasRegistration('finooApplicationIdentityRetention')) return undefined
        return container.resolve('finooApplicationIdentityRetention') as ReturnType<
          NonNullable<Parameters<typeof createFinooIdentityService>[0]['resolveApplicationIdentityRetention']>
        >
      },
      afterMutation: (event) => runFinooIdentityPostCommitEffects(container, event),
    })).scoped().proxy(),
    finooIdentityTechnicalImport: asFunction(({
      finooIdentityService,
    }: {
      finooIdentityService: ReturnType<typeof createFinooIdentityService>
    }) => ({
      createFromTechnicalImport: finooIdentityService.createFromTechnicalImport,
    })).scoped().proxy(),
    finooIdentityRetention: asFunction(({
      finooIdentityService,
    }: {
      finooIdentityService: ReturnType<typeof createFinooIdentityService>
    }) => ({
      anonymizeAndDeleteForPerson: finooIdentityService.anonymizeAndDeleteForPerson,
    })).scoped().proxy(),
  })
}
