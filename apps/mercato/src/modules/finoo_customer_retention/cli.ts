import type { EntityManager } from '@mikro-orm/postgresql'
import type { CacheStrategy } from '@open-mercato/cache'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import fs from 'node:fs'
import { z } from 'zod'
import {
  ensureAdminCredentialCommand,
  FINOO_ADMIN_EMAIL,
} from './commands/admin-credential'
import { ensureFinooCustomerRetentionOrganizationSetup } from './setup'
import {
  createFinooIdentityErasureExecutor,
  FINOO_IDENTITY_ERASURE_DEFAULT_BATCH_SIZE,
  FINOO_IDENTITY_ERASURE_MAX_BATCH_SIZE,
} from './services/identityErasureExecutor'
import { ensureFinooCustomerRetentionCustomFieldDefinitions } from './lib/custom-field-definitions'

const exactScopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})

const exactAdminScopeSchema = exactScopeSchema.extend({
  userId: z.string().uuid(),
})

const setupUsage = 'mercato finoo_customer_retention ensure-organization-setup --tenant <uuid> --organization <uuid> --apply'
const credentialUsage = 'mercato finoo_customer_retention ensure-admin-credential --tenant <uuid> --organization <uuid> --user <uuid> --password-stdin --apply'
const eraseUsage = 'mercato finoo_customer_retention erase-expired-identities --tenant <uuid> --organization <uuid> (--dry-run | --apply --maintenance-window --confirm THOM-108) [--batch-size <1-500>]'

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

const erasureArgsSchema = exactScopeSchema.extend({
  batchSize: z.coerce.number().int().min(1).max(FINOO_IDENTITY_ERASURE_MAX_BATCH_SIZE),
})

export type IdentityErasureCliArgs = z.infer<typeof erasureArgsSchema> & {
  apply: boolean
}

export function parseIdentityErasureArgs(args: string[]): IdentityErasureCliArgs | null {
  const allowedFlags = new Set([
    '--tenant',
    '--organization',
    '--dry-run',
    '--apply',
    '--maintenance-window',
    '--confirm',
    '--batch-size',
  ])
  const optionNames = args.filter((arg) => arg.startsWith('--'))
  if (
    optionNames.some((flag) => !allowedFlags.has(flag))
    || new Set(optionNames).size !== optionNames.length
    || optionNames.filter((flag) => flag === '--tenant').length !== 1
    || optionNames.filter((flag) => flag === '--organization').length !== 1
  ) return null

  const apply = args.includes('--apply')
  const dryRun = args.includes('--dry-run')
  const maintenanceWindow = args.includes('--maintenance-window')
  const confirmation = readOption(args, 'confirm')
  if (apply === dryRun) return null
  if (apply && (!maintenanceWindow || confirmation !== 'THOM-108')) return null
  if (dryRun && (maintenanceWindow || args.includes('--confirm'))) return null

  const valueOptions = ['tenant', 'organization', 'confirm', 'batch-size']
  const expectedLength = optionNames.length + valueOptions.filter((name) => args.includes(`--${name}`)).length
  if (args.length !== expectedLength) return null

  const parsed = erasureArgsSchema.safeParse({
    tenantId: readOption(args, 'tenant'),
    organizationId: readOption(args, 'organization'),
    batchSize: readOption(args, 'batch-size') ?? FINOO_IDENTITY_ERASURE_DEFAULT_BATCH_SIZE,
  })
  return parsed.success ? { ...parsed.data, apply } : null
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

export async function ensureExistingOrganizationSetup(input: OrganizationSetupInput) {
  const organization = await input.em.findOne(Organization, {
    id: input.organizationId,
    tenant: input.tenantId,
    deletedAt: null,
  })
  if (!organization) {
    throw new Error('[internal] Organization does not exist in the requested tenant scope')
  }
  const cache = input.container.resolve<CacheStrategy>('cache')
  const customFieldDefinitions = await ensureFinooCustomerRetentionCustomFieldDefinitions({
    em: input.em,
    cache,
    tenantId: input.tenantId,
  })
  await ensureFinooCustomerRetentionOrganizationSetup(input)
  return customFieldDefinitions
}

type EnsureAdminCredentialInput = {
  container: Awaited<ReturnType<typeof createRequestContainer>>
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
  const result = await ensureAdminCredentialCommand.execute({
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    userId: input.userId,
    password: input.password,
  }, buildSystemCommandContext(input.container))
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
      const customFieldDefinitions = await ensureExistingOrganizationSetup({
        em,
        container,
        ...scope,
      })
      console.log(JSON.stringify({ ...scope, configured: true, customFieldDefinitions }))
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      await disposable.dispose?.()
    }
  },
}

const eraseExpiredIdentities: ModuleCli = {
  command: 'erase-expired-identities',
  async run(args) {
    const input = parseIdentityErasureArgs(args)
    if (!input) throw new Error(`[internal] Invalid arguments. Usage: ${eraseUsage}`)

    const container = await createRequestContainer()
    try {
      const em = (container.resolve('em') as EntityManager).fork()
      const executor = createFinooIdentityErasureExecutor({ em, container })
      const result = await executor.execute(input)
      console.log(JSON.stringify({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        mode: input.apply ? 'apply' : 'dry-run',
        batchSize: input.batchSize,
        ...result,
      }))
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

const commands = [ensureOrganizationSetup, ensureAdminCredential, eraseExpiredIdentities]

export default commands
