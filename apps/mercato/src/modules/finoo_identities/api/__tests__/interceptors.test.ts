import { interceptors } from '../interceptors'

const identityFilter = interceptors.find((entry) => entry.id === 'finoo_identities.people.completeness-filter')

function buildContext(execute: jest.Mock) {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    tenantId: '00000000-0000-4000-8000-000000000003',
    em: { getConnection: () => ({ execute }) },
    container: {},
  }
}

describe('FINOO identity API interceptors', () => {
  it('rejects a completeness filter that matches more than the CRUD ids limit', async () => {
    const execute = jest.fn().mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => ({ person_id: `person-${index}` })),
    )

    const result = await identityFilter?.before?.(
      {
        method: 'GET',
        url: '/api/customers/people?finooIdentityComplete=true',
        query: { finooIdentityComplete: 'true' },
        headers: {},
      },
      buildContext(execute) as never,
    )

    expect(result).toEqual({
      ok: false,
      statusCode: 422,
      message: 'identity_filter_too_broad',
    })
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('coalesce(identity.is_complete, false) = ?'),
      [
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000002',
        true,
        201,
      ],
    )
  })

  it('includes a Person without an identity row in the incomplete result', async () => {
    const execute = jest.fn().mockResolvedValue([
      { person_id: 'person-without-identity' },
      { person_id: 'person-with-incomplete-identity' },
    ])

    const result = await identityFilter?.before?.(
      {
        method: 'GET', url: '/api/customers/people?finooIdentityComplete=false',
        query: { finooIdentityComplete: 'false' }, headers: {},
      },
      buildContext(execute) as never,
    )

    expect(result).toEqual({
      ok: true,
      query: {
        finooIdentityComplete: undefined,
        ids: 'person-without-identity,person-with-incomplete-identity',
      },
    })
    expect(execute.mock.calls[0][0]).toContain('left join finoo_person_identities')
    expect(execute.mock.calls[0][1]).toContain(false)
  })

  it('restricts the completeness query to an existing ids filter', async () => {
    const personA = '10000000-0000-4000-8000-000000000001'
    const personB = '10000000-0000-4000-8000-000000000002'
    const execute = jest.fn().mockResolvedValue([{ person_id: personA }])

    const result = await identityFilter?.before?.(
      {
        method: 'GET', url: `/api/customers/people?finooIdentityComplete=false&ids=${personA},${personB}`,
        query: { finooIdentityComplete: 'false', ids: `${personA},${personB}` },
        headers: {},
      },
      buildContext(execute) as never,
    )

    expect(result).toEqual({
      ok: true,
      query: {
        finooIdentityComplete: undefined,
        ids: personA,
      },
    })
    expect(execute.mock.calls[0][0]).toContain('person.id in (?, ?)')
    expect(execute.mock.calls[0][1]).toEqual([
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      false,
      personA,
      personB,
      201,
    ])
  })

  it('returns exactly 200 matching people without rejecting the filter', async () => {
    const execute = jest.fn().mockResolvedValue(
      Array.from({ length: 200 }, (_, index) => ({ person_id: `person-${index}` })),
    )
    const result = await identityFilter?.before?.(
      {
        method: 'GET', url: '/api/customers/people?finooIdentityComplete=false',
        query: { finooIdentityComplete: 'false' }, headers: {},
      },
      buildContext(execute) as never,
    )
    expect(result).toMatchObject({ ok: true })
    if (!result || !result.ok) throw new Error('Expected a successful filter')
    expect(result.query?.ids?.split(',')).toHaveLength(200)
  })

  it('ignores unsupported filter values without querying identity data', async () => {
    const execute = jest.fn()

    const result = await identityFilter?.before?.(
      {
        method: 'GET',
        url: '/api/customers/people?finooIdentityComplete=unknown',
        query: { finooIdentityComplete: 'unknown' },
        headers: {},
      },
      buildContext(execute) as never,
    )

    expect(result).toEqual({ ok: true })
    expect(execute).not.toHaveBeenCalled()
  })

  it('fails closed without SQL when an explicit ids filter contains no valid UUID', async () => {
    const execute = jest.fn()

    const result = await identityFilter?.before?.(
      {
        method: 'GET', url: '/api/customers/people?finooIdentityComplete=false&ids=not-a-uuid',
        query: { finooIdentityComplete: 'false', ids: 'not-a-uuid' }, headers: {},
      },
      buildContext(execute) as never,
    )

    expect(result).toEqual({
      ok: true,
      query: {
        finooIdentityComplete: undefined,
        ids: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      },
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('uses a valid impossible id when no Person matches instead of widening to all people', async () => {
    const execute = jest.fn().mockResolvedValue([])

    const result = await identityFilter?.before?.(
      {
        method: 'GET',
        url: '/api/customers/people?finooIdentityComplete=true',
        query: { finooIdentityComplete: 'true' },
        headers: {},
      },
      buildContext(execute) as never,
    )

    expect(result).toEqual({
      ok: true,
      query: {
        finooIdentityComplete: undefined,
        ids: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      },
    })
  })
})
