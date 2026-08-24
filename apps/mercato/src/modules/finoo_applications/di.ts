import { asFunction, asValue } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { FinooApplicationIdentityBinding, FinooApplicationIntake, FinooApplicationProjection } from './data/entities'
import { eraseFinooApplicationIdentityCopies } from './lib/identity-retention'

export function register(container: AppContainer): void {
  container.register({
    FinooApplicationIdentityBinding: asValue(FinooApplicationIdentityBinding),
    FinooApplicationIntake: asValue(FinooApplicationIntake),
    FinooApplicationProjection: asValue(FinooApplicationProjection),
    finooApplicationIdentityRetention: asFunction(({
      em,
      tenantEncryptionService,
    }: {
      em: EntityManager
      tenantEncryptionService: TenantDataEncryptionService
    }) => ({
      erasePersonIdentityCopies: (input: {
        em?: EntityManager
        tenantId: string
        organizationId: string
        personId: string
      }) => eraseFinooApplicationIdentityCopies({
        ...input,
        em: input.em ?? em,
        encryptionService: tenantEncryptionService,
      }),
    })).scoped().proxy(),
  })
}
