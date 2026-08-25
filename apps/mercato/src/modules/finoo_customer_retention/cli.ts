import type { EntityManager } from '@mikro-orm/postgresql'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import fs from 'node:fs'
import { z } from 'zod'
import type { EnsureAdminCredentialResult } from './commands/admin-credential'
import { FINOO_ADMIN_EMAIL } from './commands/admin-credential'
import { ensureFinooCustomerRetentionOrganizationSetup } from './setup'

const exactScopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})

const exactAdminScopeSchema = exactScopeSchema.extend({
  userId: z.string().uuid(),
})

const setupUsage = 'mercato finoo_customer_retention ensure-organization-setup --tenant <uuid> --organization <uuid> --apply'
const credentialUsage = 'mercato finoo_customer_retention ensure-admin-credential --tenant <uuid> --organization <uuid> --user <uuid> --password-stdin --apply'

type OrganizationSetupInput = Parameters<typeof ensureFinooCustomerRetentionOrganizationSetup>[0]

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] ?? null : null
}

export function parseEnsureOrganizationSetupArgs(args: string[]) {
  const allowedFlags = new Set(['--tenant', '--organization', '--apply'])
  const optionNames = args.filter((arg) => arg.startsWith('--'))
  if (
    args.length !== 5
    || !args.includes('--apply')
    || optionNames.some((flag) => !allowedFlags.has(flag))
    || optionNames.filter((flag) => flag === '--tenant').length !== 1
    || optionNames.filter((flag) => flag === '--organization').length !== 1
    || optionNames.filter((flag) => flag === '--apply').length !== 1
  ) {
    return null
  }
  const parsed = exactScopeSchema.safeParse({
    tenantId: readOption(args, 'tenant'),
    organizationId: readOption(args, 'organization'),
  })
  return parsed.success ? parsed.data : null
}

export function parseEnsureAdminCredentialArgs(args: string[]) {
  const allowedFlags = new Set(['--tenant', '--organization', '--user', '--password-stdin', '--apply'])
  const optionNames = args.filter((arg) => arg.startsWith('--'))
  if (
    args.length !== 8
    || !args.includes('--password-stdin')
    || !args.includes('--apply')
    || optionNames.some((flag) => !allowedFlags.has(flag))
    || optionNames.some((flag) => optionNames.filter((candidate) => candidate === flag).length !== 1)
  ) {
    return null
  }
  const parsed = exactAdminScopeSchema.safeParse({
    tenantId: readOption(args, 'tenant'),
    organizationId: readOption(args, 'organization'),
    userId: readOption(args, 'user'),
  })
  return parsed.success ? parsed.data : null
}

export function parsePasswordFromStdin(raw: string): string {
  const withoutLineFeed = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  const password = withoutLineFeed.endsWith('\r') ? withoutLineFeed.slice(0, -1) : withoutLineFeed
  if (!password || /[\r\n]/.test(password)) {
    throw new Error('[internal] Password stdin must contain exactly one non-empty line')
  }
  return password
}

export async function ensureExistingOrganizationSetup(input: OrganizationSetupInput): Promise<void> {
  const organization = await input.em.findOne(Organization, {
    id: input.organizationId,
    tenant: input.tenantId,
    deletedAt: null,
  })
  if (!organization) {
    throw new Error('[internal] Organization does not exist in the requested tenant scope')
  }
  await ensureFinooCustomerRetentionOrganizationSetup(input)
}

type EnsureAdminCredentialInput = {
  container: Awaited<ReturnType<typeof createRequestContainer>>
  commandBus: CommandBus
  tenantId: string
  organizationId: string
  userId: string
  password: string
}

function buildSystemCommandContext(
  container: Awaited<ReturnType<typeof createRequestContainer>>,
): CommandRuntimeContext {
  return {
    container,
    auth: null,
    organizationScope: null,
    selectedOrganizationId: null,
    organizationIds: null,
    systemActor: true,
  }
}

export async function ensureFinooAdminCredential(
  input: EnsureAdminCredentialInput,
): Promise<'unchanged' | 'updated'> {
  const { result } = await input.commandBus.execute<
    Omit<EnsureAdminCredentialInput, 'container' | 'commandBus'>,
    EnsureAdminCredentialResult
  >('finoo_customer_retention.admin.ensure_credential', {
    input: {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      userId: input.userId,
      password: input.password,
    },
    ctx: buildSystemCommandContext(input.container),
    metadata: { skipLog: true },
  })
  if (
    result.id !== input.userId
    || result.tenantId !== input.tenantId
    || result.organizationId !== input.organizationId
    || result.email !== FINOO_ADMIN_EMAIL
  ) {
    throw new Error('[internal] Finoo admin credential result scope mismatch')
  }
  return result.credential
}

const ensureOrganizationSetup: ModuleCli = {
  command: 'ensure-organization-setup',
  async run(args) {
    const scope = parseEnsureOrganizationSetupArgs(args)
    if (!scope) throw new Error(`[internal] Invalid arguments. Usage: ${setupUsage}`)

    const container = await createRequestContainer()
    try {
      const em = (container.resolve('em') as EntityManager).fork()
      await ensureExistingOrganizationSetup({
        em,
        container,
        ...scope,
      })
      console.log(JSON.stringify({ ...scope, configured: true }))
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      await disposable.dispose?.()
    }
  },
}

const ensureAdminCredential: ModuleCli = {
  command: 'ensure-admin-credential',
  async run(args) {
    const scope = parseEnsureAdminCredentialArgs(args)
    if (!scope) throw new Error(`[internal] Invalid arguments. Usage: ${credentialUsage}`)
    const password = parsePasswordFromStdin(fs.readFileSync(0, 'utf8'))

    const container = await createRequestContainer()
    try {
      const status = await ensureFinooAdminCredential({
        container,
        commandBus: container.resolve('commandBus') as CommandBus,
        password,
        ...scope,
      })
      console.log(JSON.stringify({ ...scope, credential: status }))
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      await disposable.dispose?.()
    }
  },
}

const commands = [ensureOrganizationSetup, ensureAdminCredential]

export default commands
