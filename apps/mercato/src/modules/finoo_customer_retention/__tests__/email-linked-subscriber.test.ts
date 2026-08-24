const enqueue = jest.fn()

jest.mock('../lib/reconciliationQueue', () => ({
  getFinooCustomerRetentionReconciliationQueue: () => ({ enqueue }),
}))
jest.mock('@open-mercato/shared/lib/logger', () => ({
  createLogger: () => ({ child: () => ({ error: jest.fn() }) }),
}))

import handle, { metadata } from '../subscribers/email-linked'

describe('Finoo customer retention email-linked subscriber', () => {
  beforeEach(() => enqueue.mockReset())

  it('enqueues a scoped person refresh for a linked email', async () => {
    enqueue.mockResolvedValue(undefined)
    await handle({
      personId: 'person-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })
    expect(metadata.event).toBe('customers.email.linked')
    expect(enqueue).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      customerEntityId: 'person-1',
    })
  })

  it('keeps the source activity successful when the queue is unavailable', async () => {
    enqueue.mockRejectedValue(new Error('queue unavailable'))
    await expect(handle({
      personId: 'person-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })).resolves.toBeUndefined()
  })
})
