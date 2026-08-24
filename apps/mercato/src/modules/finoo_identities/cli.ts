import { z } from 'zod'
import type { CacheStrategy } from '@open-mercato/cache'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { invalidateDefinitionsCache } from '@open-mercato/core/modules/entities/api/definitions.cache'
import {
  migrateLegacyIdentities,
  purgeLegacyIdentityFields,
  setLegacyIdentityCutover,
  verifyLegacyIdentityMigration,
} from './lib/legacy-migration'

const scopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})
const CONFIRMATION_TOKEN = 'THOM-108'

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] ?? null : null
}

function hasExactlyOne(args: string[], name: string): boolean {
  return args.filter((argument) => argument === `--${name}`).length === 1
}

function parseScope(args: string[]) {
  const parsed = scopeSchema.safeParse({
    tenantId: readOption(args, 'tenant'),
    organizationId: readOption(args, 'organization'),
  })
  return parsed.success ? parsed.data : null
}

export function parseLegacyMigrationArgs(args: string[]) {
  const allowed = new Set(['--tenant', '--organization', '--dry-run', '--apply', '--batch-size'])
  const flags = args.filter((argument) => argument.startsWith('--'))
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const scope = parseScope(args)
  const batchSizeValue = readOption(args, 'batch-size')
  const batchSize = batchSizeValue === null ? 100 : Number(batchSizeValue)
  if (!scope
    || dryRun === apply
    || args.filter((argument) => argument === '--dry-run').length > 1
    || args.filter((argument) => argument === '--apply').length > 1
    || ![5, 7].includes(args.length)
    || !hasExactlyOne(args, 'tenant')
    || !hasExactlyOne(args, 'organization')
    || flags.some((flag) => !allowed.has(flag))
    || (batchSizeValue !== null && !hasExactlyOne(args, 'batch-size'))
    || !Number.isInteger(batchSize)
    || batchSize < 1
    || batchSize > 500) return null
  return { ...scope, mode: dryRun ? 'dry-run' as const : 'apply' as const, batchSize }
}

export function parseLegacyVerifyArgs(args: string[]) {
  if (args.length !== 4
    || !hasExactlyOne(args, 'tenant')
    || !hasExactlyOne(args, 'organization')
    || args.some((argument, index) => index % 2 === 0 && !['--tenant', '--organization'].includes(argument))) return null
  return parseScope(args)
}

export function parseLegacyCutoverArgs(args: string[], action: 'cutover' | 'rollback') {
  const allowed = new Set(['--tenant', '--organization', '--apply', '--maintenance-window', '--confirm'])
  const flags = args.filter((argument) => argument.startsWith('--'))
  const scope = parseScope(args)
  if (!scope
    || args.length !== 8
    || !args.includes('--apply')
    || !args.includes('--maintenance-window')
    || readOption(args, 'confirm') !== CONFIRMATION_TOKEN
    || !hasExactlyOne(args, 'tenant')
    || !hasExactlyOne(args, 'organization')
    || !hasExactlyOne(args, 'confirm')
    || flags.some((flag) => !allowed.has(flag))) return null
  return { ...scope, action }
}

export function parseLegacyPurgeArgs(args: string[]) {
  if (args.includes('--dry-run')) return parseLegacyMigrationArgs(args)
  if (!args.includes('--maintenance-window')
    || readOption(args, 'confirm') !== CONFIRMATION_TOKEN
    || !hasExactlyOne(args, 'confirm')) return null
  const migrationArgs: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--maintenance-window') continue
    if (args[index] === '--confirm') {
      index += 1
      continue
    }
    migrationArgs.push(args[index])
  }
  const migration = parseLegacyMigrationArgs(migrationArgs)
  return migration?.mode === 'apply' ? migration : null
}

async function withContainer<T>(callback: (dependencies: {
  em: EntityManager
  encryptionService: TenantDataEncryptionService
  cache?: CacheStrategy
}) => Promise<T>): Promise<T> {
  const container = await createRequestContainer()
  try {
    const em = (container.resolve('em') as EntityManager).fork()
    const encryptionService = container.resolve('tenantEncryptionService') as TenantDataEncryptionService
    let cache: CacheStrategy | undefined
    try {
      cache = container.resolve('cache') as CacheStrategy
    } catch {
      cache = undefined
    }
    return await callback({ em, encryptionService, cache })
  } finally {
    await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
  }
}

const migrateLegacy: ModuleCli = {
  command: 'migrate-legacy',
  async run(args) {
    const input = parseLegacyMigrationArgs(args)
    if (!input) {
      throw new Error('[internal] Usage: mercato finoo_identities migrate-legacy --tenant <uuid> --organization <uuid> (--dry-run|--apply) [--batch-size 1..500]')
    }
    const result = await withContainer(({ em, encryptionService }) => migrateLegacyIdentities({
      em,
      encryptionService,
      scope: { tenantId: input.tenantId, organizationId: input.organizationId },
      mode: input.mode,
      batchSize: input.batchSize,
    }))
    console.log(JSON.stringify(result))
  },
}

const verifyLegacy: ModuleCli = {
  command: 'verify-legacy',
  async run(args) {
    const scope = parseLegacyVerifyArgs(args)
    if (!scope) {
      throw new Error('[internal] Usage: mercato finoo_identities verify-legacy --tenant <uuid> --organization <uuid>')
    }
    const result = await withContainer(({ em, encryptionService }) => (
      verifyLegacyIdentityMigration(em, encryptionService, scope)
    ))
    console.log(JSON.stringify(result))
  },
}

function cutoverCommand(command: 'cutover-legacy' | 'rollback-legacy', active: boolean): ModuleCli {
  return {
    command,
    async run(args) {
      const scope = parseLegacyCutoverArgs(args, active ? 'rollback' : 'cutover')
      if (!scope) {
        throw new Error(`[internal] Usage: mercato finoo_identities ${command} --tenant <uuid> --organization <uuid> --apply --maintenance-window --confirm ${CONFIRMATION_TOKEN}`)
      }
      const result = await withContainer(async ({ em, encryptionService, cache }) => {
        const changed = await setLegacyIdentityCutover({ em, encryptionService, scope, active })
        await invalidateDefinitionsCache(cache, {
          ...scope,
          entityIds: ['customers:customer_person_profile'],
        })
        return { ...changed, requiresStructuralCachePurge: true }
      })
      console.log(JSON.stringify(result))
    },
  }
}

const purgeLegacy: ModuleCli = {
  command: 'purge-legacy',
  async run(args) {
    const input = parseLegacyPurgeArgs(args)
    if (!input) {
      throw new Error(`[internal] Usage: mercato finoo_identities purge-legacy --tenant <uuid> --organization <uuid> (--dry-run|--apply --maintenance-window --confirm ${CONFIRMATION_TOKEN}) [--batch-size 1..500]`)
    }
    const result = await withContainer(async ({ em, encryptionService, cache }) => {
      const purged = await purgeLegacyIdentityFields({
        em,
        encryptionService,
        scope: { tenantId: input.tenantId, organizationId: input.organizationId },
        mode: input.mode,
        batchSize: input.batchSize,
      })
      if (input.mode === 'apply') {
        await invalidateDefinitionsCache(cache, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          entityIds: ['customers:customer_person_profile'],
        })
      }
      return purged
    })
    console.log(JSON.stringify(result))
  },
}

const commands = [
  migrateLegacy,
  verifyLegacy,
  cutoverCommand('cutover-legacy', false),
  cutoverCommand('rollback-legacy', true),
  purgeLegacy,
]

export default commands
