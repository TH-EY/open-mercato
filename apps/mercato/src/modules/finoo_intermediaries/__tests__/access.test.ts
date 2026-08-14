import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { assertAssignmentStillEligible, loadAssignableIntermediary, loadEligibleDeal } from '../lib/access'
import type { FinooIntermediaryAssignment } from '../data/entities'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const dealId = '33333333-3333-4333-8333-333333333333'
const customerUserId = '44444444-4444-4444-8444-444444444444'

function mockEntityManager(findOneResults: unknown[], findResults: unknown[][] = []): EntityManager {
  return {
    findOne: jest.fn(async () => findOneResults.shift() ?? null),
    find: jest.fn(async () => findResults.shift() ?? []),
  } as unknown as EntityManager
}

describe('finoo_intermediaries access invariants', () => {
  it('captures the scoped stage id only for the exact eligible label', async () => {
    const em = mockEntityManager([
      {
        id: dealId,
        pipelineId: '77777777-7777-4777-8777-777777777777',
        pipelineStageId: '55555555-5555-4555-8555-555555555555',
      },
    ], [
      [{ id: '77777777-7777-4777-8777-777777777777', name: 'Web Form Sales Pipeline' }],
      [{
        id: '55555555-5555-4555-8555-555555555555',
        pipelineId: '77777777-7777-4777-8777-777777777777',
        label: 'Sent To Partners',
      }],
    ])

    const result = await loadEligibleDeal(em, { tenantId, organizationId, dealId })

    expect(result.stage.id).toBe('55555555-5555-4555-8555-555555555555')
    expect((em.find as jest.Mock).mock.calls[1]?.[1]).toEqual({
      tenantId,
      organizationId,
      pipelineId: '77777777-7777-4777-8777-777777777777',
    })
  })

  it('rejects an ambiguous eligible stage configuration', async () => {
    const em = mockEntityManager([
      {
        id: dealId,
        pipelineId: '77777777-7777-4777-8777-777777777777',
        pipelineStageId: '55555555-5555-4555-8555-555555555555',
      },
    ], [
      [{ id: '77777777-7777-4777-8777-777777777777', name: 'Web Form Sales Pipeline' }],
      [
        { id: '55555555-5555-4555-8555-555555555555', label: 'Sent To Partners' },
        { id: '66666666-6666-4666-8666-666666666666', label: 'sent to partners' },
      ],
    ])

    await expect(loadEligibleDeal(em, { tenantId, organizationId, dealId }))
      .rejects.toMatchObject<Partial<CrudHttpError>>({ status: 422 })
  })

  it('keeps a captured eligible stage valid after its label changes and locks the Deal for mutation', async () => {
    const eligibleStageId = '55555555-5555-4555-8555-555555555555'
    const em = mockEntityManager([{
      id: dealId,
      pipelineStageId: eligibleStageId,
    }])

    await expect(assertAssignmentStillEligible(em, {
      tenantId,
      organizationId,
      dealId,
      eligibleStageId,
    } as FinooIntermediaryAssignment, { lock: true })).resolves.toBeUndefined()

    expect((em.findOne as jest.Mock).mock.calls[0]?.[2]).toEqual({
      lockMode: LockMode.PESSIMISTIC_WRITE,
    })
    expect(em.find).not.toHaveBeenCalled()
  })

  it('requires an active scoped intermediary role membership', async () => {
    const role = { id: '55555555-5555-4555-8555-555555555555', slug: 'intermediary' }
    const user = { id: customerUserId, isActive: true }
    const em = mockEntityManager([user, { id: '66666666-6666-4666-8666-666666666666' }], [[role]])

    await expect(loadAssignableIntermediary(em, {
      tenantId,
      organizationId,
      customerUserId,
    })).resolves.toEqual({ role, user })
  })

  it('masks a missing intermediary membership as not found', async () => {
    const em = mockEntityManager([
      { id: customerUserId, isActive: true },
      null,
    ], [[{ id: '55555555-5555-4555-8555-555555555555', slug: 'intermediary' }]])

    await expect(loadAssignableIntermediary(em, {
      tenantId,
      organizationId,
      customerUserId,
    })).rejects.toMatchObject<Partial<CrudHttpError>>({ status: 404 })
  })

  it('rejects an ambiguous intermediary role configuration', async () => {
    const em = mockEntityManager([], [[
      { id: '55555555-5555-4555-8555-555555555555', slug: 'intermediary' },
      { id: '66666666-6666-4666-8666-666666666666', slug: 'intermediary' },
    ]])

    await expect(loadAssignableIntermediary(em, {
      tenantId,
      organizationId,
      customerUserId,
    })).rejects.toMatchObject<Partial<CrudHttpError>>({ status: 422 })
  })
})
