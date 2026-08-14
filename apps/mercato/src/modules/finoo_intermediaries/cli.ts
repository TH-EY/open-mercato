import type { EntityManager } from '@mikro-orm/postgresql'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { z } from 'zod'
import { ensureIntermediaryPortalRoleFeature } from './lib/roleFeatureSeed'

const exactScopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})

const usage = 'mercato finoo_intermediaries ensure-portal-role-feature --tenant <uuid> --organization <uuid> --apply'

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

const commands = [ensurePortalRoleFeature]

export default commands
