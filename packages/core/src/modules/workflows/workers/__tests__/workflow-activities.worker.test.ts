import { describe, expect, it, jest, beforeEach } from '@jest/globals'
import handle from '../workflow-activities.worker'
import { logWorkflowEvent } from '../../lib/event-logger'
import { executeSendEmail } from '../../lib/activity-executor'
import { resumeWorkflowAfterActivities } from '../../lib/workflow-executor'

jest.mock('../../lib/event-logger', () => ({
  logWorkflowEvent: jest.fn(),
}))

jest.mock('../../lib/activity-executor', () => ({
  executeSendEmail: jest.fn(),
  executeCallApi: jest.fn(),
  executeEmitEvent: jest.fn(),
  executeUpdateEntity: jest.fn(),
  executeCallWebhook: jest.fn(),
  executeFunction: jest.fn(),
}))

jest.mock('../../lib/workflow-executor', () => ({
  resumeWorkflowAfterActivities: jest.fn(),
}))

describe('workflow activity worker', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('retries resume when a fast async activity completes before the instance is marked waiting', async () => {
    const em = {
      findOne: jest.fn(async () => ({
        id: 'instance-1',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
      })),
    }
    const ctx = {
      jobId: 'job-1',
      attemptNumber: 1,
      resolve: jest.fn((key: string) => (key === 'em' ? em : null)),
    }

    ;(executeSendEmail as jest.MockedFunction<typeof executeSendEmail>).mockResolvedValue({ sent: true })
    ;(logWorkflowEvent as jest.MockedFunction<typeof logWorkflowEvent>).mockResolvedValue(undefined as never)
    ;(resumeWorkflowAfterActivities as jest.MockedFunction<typeof resumeWorkflowAfterActivities>)
      .mockRejectedValueOnce(new Error('Workflow instance not waiting for activities'))
      .mockResolvedValueOnce(undefined)

    await handle({
      id: 'job-1',
      payload: {
        workflowInstanceId: 'instance-1',
        activityId: 'activity-1',
        activityName: 'Send email',
        activityType: 'SEND_EMAIL',
        activityConfig: { to: 'test@example.com', subject: 'Hello' },
        workflowContext: {},
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        retryPolicy: { maxAttempts: 1, initialIntervalMs: 0, backoffCoefficient: 1, maxIntervalMs: 0 },
      },
    } as any, ctx as any)

    expect(resumeWorkflowAfterActivities).toHaveBeenCalledTimes(2)
    expect(resumeWorkflowAfterActivities).toHaveBeenNthCalledWith(
      2,
      em,
      ctx,
      'instance-1',
      undefined,
    )
  })
})
