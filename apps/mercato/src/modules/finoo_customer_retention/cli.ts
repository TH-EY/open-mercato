import type { EntityManager } from '@mikro-orm/postgresql'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { z } from 'zod'
import { ensureFinooCustomerRetentionOrganizationSetup } from './setup'
import {
  createFinooIdentityErasureExecutor,
  FINOO_IDENTITY_ERASURE_DEFAULT_BATCH_SIZE,
  FINOO_IDENTITY_ERASURE_MAX_BATCH_SIZE,
} from './services/identityErasureExecutor'

const exactScopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})

const usage = 'mercato finoo_customer_retention ensure-organization-setup --tenant <uuid> --organization <uuid> --apply'
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

const ensureOrganizationSetup: ModuleCli = {
  command: 'ensure-organization-setup',
  async run(args) {
    const scope = parseEnsureOrganizationSetupArgs(args)
    if (!scope) throw new Error(`[internal] Invalid arguments. Usage: ${usage}`)

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

const commands = [ensureOrganizationSetup, eraseExpiredIdentities]

export default commands
