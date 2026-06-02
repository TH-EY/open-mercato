import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerSettings, type CustomerAddressFormat } from '../data/entities'
import {
  customerDictionarySortModesUpsertSchema,
  customerSettingsUpsertSchema,
  type CustomerDictionarySortModesUpsertInput,
  type CustomerSettingsUpsertInput,
} from '../data/validators'
import { ensureOrganizationScope, ensureTenantScope } from './shared'

export async function loadCustomerSettings(
  em: EntityManager,
  params: { tenantId: string; organizationId: string }
): Promise<CustomerSettings | null> {
  return em.findOne(CustomerSettings, {
    tenantId: params.tenantId,
    organizationId: params.organizationId,
  })
}

const saveCustomerSettingsCommand: CommandHandler<
  CustomerSettingsUpsertInput,
  { settingsId: string; addressFormat: CustomerAddressFormat }
> = {
  id: 'customers.settings.save',
  async execute(rawInput, ctx) {
    const input = customerSettingsUpsertSchema.parse(rawInput)
    ensureTenantScope(ctx, input.tenantId)
    ensureOrganizationScope(ctx, input.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let settings = await loadCustomerSettings(em, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    })

    if (!settings) {
      settings = em.create(CustomerSettings, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        addressFormat: input.addressFormat,
      })
      em.persist(settings)
    } else if (settings.addressFormat !== input.addressFormat) {
      settings.addressFormat = input.addressFormat
      settings.updatedAt = new Date()
    }

    await em.flush()

    return {
      settingsId: settings.id,
      addressFormat: settings.addressFormat,
    }
  },
}

registerCommand(saveCustomerSettingsCommand)

const saveDictionarySortModesCommand: CommandHandler<
  CustomerDictionarySortModesUpsertInput,
  { settingsId: string; dictionarySortModes: CustomerDictionarySortModesUpsertInput['dictionarySortModes'] }
> = {
  id: 'customers.settings.save_dictionary_sort_modes',
  async execute(rawInput, ctx) {
    const input = customerDictionarySortModesUpsertSchema.parse(rawInput)
    ensureTenantScope(ctx, input.tenantId)
    ensureOrganizationScope(ctx, input.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let settings = await loadCustomerSettings(em, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    })

    if (!settings) {
      settings = em.create(CustomerSettings, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        dictionarySortModes: input.dictionarySortModes,
      })
      em.persist(settings)
    } else {
      settings.dictionarySortModes = input.dictionarySortModes
      settings.updatedAt = new Date()
    }

    await em.flush()

    return {
      settingsId: settings.id,
      dictionarySortModes: settings.dictionarySortModes ?? {},
    }
  },
}

registerCommand(saveDictionarySortModesCommand)
