import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerUser, CustomerUserInvitation } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { AwilixContainer } from 'awilix'
import { loadAffiliateRole } from '../lib/membership'

export const metadata = {
  event: 'customer_accounts.invitation.accepted',
  persistent: false,
  id: 'finoo_affiliates:customer-invitation-accepted',
}

type SubscriberContext = { resolve: <T = unknown>(name: string) => T; container?: CommandRuntimeContext['container'] }

export default async function handle(payload: unknown, context: SubscriberContext): Promise<void> {
  const data = (payload ?? {}) as Record<string, unknown>
  if (typeof data.invitationId !== 'string' || typeof data.userId !== 'string') return
  const container = context.container ?? context as unknown as AwilixContainer
  const em = (container.resolve('em') as EntityManager).fork()
  const invitation = await findOneWithDecryption(em, CustomerUserInvitation, { id: data.invitationId }, undefined, {})
  if (!invitation?.acceptedAt) return
  const role = await loadAffiliateRole(em, invitation.tenantId)
  if (!role || !Array.isArray(invitation.roleIdsJson) || !invitation.roleIdsJson.includes(role.id)) return
  const scope = { tenantId: invitation.tenantId, organizationId: invitation.organizationId }
  const user = await findOneWithDecryption(em, CustomerUser, { id: data.userId, ...scope, deletedAt: null }, undefined, scope)
  if (!user) return
  const commandBus = container.resolve('commandBus') as CommandBus
  await commandBus.execute('finoo_affiliates.affiliate.activate', {
    input: { invitationId: invitation.id, userId: user.id, ...scope },
    ctx: {
      container,
      auth: null,
      organizationScope: null,
      selectedOrganizationId: scope.organizationId,
      organizationIds: [scope.organizationId],
      systemActor: true,
    },
  })
}
