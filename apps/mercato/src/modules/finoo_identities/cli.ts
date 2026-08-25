import { z } from 'zod'
import type { CacheStrategy } from '@open-mercato/cache'
import { LockMode, type EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { Role, RoleAcl, UserRole } from '@open-mercato/core/modules/auth/data/entities'
import { ensureCustomRoleAcls } from '@open-mercato/core/modules/auth/lib/setup-app'
import { Organization, Tenant } from '@open-mercato/core/modules/directory/data/entities'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { Module, ModuleCli } from '@open-mercato/shared/modules/registry'
import { invalidateDefinitionsCache } from '@open-mercato/core/modules/entities/api/definitions.cache'
import {
  migrateLegacyIdentities,
  purgeLegacyIdentityFields,
  setLegacyIdentityCutover,
  verifyLegacyIdentityMigration,
} from './lib/legacy-migration'
import setup, { FINOO_IOD_ROLE, FINOO_SUPERADMIN_ROLE } from './setup'

const scopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})
const CONFIRMATION_TOKEN = 'THOM-108'
const ensureOrganizationSetupUsage = 'mercato finoo_identities ensure-organization-setup --tenant <uuid> --organization <uuid> --apply'
const identityModule: Module = { id: 'finoo_identities', setup }
const IOD_FEATURES = [
  'customers.people.view',
  'finoo_identities.view',
  'finoo_identities.manage',
]
const FINOO_SUPERADMIN_FEATURE = 'finoo_identities.*'

function expectedIodFeatures(): string[] {
  const features = setup.defaultRoleFeatures?.[FINOO_IOD_ROLE]
  if (!features || JSON.stringify(features) !== JSON.stringify(IOD_FEATURES)) {
    throw new Error('[internal] FINOO IOD role features are not configured exactly')
  }
  return [...IOD_FEATURES]
}

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

export function parseEnsureOrganizationSetupArgs(args: string[]) {
  const allowed = new Set(['--tenant', '--organization', '--apply'])
  const flags = args.filter((argument) => argument.startsWith('--'))
  if (args.length !== 5
    || !args.includes('--apply')
    || !hasExactlyOne(args, 'tenant')
    || !hasExactlyOne(args, 'organization')
    || args.filter((argument) => argument === '--apply').length !== 1
    || flags.some((flag) => !allowed.has(flag))) return null
  return parseScope(args)
}

