import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bulkAssignmentBindingHash, canonicalBulkAssignmentDealIds } from '../lib/bulkAssignments'
import widget from '../widgets/injection/deal-bulk-assignment/widget'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const tenantId = '33333333-3333-4333-8333-333333333333'
const organizationId = '44444444-4444-4444-8444-444444444444'

describe('bulk intermediary assignment contracts', () => {
  it('canonicalizes selected Deal ids before navigation', async () => {
    const navigate = jest.fn()
    const result = await widget.bulkActions[0].onExecute(
      [{ id: secondId }, { id: firstId }, { id: secondId }],
      { navigate },
    )
    expect(result).toEqual({ ok: false })
    expect(navigate).toHaveBeenCalledWith(
      `/backend/finoo-intermediaries/bulk-assignments?dealIds=${encodeURIComponent(`${firstId},${secondId}`)}`,
    )
  })

  it('binds an operation to the exact sorted selection and target', () => {
    const deal = (id: string) => ({
      id,
      updatedAt: '2026-08-18T10:00:00.000Z',
      assignmentId: null,
      assignmentUpdatedAt: null,
    })
    const base = {
      tenantId,
      organizationId,
      intermediaryCustomerUserId: firstId,
      confirmReassign: false,
    }
    expect(canonicalBulkAssignmentDealIds([secondId, firstId, secondId])).toEqual([firstId, secondId])
    expect(bulkAssignmentBindingHash({ ...base, deals: [deal(secondId), deal(firstId)] }))
      .toBe(bulkAssignmentBindingHash({ ...base, deals: [deal(firstId), deal(secondId)] }))
    expect(bulkAssignmentBindingHash({ ...base, deals: [deal(firstId)] }))
      .not.toBe(bulkAssignmentBindingHash({ ...base, intermediaryCustomerUserId: secondId, deals: [deal(firstId)] }))
  })

  it('rejects more than 100 selected rows before navigation', async () => {
    const navigate = jest.fn()
    const rows = Array.from({ length: 101 }, (_, index) => ({ id: `deal-${index}` }))
    const result = await widget.bulkActions[0].onExecute(rows, { navigate, translate: (_key: string, fallback: string) => fallback })
    expect(result).toMatchObject({ ok: false })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('reads the selected Deal ids in the client because module pages do not receive Next search params', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/modules/finoo_intermediaries/backend/finoo-intermediaries/bulk-assignments/page.tsx'), 'utf8')
    const client = readFileSync(resolve(process.cwd(), 'src/modules/finoo_intermediaries/components/bulk-assignments/bulk-assignment.client.tsx'), 'utf8')

    expect(page).toContain('<BulkAssignmentClient />')
    expect(page).not.toContain('searchParams')
    expect(client).toContain("useSearchParams()")
    expect(client).toContain("searchParams.get('dealIds')")
  })
})
