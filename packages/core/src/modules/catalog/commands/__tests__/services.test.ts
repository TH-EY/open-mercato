export {}

const registerCommand = jest.fn()

jest.mock('@open-mercato/shared/lib/commands', () => ({ registerCommand }))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn().mockResolvedValue({
    translate: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

const ORG = '22222222-2222-4222-8222-222222222222'
const OTHER_ORG = '44444444-4444-4444-8444-444444444444'
const TENANT = '33333333-3333-4333-8333-333333333333'
const SERVICE_ID = '11111111-1111-4111-8111-111111111111'

type ServiceCommand = {
  execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>
}

function loadCommand(id: string): ServiceCommand {
  let command: unknown
  jest.isolateModules(() => {
    require('../services')
    command = registerCommand.mock.calls.find(([candidate]) => candidate.id === id)?.[0]
  })
  if (!command) throw new Error(`command ${id} not registered`)
  return command as ServiceCommand
}

function buildEm(record: Record<string, unknown> | null = null) {
  const em: Record<string, jest.Mock> = {
    findOne: jest.fn().mockResolvedValue(record),
    create: jest.fn().mockImplementation((_entity: unknown, payload: Record<string, unknown>) => ({
      id: SERVICE_ID,
      ...payload,
    })),
    persist: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    begin: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  }
  em.fork = jest.fn().mockReturnValue(em)
  return em
}

function buildCtx(em: Record<string, jest.Mock>, organizationId = ORG) {
  const dataEngine = {
    markOrmEntityChange: jest.fn(),
    setCustomFields: jest.fn().mockResolvedValue(undefined),
  }
  return {
    ctx: {
      container: {
        resolve: jest.fn((token: string) => {
          if (token === 'em') return em
          if (token === 'dataEngine') return dataEngine
          return undefined
        }),
      },
      auth: { sub: 'user-1', tenantId: TENANT, orgId: organizationId },
      organizationScope: null,
      selectedOrganizationId: organizationId,
      organizationIds: [organizationId],
    },
    dataEngine,
  }
}

describe('catalog services commands', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.resetModules()
  })

  it('persists custom fields and indexes the registered catalog service entity on create', async () => {
    const command = loadCommand('catalog.services.create')
    const em = buildEm()
    const { ctx, dataEngine } = buildCtx(em)

    await command.execute({
      organizationId: ORG,
      tenantId: TENANT,
      title: 'Implementation workshop',
      customFields: { delivery_notes: 'Bring the architecture brief.' },
    }, ctx)

    expect(dataEngine.setCustomFields).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 'catalog:catalog_service',
      recordId: SERVICE_ID,
      tenantId: TENANT,
      organizationId: ORG,
      values: { delivery_notes: 'Bring the architecture brief.' },
    }))
    expect(dataEngine.markOrmEntityChange).toHaveBeenCalledWith(expect.objectContaining({
      indexer: expect.objectContaining({ entityType: 'catalog:catalog_service' }),
    }))
  })

  it('includes the actor organization and tenant in update lookup predicates', async () => {
    const command = loadCommand('catalog.services.update')
    const record = {
      id: SERVICE_ID,
      organizationId: ORG,
      tenantId: TENANT,
      title: 'Original title',
      description: null,
      scope: null,
      defaultPriceAmount: null,
      defaultPriceCurrencyCode: null,
      defaultMediaId: null,
      defaultMediaUrl: null,
      metadata: null,
      isActive: true,
      updatedAt: new Date(),
    }
    const em = buildEm(record)
    const { ctx } = buildCtx(em)

    await command.execute({ id: SERVICE_ID, title: 'Updated title' }, ctx)

    expect(em.findOne).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        id: SERVICE_ID,
        organizationId: ORG,
        tenantId: TENANT,
        deletedAt: null,
      }),
    )
  })

  it('does not materialize a service outside the actor organization', async () => {
    const command = loadCommand('catalog.services.update')
    const em = buildEm(null)
    const { ctx } = buildCtx(em, OTHER_ORG)

    await expect(command.execute({ id: SERVICE_ID, title: 'Blocked update' }, ctx)).rejects.toMatchObject({
      status: 404,
    })
    expect(em.findOne).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        id: SERVICE_ID,
        organizationId: OTHER_ORG,
        tenantId: TENANT,
      }),
    )
  })
})
