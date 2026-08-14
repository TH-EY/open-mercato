import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { assertSesEnvPresetAbsent, assertSesEnvPresetExact, removeSesEnvPreset } from './lib/preset'

async function forEachOrganization(
  operation: (scope: {
    em: EntityManager
    container: Awaited<ReturnType<typeof createRequestContainer>>
    tenantId: string
    organizationId: string
  }) => Promise<void>,
): Promise<void> {
  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  const organizations = await em.find(Organization, { deletedAt: null }, { populate: ['tenant'] as const })
  for (const organization of organizations) {
    await operation({
      em,
      container,
      tenantId: String(organization.tenant.id),
      organizationId: String(organization.id),
    })
  }
}

const assertEnvPresetAbsentCommand: ModuleCli = {
  command: 'assert-env-preset-absent',
  async run() {
    await forEachOrganization(assertSesEnvPresetAbsent)
    console.log('Amazon SES environment preset state is absent for every organization.')
  },
}

const removeEnvPresetCommand: ModuleCli = {
  command: 'remove-env-preset',
  async run() {
    await forEachOrganization(removeSesEnvPreset)
    console.log('Amazon SES environment preset state removed for every organization.')
  },
}

const assertEnvPresetExactCommand: ModuleCli = {
  command: 'assert-env-preset-exact',
  async run() {
    await forEachOrganization(assertSesEnvPresetExact)
    console.log('Amazon SES environment preset state exactly matches every organization.')
  },
}

export default [assertEnvPresetAbsentCommand, assertEnvPresetExactCommand, removeEnvPresetCommand]
