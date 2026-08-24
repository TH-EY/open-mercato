import { asFunction, asValue } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  FinooCustomerRetentionSettings,
  FinooCustomerRetentionState,
} from './data/entities'
import { createFinooCustomerRetentionProjectionService } from './services/projectionService'
import { createFinooCustomerRetentionPreviewService } from './services/previewService'
import { createFinooCustomerRetentionSettingsService } from './services/settingsService'

export function register(container: AppContainer): void {
  container.register({
    FinooCustomerRetentionSettings: asValue(FinooCustomerRetentionSettings),
    FinooCustomerRetentionState: asValue(FinooCustomerRetentionState),
    finooCustomerRetentionProjectionService: asFunction(
      ({ em }: { em: EntityManager }) =>
        createFinooCustomerRetentionProjectionService({
          em,
          container,
        }),
    ).scoped().proxy(),
    finooCustomerRetentionPreviewService: asFunction(
      ({ em }: { em: EntityManager }) =>
        createFinooCustomerRetentionPreviewService({
          em,
          container,
        }),
    ).scoped().proxy(),
    finooCustomerRetentionSettingsService: asFunction(
      ({
        em,
        finooCustomerRetentionPreviewService,
      }: {
        em: EntityManager
        finooCustomerRetentionPreviewService: ReturnType<typeof createFinooCustomerRetentionPreviewService>
      }) => createFinooCustomerRetentionSettingsService({
        em,
        previewService: finooCustomerRetentionPreviewService,
        container,
      }),
    ).scoped().proxy(),
  })
}
