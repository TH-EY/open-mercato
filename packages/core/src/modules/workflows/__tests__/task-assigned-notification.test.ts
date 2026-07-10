import { buildNotificationFromType } from '../../notifications/lib/notificationBuilder'
import { resolveNotificationService } from '../../notifications/lib/notificationService'
import { notificationTypes } from '../notifications'
import handle from '../subscribers/task-assigned-notification'

jest.mock('../../notifications/lib/notificationBuilder', () => ({
  buildNotificationFromType: jest.fn((_: unknown, input: unknown) => input),
}))

jest.mock('../../notifications/lib/notificationService', () => ({
  resolveNotificationService: jest.fn(),
}))

const payload = {
  taskId: '00000000-0000-4000-8000-000000000001',
  taskName: 'Initial contact',
  workflowName: 'Deal onboarding',
  assignedUserId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000003',
  organizationId: '00000000-0000-4000-8000-000000000004',
}

describe('workflow task assignment notification', () => {
  const create = jest.fn()
  const userHasAllFeatures = jest.fn()
  const ctx = {
    resolve: jest.fn((name: string) => {
      if (name === 'rbacService') return { userHasAllFeatures }
      return null
    }),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    ;(resolveNotificationService as jest.Mock).mockReturnValue({ create })
  })

  it('uses the real task detail route in both notification contracts', async () => {
    expect(notificationTypes[0]?.linkHref).toBe('/backend/tasks/{sourceEntityId}')
    expect(notificationTypes[0]?.actions?.[0]?.href).toBe('/backend/tasks/{sourceEntityId}')

    userHasAllFeatures.mockResolvedValue(true)
    await handle(payload, ctx)

    expect(buildNotificationFromType).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ linkHref: `/backend/tasks/${payload.taskId}` }),
    )
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('suppresses notification when the assignee cannot open the scoped task', async () => {
    userHasAllFeatures.mockResolvedValue(false)
    await handle(payload, ctx)

    expect(create).not.toHaveBeenCalled()
  })
})
