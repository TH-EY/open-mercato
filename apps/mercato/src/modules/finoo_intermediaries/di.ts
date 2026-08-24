import { asFunction } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { createFinooIntermediaryRetentionEligibilityProvider } from './lib/retentionEligibilityProvider'

export function register(container: AppContainer): void {
  container.register({
    finooIntermediaryRetentionEligibilityProvider: asFunction(
      ({ em }: { em: EntityManager }) => createFinooIntermediaryRetentionEligibilityProvider(em),
    ).scoped().proxy(),
  })
}
