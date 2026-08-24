import type { EntityManager } from '@mikro-orm/postgresql'
import { ensureFinooCustomerRetentionOrganizationSetup } from '../setup'

type OrganizationCreatedPayload = {
  id?: string
  organizationId?: string
  tenantId?: string
}

type SubscriberContext = {
  resolve<T = unknown>(name: string): T
}

export const metadata = {
  event: 'directory.organization.created',
  persistent: true,
  id: 'finoo_customer_retention:organization-created',
}

export default async function handle(
  payload: OrganizationCreatedPayload,
  context: SubscriberContext,
): Promise<void> {
  const organizationId = payload.organizationId ?? payload.id
  if (!payload.tenantId || !organizationId) return
  await ensureFinooCustomerRetentionOrganizationSetup({
    em: context.resolve<EntityManager>('em').fork(),
    container: context,
    tenantId: payload.tenantId,
    organizationId,
  })
}
