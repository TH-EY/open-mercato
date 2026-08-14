import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { repairAffiliateMemberships } from './lib/membershipRepair'

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] ?? null : null
}

const repairMemberships: ModuleCli = {
  command: 'repair-memberships',
  async run(args) {
    const tenantId = readOption(args, 'tenant')
    const organizationId = readOption(args, 'organization')
    const dryRun = args.includes('--dry-run')
    const apply = args.includes('--apply')
    if (!tenantId || !organizationId || dryRun === apply) {
      console.error('Usage: mercato finoo_affiliates repair-memberships --tenant <id> --organization <id> (--dry-run|--apply)')
      return
    }
    const container = await createRequestContainer()
    try {
      const em = (container.resolve('em') as EntityManager).fork()
      const result = await repairAffiliateMemberships(em, { tenantId, organizationId }, apply)
      console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }, null, 2))
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      await disposable.dispose?.()
    }
  },
}

const commands = [repairMemberships]

export default commands
