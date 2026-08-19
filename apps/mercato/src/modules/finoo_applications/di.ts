import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { FinooApplicationIdentityBinding, FinooApplicationIntake, FinooApplicationProjection } from './data/entities'

export function register(container: AppContainer): void {
  container.register({
    FinooApplicationIdentityBinding: asValue(FinooApplicationIdentityBinding),
    FinooApplicationIntake: asValue(FinooApplicationIntake),
    FinooApplicationProjection: asValue(FinooApplicationProjection),
  })
}
