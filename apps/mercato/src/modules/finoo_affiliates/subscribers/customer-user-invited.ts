import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerUserInvitation } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { AwilixContainer } from 'awilix'
import { loadAffiliateRole } from '../lib/membership'

export const metadata = {
  event: 'customer_accounts.user.invited',
  persistent: false,
  id: 'finoo_affiliates:customer-user-invited',
}

type SubscriberContext = { resolve: <T = unknown>(name: string) => T; container?: CommandRuntimeContext['container'] }

export default async function handle(payload: unknown, context: SubscriberContext): Promise<void> {
  const data = (payload ?? {}) as Record<string, unknown>
  if (typeof data.invitationId !== 'string') return
  const container = context.container ?? context as unknown as AwilixContainer
  const em = (container.resolve('em') as EntityManager).fork()
  const invitation = await findOneWithDecryption(em, CustomerUserInvitation, { id: data.invitationId }, undefined, {})
  if (!invitation) return
  const role = await loadAffiliateRole(em, invitation.tenantId)
  if (!role || !Array.isArray(invitation.roleIdsJson) || !invitation.roleIdsJson.includes(role.id)) return
  const commandBus = container.resolve('commandBus') as CommandBus
  await commandBus.execute('finoo_affiliates.affiliate.ensure_invitation', {
    input: {
      invitationId: invitation.id,
      tenantId: invitation.tenantId,
      organizationId: invitation.organizationId,
    },
    ctx: {
      container,
      auth: null,
      organizationScope: null,
      selectedOrganizationId: invitation.organizationId,
      organizationIds: [invitation.organizationId],
      systemActor: true,
    },
  })
}
