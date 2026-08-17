import type { AwilixContainer } from 'awilix'
import { z } from 'zod'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('finoo_intermediaries').child({
  component: 'customer-invitation-accepted',
})

const acceptedInvitationSchema = z.object({
  invitationId: z.string().uuid(),
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
}).strict()

export const metadata = {
  event: 'customer_accounts.invitation.accepted',
  persistent: true,
  id: 'finoo_intermediaries:customer-invitation-accepted',
}

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
  container?: CommandRuntimeContext['container']
}

export default async function handle(payload: unknown, context: SubscriberContext): Promise<void> {
  const parsed = acceptedInvitationSchema.safeParse(payload)
  if (!parsed.success) return
  const container = context.container ?? context as unknown as AwilixContainer
  const commandBus = container.resolve('commandBus') as CommandBus
  try {
    await commandBus.execute('finoo_intermediaries.intermediary.activate_from_invitation', {
      input: parsed.data,
      ctx: {
        container,
        auth: null,
        organizationScope: null,
        selectedOrganizationId: null,
        organizationIds: null,
        systemActor: true,
      },
      metadata: {
        tenantId: parsed.data.tenantId,
        actorUserId: null,
        resourceKind: 'finoo_intermediaries.intermediary',
        resourceId: parsed.data.invitationId,
      },
    })
  } catch (error) {
    if (isCrudHttpError(error) && (error.status === 404 || error.status === 409)) {
      logger.warn('Invitation acceptance did not match a scoped intermediary lifecycle', {
        invitationId: parsed.data.invitationId,
        tenantId: parsed.data.tenantId,
        status: error.status,
      })
      return
    }
    throw error
  }
}
