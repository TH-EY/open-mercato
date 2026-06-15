import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { seedEpcDemoExamples } from './seed'

function parseArgs(rest: string[]) {
  const args: Record<string, string> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index]
    if (!part?.startsWith('--')) continue
    const [rawKey, rawValue] = part.slice(2).split('=')
    if (rawValue !== undefined) args[rawKey] = rawValue
    else if (rest[index + 1] && !rest[index + 1]!.startsWith('--')) {
      args[rawKey] = rest[index + 1]!
      index += 1
    }
  }
  return args
}

const seedExamplesCommand: ModuleCli = {
  command: 'seed-examples',
  async run(rest) {
    const args = parseArgs(rest)
    const tenantId = String(args.tenantId ?? args.tenant ?? '')
    const organizationId = String(args.organizationId ?? args.org ?? args.orgId ?? '')
    if (!tenantId || !organizationId) {
      console.error('Usage: mercato epc_demo seed-examples --tenant <tenantId> --org <organizationId>')
      return
    }

    const container = await createRequestContainer()
    try {
      const em = container.resolve<EntityManager>('em')
      await em.transactional(async (tem) => {
        await seedEpcDemoExamples(tem, container, { tenantId, organizationId })
      })
      console.log('EPC demo customer portal examples seeded for organization', organizationId)
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      if (typeof disposable.dispose === 'function') await disposable.dispose()
    }
  },
}

export default [seedExamplesCommand]

