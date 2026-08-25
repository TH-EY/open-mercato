const enqueue = jest.fn()

jest.mock('../lib/reconciliationQueue', () => ({
  getFinooCustomerRetentionReconciliationQueue: () => ({ enqueue }),
}))

import { interceptors } from '../commands/interceptors'

describe('Finoo retention command interceptors', () => {
  beforeEach(() => enqueue.mockReset())

  it('targets all customer and partner commands without feature-gating', () => {
    expect(interceptors).toHaveLength(2)
    expect(interceptors.map((entry) => entry.targetCommand)).toEqual(['customers.*', '*'])
    expect(interceptors.every((entry) => entry.features === undefined)).toBe(true)
  })

  it('adds a durable occurrence timestamp only for a real completion transition', async () => {
    const customerInterceptor = interceptors[0]
    const em = {
      fork: () => em,
      findOne: jest.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000001',
        tenantId: '00000000-0000-4000-8000-000000000002',
        organizationId: '00000000-0000-4000-8000-000000000003',
        status: 'planned',
        interactionType: 'task',
        entity: { id: '00000000-0000-4000-8000-000000000004' },
      }),
    }
    const result = await customerInterceptor.beforeExecute?.(
      { id: '00000000-0000-4000-8000-000000000001', status: 'done' },
      {
        commandId: 'customers.interactions.update',
        auth: null,
        selectedOrganizationId: null,
        container: { resolve: () => em } as never,
      },
    )
    expect(result?.modifiedInput?.occurredAt).toBeInstanceOf(Date)
    expect(result?.metadata).toMatchObject({ completionTransition: true })
  })

  it('blocks external writes to projection-owned retention mirrors', async () => {
    const customerInterceptor = interceptors[0]
    const context = {
      commandId: 'customers.people.update',
      auth: null,
      selectedOrganizationId: null,
      container: {} as never,
    }
    await expect(customerInterceptor.beforeExecute?.({
      id: '00000000-0000-4000-8000-000000000001',
      customFields: { finoo_retention_status: 'expired' },
    }, context)).resolves.toMatchObject({ ok: false })
    await expect(customerInterceptor.beforeExecute?.({
      id: '00000000-0000-4000-8000-000000000001',
      customFields: { unrelated_field: 'allowed' },
    }, context)).resolves.toEqual({ ok: true })
  })

  it('enqueues the affected person only after a qualifying customer command succeeds', async () => {
    await interceptors[0].afterExecute?.(
      {
        tenantId: '00000000-0000-4000-8000-000000000002',
        organizationId: '00000000-0000-4000-8000-000000000003',
        entityId: '00000000-0000-4000-8000-000000000004',
      },
      { id: 'comment-1' },
      {
        commandId: 'customers.comments.create',
        auth: null,
        selectedOrganizationId: null,
        container: {} as never,
      },
    )
    expect(enqueue).toHaveBeenCalledWith({
      tenantId: '00000000-0000-4000-8000-000000000002',
      organizationId: '00000000-0000-4000-8000-000000000003',
      customerEntityId: '00000000-0000-4000-8000-000000000004',
    })
  })

  it('requests an organization reconciliation after a partner lifecycle command', async () => {
    await interceptors[1].afterExecute?.(
      {
        tenantId: '00000000-0000-4000-8000-000000000002',
        organizationId: '00000000-0000-4000-8000-000000000003',
      },
      {},
      {
        commandId: 'finoo_affiliates.affiliate.activate',
        auth: null,
        selectedOrganizationId: null,
        container: {} as never,
      },
    )
    expect(enqueue).toHaveBeenCalledWith({
      tenantId: '00000000-0000-4000-8000-000000000002',
      organizationId: '00000000-0000-4000-8000-000000000003',
    })
  })

  it('recomputes the snapshotted person after undoing qualifying activity', async () => {
    const beforeUndo = await interceptors[0].beforeUndo?.({
      commandId: 'customers.comments.create',
      logEntry: {
        tenantId: '00000000-0000-4000-8000-000000000002',
        organizationId: '00000000-0000-4000-8000-000000000003',
        snapshotAfter: {
          entityId: '00000000-0000-4000-8000-000000000004',
        },
      },
    } as never)
    await interceptors[0].afterUndo?.({} as never, {
      commandId: 'customers.comments.create',
      auth: null,
      selectedOrganizationId: null,
      container: {} as never,
      metadata: beforeUndo?.metadata,
    })
    expect(enqueue).toHaveBeenCalledWith({
      tenantId: '00000000-0000-4000-8000-000000000002',
      organizationId: '00000000-0000-4000-8000-000000000003',
      customerEntityId: '00000000-0000-4000-8000-000000000004',
    })
  })

  it('enqueues the restored person after delete undo', async () => {
    await interceptors[0].afterUndo?.({ logEntry: { id: '60000000-0000-4000-8000-000000000006' } } as never, {
      commandId: 'customers.people.delete',
      auth: null,
      selectedOrganizationId: null,
      container: {} as never,
      metadata: {
        tenantId: '00000000-0000-4000-8000-000000000002',
        organizationId: '00000000-0000-4000-8000-000000000003',
        customerEntityId: '00000000-0000-4000-8000-000000000004',
      },
    })
    expect(enqueue).toHaveBeenCalledWith({
      tenantId: '00000000-0000-4000-8000-000000000002',
      organizationId: '00000000-0000-4000-8000-000000000003',
      customerEntityId: '00000000-0000-4000-8000-000000000004',
    })
  })

  it('leaves delete-undo recovery to hourly reconciliation when enqueue fails', async () => {
    enqueue.mockRejectedValueOnce(new Error('queue unavailable'))
    await expect(interceptors[0].afterUndo?.({} as never, {
      commandId: 'customers.people.delete',
      auth: null,
      selectedOrganizationId: null,
      container: {} as never,
      metadata: {
        tenantId: '00000000-0000-4000-8000-000000000002',
        organizationId: '00000000-0000-4000-8000-000000000003',
        customerEntityId: '00000000-0000-4000-8000-000000000004',
      },
    })).resolves.toBeUndefined()
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('repairs projection-owned mirrors after undoing an unrelated person update', async () => {
    await interceptors[0].afterUndo?.({} as never, {
      commandId: 'customers.people.update',
      auth: null,
      selectedOrganizationId: null,
      container: {} as never,
      metadata: {
        tenantId: '00000000-0000-4000-8000-000000000002',
        organizationId: '00000000-0000-4000-8000-000000000003',
        customerEntityId: '00000000-0000-4000-8000-000000000004',
      },
    })
    expect(enqueue).toHaveBeenCalledWith({
      tenantId: '00000000-0000-4000-8000-000000000002',
      organizationId: '00000000-0000-4000-8000-000000000003',
      customerEntityId: '00000000-0000-4000-8000-000000000004',
    })
  })
})
