import '@open-mercato/core/modules/customers/commands'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

const tenantId = '123e4567-e89b-41d3-a456-426614174000'
const organizationId = '123e4567-e89b-41d3-a456-426614174001'
const reservedId = '123e4567-e89b-41d3-a456-426614174002'

const context = {
  tenantId,
  organizationId,
  systemActor: false,
  container: { resolve: () => { throw new Error('container_should_not_be_resolved') } },
} as unknown as CommandRuntimeContext

describe('customer create command recovery IDs', () => {
  it.each([
    ['customers.companies.create', { tenantId, organizationId, displayName: 'Company', systemEntityId: reservedId }],
    ['customers.people.create', {
      tenantId,
      organizationId,
      displayName: 'Person',
      firstName: 'Test',
      lastName: 'Person',
      systemEntityId: reservedId,
    }],
    ['customers.deals.create', { tenantId, organizationId, title: 'Deal', systemDealId: reservedId }],
  ])('rejects %s recovery IDs outside a system command context', async (commandId, input) => {
    const handler = commandRegistry.get(commandId) as CommandHandler
    await expect(handler.execute(input, context)).rejects.toThrow('restricted to system commands')
  })
})
