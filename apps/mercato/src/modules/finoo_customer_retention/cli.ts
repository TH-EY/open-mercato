import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { z } from 'zod'
import { ensureFinooCustomerRetentionOrganizationSetup } from './setup'

const exactScopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})

const usage = 'mercato finoo_customer_retention ensure-organization-setup --tenant <uuid> --organization <uuid> --apply'

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

const ensureOrganizationSetup: ModuleCli = {
  command: 'ensure-organization-setup',
  async run(args) {
    const scope = parseEnsureOrganizationSetupArgs(args)
    if (!scope) throw new Error(`[internal] Invalid arguments. Usage: ${usage}`)

    const container = await createRequestContainer()
    try {
      const em = (container.resolve('em') as EntityManager).fork()
      await ensureFinooCustomerRetentionOrganizationSetup({
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

const commands = [ensureOrganizationSetup]

export default commands
