import type { EntityManager } from '@mikro-orm/postgresql'
import { ensureCustomRoleAcls } from '@open-mercato/core/modules/auth/lib/setup-app'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { Module } from '@open-mercato/shared/modules/registry'
import { setup } from '../setup'

const tenantId = process.env.OM_FINOO_IDENTITY_TENANT_ID ?? ''
const organizationId = process.env.OM_FINOO_IDENTITY_ORGANIZATION_ID ?? ''

async function main(): Promise<void> {
  if (!tenantId || !organizationId) throw new Error('integration_scope_missing')
  await bootstrapFromAppRoot(process.cwd())
  const container = await createRequestContainer()
  try {
    const em = (container.resolve('em') as EntityManager).fork()
    await setup.seedDefaults?.({ em, tenantId, organizationId, container })
    await ensureCustomRoleAcls(em, tenantId, [{ id: 'finoo_identities', setup } as Module])
    console.log('FINOO_IDENTITY_SETUP_RESULT {"ok":true}')
  } finally {
    await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`FINOO_IDENTITY_SETUP_ERROR ${message}`)
  process.exitCode = 1
})
