import type { EntityManager } from '@mikro-orm/postgresql'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { z } from 'zod'
import { backfillIntermediaryDirectory } from './lib/directoryBackfill'
import { ensureIntermediaryPortalRoleFeature } from './lib/roleFeatureSeed'

const exactScopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})

const usage = 'mercato finoo_intermediaries ensure-portal-role-feature --tenant <uuid> --organization <uuid> --apply'
const backfillUsage = 'mercato finoo_intermediaries backfill-directory --tenant <uuid> --organization <uuid> (--dry-run|--apply)'

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] ?? null : null
}

export function parseEnsurePortalRoleFeatureArgs(args: string[]) {
  if (!args.includes('--apply')) return null
  const parsed = exactScopeSchema.safeParse({
    tenantId: readOption(args, 'tenant'),
    organizationId: readOption(args, 'organization'),
  })
  return parsed.success ? parsed.data : null
}

export function parseBackfillDirectoryArgs(args: string[]) {
  const modeFlags = [args.includes('--dry-run'), args.includes('--apply')]
  const allowedFlags = new Set(['--tenant', '--organization', '--dry-run', '--apply'])
  const optionNames = args.filter((arg) => arg.startsWith('--'))
  if (
    args.length !== 5
    || modeFlags.filter(Boolean).length !== 1
    || optionNames.some((flag) => !allowedFlags.has(flag))
    || optionNames.filter((flag) => flag === '--tenant').length !== 1
    || optionNames.filter((flag) => flag === '--organization').length !== 1
  ) {
    return null
  }
  const parsed = exactScopeSchema.safeParse({
    tenantId: readOption(args, 'tenant'),
    organizationId: readOption(args, 'organization'),
  })
  if (!parsed.success) return null
  return {
    ...parsed.data,
    mode: modeFlags[0] ? 'dry-run' as const : 'apply' as const,
  }
}

const ensurePortalRoleFeature: ModuleCli = {
  command: 'ensure-portal-role-feature',
  async run(args) {
    const scope = parseEnsurePortalRoleFeatureArgs(args)
    if (!scope) {
      throw new Error(`[internal] Invalid arguments. Usage: ${usage}`)
    }

    const container = await createRequestContainer()
    try {
      const em = (container.resolve('em') as EntityManager).fork()
      const customerRbacService = container.resolve('customerRbacService') as CustomerRbacService
      const result = await ensureIntermediaryPortalRoleFeature(em, customerRbacService, scope)
      console.log(JSON.stringify(result, null, 2))
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      await disposable.dispose?.()
    }
  },
}

const backfillDirectory: ModuleCli = {
  command: 'backfill-directory',
  async run(args) {
    const input = parseBackfillDirectoryArgs(args)
    if (!input) throw new Error(`[internal] Invalid arguments. Usage: ${backfillUsage}`)

    const container = await createRequestContainer()
    try {
      const em = (container.resolve('em') as EntityManager).fork()
      let eventBus: { emitEvent(event: string, payload: unknown, options?: unknown): Promise<void> } | undefined
      try {
        eventBus = container.resolve('eventBus') as typeof eventBus
      } catch {
        eventBus = undefined
      }
      const result = await backfillIntermediaryDirectory({
        em,
        eventBus,
        scope: { tenantId: input.tenantId, organizationId: input.organizationId },
        mode: input.mode,
      })
      console.log(JSON.stringify(result, null, 2))
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      await disposable.dispose?.()
    }
  },
}

const commands = [ensurePortalRoleFeature, backfillDirectory]

export default commands
