import { DefaultDataEngine } from '../engine'

describe('DefaultDataEngine strict custom-field writes', () => {
  it('rejects a value whose scoped definition is inactive or missing when strict mode is requested', async () => {
    const em = {
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => null),
    }
    const engine = new DefaultDataEngine(em as never, {} as never)

    await expect(engine.setCustomFields({
      entityId: 'customers:customer_person_profile',
      recordId: 'profile-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      values: { retired_identity_field: 'PLAINTEXT_CANARY' },
      rejectUndeclaredKeys: true,
    })).rejects.toMatchObject({
      status: 400,
      body: {
        error: 'Validation failed',
        fields: { cf_retired_identity_field: expect.any(String) },
      },
    })
  })
})