export async function ensureExistingOrganizationSetup(input: {
  em: EntityManager
  container: AwilixContainer
  tenantId: string
  organizationId: string
}): Promise<{
  iodFeatures: string[]
  assignedUsers: number
  automaticUserAssignments: 0
  finooSuperadminFeatures: string[]
  finooSuperadminAssignedUsers: number
}> {
  const result = await input.em.transactional(async (transactionalEm) => {
    const tenant = await transactionalEm.findOne(Tenant, {
      id: input.tenantId,
      deletedAt: null,
    })
    if (!tenant) throw new Error('[internal] Tenant does not exist in the requested scope')

    const organization = await transactionalEm.findOne(Organization, {
      id: input.organizationId,
      tenant: input.tenantId,
      deletedAt: null,
    })
    if (!organization) {
      throw new Error('[internal] Organization does not exist in the requested tenant scope')
    }

    const finooSuperadminRoles = await findWithDecryption(
      transactionalEm,
      Role,
      { name: FINOO_SUPERADMIN_ROLE, tenantId: input.tenantId, deletedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
      { tenantId: input.tenantId, organizationId: null },
    )
    if (finooSuperadminRoles.length !== 1) {
      throw new Error('[internal] FINOO Superadmin role must exist exactly once in the requested tenant')
    }
    const finooSuperadminRole = finooSuperadminRoles[0]
    const finooSuperadminAcls = await findWithDecryption(
      transactionalEm,
      RoleAcl,
      { role: finooSuperadminRole, tenantId: input.tenantId, deletedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
      { tenantId: input.tenantId, organizationId: null },
    )
    if (finooSuperadminAcls.length !== 1) {
      throw new Error('[internal] FINOO Superadmin role must have exactly one active ACL')
    }
    const finooSuperadminAcl = finooSuperadminAcls[0]
    if (!Array.isArray(finooSuperadminAcl.featuresJson)) {
      throw new Error('[internal] FINOO Superadmin ACL features must be an array')
    }
    const finooSuperadminFeaturesBefore = [...finooSuperadminAcl.featuresJson]
    const finooSuperadminOrganizationsBefore = Array.isArray(finooSuperadminAcl.organizationsJson)
      ? [...finooSuperadminAcl.organizationsJson]
      : finooSuperadminAcl.organizationsJson
    const finooSuperadminFlagBefore = finooSuperadminAcl.isSuperAdmin
    if (finooSuperadminFlagBefore !== false
      || JSON.stringify(finooSuperadminOrganizationsBefore) !== JSON.stringify([input.organizationId])) {
      throw new Error('[internal] FINOO Superadmin ACL is not restricted to the requested organization')
    }
    const finooSuperadminAssignmentsBefore = await transactionalEm.count(UserRole, {
      role: finooSuperadminRole,
      deletedAt: null,
    })

    const roleBefore = await findOneWithDecryption(
      transactionalEm,
      Role,
      { name: FINOO_IOD_ROLE, tenantId: input.tenantId, deletedAt: null },
      {},
      { tenantId: input.tenantId, organizationId: null },
    )
    const assignmentsBefore = roleBefore
      ? await transactionalEm.count(UserRole, { role: roleBefore, deletedAt: null })
      : 0

    if (!setup.seedDefaults) throw new Error('[internal] FINOO identity defaults setup is unavailable')
    await setup.seedDefaults({
      em: transactionalEm,
      container: input.container,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    })
    await ensureCustomRoleAcls(transactionalEm, input.tenantId, [identityModule])

    finooSuperadminAcl.featuresJson = finooSuperadminFeaturesBefore.includes(FINOO_SUPERADMIN_FEATURE)
      ? [...finooSuperadminFeaturesBefore]
      : [...finooSuperadminFeaturesBefore, FINOO_SUPERADMIN_FEATURE]
    await transactionalEm.persist(finooSuperadminAcl).flush()

    const role = await findOneWithDecryption(
      transactionalEm,
      Role,
      { name: FINOO_IOD_ROLE, tenantId: input.tenantId, deletedAt: null },
      {},
      { tenantId: input.tenantId, organizationId: null },
    )
    if (!role) throw new Error('[internal] FINOO IOD role setup failed')

    const activeAcls = await findWithDecryption(
      transactionalEm,
      RoleAcl,
      { role, tenantId: input.tenantId, deletedAt: null },
      {},
      { tenantId: input.tenantId, organizationId: null },
    )
    if (activeAcls.length !== 1) {
      throw new Error('[internal] FINOO IOD role must have exactly one active ACL')
    }
    const features = expectedIodFeatures()
    const acl = activeAcls[0]
    acl.featuresJson = features
    acl.isSuperAdmin = false
    acl.organizationsJson = [input.organizationId]
    await transactionalEm.persist(acl).flush()

    const assignmentsAfter = await transactionalEm.count(UserRole, { role, deletedAt: null })
    if (assignmentsAfter !== assignmentsBefore) {
      throw new Error('[internal] FINOO IOD setup must not assign users automatically')
    }
    const finooSuperadminAssignmentsAfter = await transactionalEm.count(UserRole, {
      role: finooSuperadminRole,
      deletedAt: null,
    })
    if (finooSuperadminAssignmentsAfter !== finooSuperadminAssignmentsBefore) {
      throw new Error('[internal] FINOO Superadmin setup must not change user assignments')
    }
    const verifiedFinooSuperadminAcls = await findWithDecryption(
      transactionalEm,
      RoleAcl,
      { role: finooSuperadminRole, tenantId: input.tenantId, deletedAt: null },
      {},
      { tenantId: input.tenantId, organizationId: null },
    )
    const expectedFinooSuperadminFeatures = finooSuperadminFeaturesBefore.includes(FINOO_SUPERADMIN_FEATURE)
      ? [...finooSuperadminFeaturesBefore]
      : [...finooSuperadminFeaturesBefore, FINOO_SUPERADMIN_FEATURE]
    if (verifiedFinooSuperadminAcls.length !== 1
      || verifiedFinooSuperadminAcls[0].isSuperAdmin !== finooSuperadminFlagBefore
      || JSON.stringify(verifiedFinooSuperadminAcls[0].featuresJson) !== JSON.stringify(expectedFinooSuperadminFeatures)
      || JSON.stringify(verifiedFinooSuperadminAcls[0].organizationsJson) !== JSON.stringify(finooSuperadminOrganizationsBefore)) {
      throw new Error('[internal] FINOO Superadmin identity grant verification failed')
    }
    const verifiedAcl = await findOneWithDecryption(
      transactionalEm,
      RoleAcl,
      { role, tenantId: input.tenantId, deletedAt: null },
      {},
      { tenantId: input.tenantId, organizationId: null },
    )
    if (!verifiedAcl
      || verifiedAcl.isSuperAdmin
      || JSON.stringify(verifiedAcl.featuresJson) !== JSON.stringify(features)
      || JSON.stringify(verifiedAcl.organizationsJson) !== JSON.stringify([input.organizationId])) {
      throw new Error('[internal] FINOO IOD ACL verification failed')
    }
    return {
      iodFeatures: features,
      assignedUsers: assignmentsAfter,
      automaticUserAssignments: 0 as const,
      finooSuperadminFeatures: [FINOO_SUPERADMIN_FEATURE],
      finooSuperadminAssignedUsers: finooSuperadminAssignmentsAfter,
    }
  })
  const rbacService = input.container.resolve('rbacService') as {
    invalidateTenantCache: (tenantId: string) => Promise<void> | void
  }
  await rbacService.invalidateTenantCache(input.tenantId)
  return result
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

export function parseLegacyCutoverArgs(args: string[]) {
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
  return scope
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

const ensureOrganizationSetup: ModuleCli = {
  command: 'ensure-organization-setup',
  async run(args) {
    const scope = parseEnsureOrganizationSetupArgs(args)
    if (!scope) throw new Error(`[internal] Invalid arguments. Usage: ${ensureOrganizationSetupUsage}`)
    const container = await createRequestContainer()
    try {
      const result = await ensureExistingOrganizationSetup({
        em: (container.resolve('em') as EntityManager).fork(),
        container,
        ...scope,
      })
      console.log(JSON.stringify({ ...scope, configured: true, ...result }))
    } finally {
      await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
    }
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
      const scope = parseLegacyCutoverArgs(args)
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
  ensureOrganizationSetup,
  migrateLegacy,
  verifyLegacy,
  cutoverCommand('cutover-legacy', false),
  cutoverCommand('rollback-legacy', true),
  purgeLegacy,
]

export default commands
