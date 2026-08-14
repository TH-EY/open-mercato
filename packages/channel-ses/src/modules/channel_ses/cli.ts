import type { EntityManager } from '@mikro-orm/postgresql'
import { readFileSync } from 'node:fs'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { sesExplicitCredentialsInputSchema } from './lib/credentials'
import {
  assertSesEnvPresetAbsent,
  assertSesEnvPresetExact,
  assertSesExplicitCredentialsExact,
  assertSesExplicitCredentialsHealthy,
  configureSesExplicitCredentials,
  removeSesEnvPreset,
  restoreSesAmbientCredentials,
  type PresetScope,
} from './lib/preset'

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] ?? null : null
}

function readExplicitCredentialsFromStdin() {
  try {
    return sesExplicitCredentialsInputSchema.parse(JSON.parse(readFileSync(0, 'utf8')))
  } catch {
    throw new Error('[internal] Invalid Amazon SES dedicated credential input')
  }
}

async function withRequestedOrganization(
  args: string[],
  operation: (scope: PresetScope) => Promise<void>,
): Promise<void> {
  const tenantId = readOption(args, 'tenant')
  const organizationId = readOption(args, 'organization')
  if (!tenantId || !organizationId) {
    throw new Error('[internal] Required options: --tenant <id> --organization <id>')
  }
  const container = await createRequestContainer()
  try {
    const em = (container.resolve('em') as EntityManager).fork()
    const organization = await em.findOne(
      Organization,
      { id: organizationId, deletedAt: null },
      { populate: ['tenant'] as const },
    )
    if (!organization || String(organization.tenant.id) !== tenantId) {
      throw new Error('[internal] Requested SES tenant and organization scope does not exist')
    }
    await operation({ em, container, tenantId, organizationId })
  } finally {
    const disposable = container as unknown as { dispose?: () => Promise<void> }
    await disposable.dispose?.()
  }
}

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

const configureExplicitCredentialsCommand: ModuleCli = {
  command: 'configure-explicit-credentials',
  async run(args) {
    const input = readExplicitCredentialsFromStdin()
    await withRequestedOrganization(args, (scope) => configureSesExplicitCredentials(scope, input))
    console.log('Amazon SES dedicated credentials configured for the requested scope.')
  },
}

const restoreAmbientCredentialsCommand: ModuleCli = {
  command: 'restore-ambient-credentials',
  async run(args) {
    await withRequestedOrganization(args, restoreSesAmbientCredentials)
    console.log('Amazon SES ambient credentials restored for the requested scope.')
  },
}

const assertExplicitCredentialsCommand: ModuleCli = {
  command: 'assert-explicit-credentials',
  async run(args) {
    await withRequestedOrganization(args, async (scope) => {
      await assertSesExplicitCredentialsExact(scope)
    })
    console.log('Amazon SES dedicated credentials are present for the requested scope.')
  },
}

const assertCredentialsHealthCommand: ModuleCli = {
  command: 'assert-credentials-health',
  async run(args) {
    await withRequestedOrganization(args, assertSesExplicitCredentialsHealthy)
    console.log('Amazon SES dedicated credentials are healthy for the requested scope.')
  },
}

const commands = [
  assertEnvPresetAbsentCommand,
  assertEnvPresetExactCommand,
  removeEnvPresetCommand,
  configureExplicitCredentialsCommand,
  restoreAmbientCredentialsCommand,
  assertExplicitCredentialsCommand,
  assertCredentialsHealthCommand,
]

export default commands
