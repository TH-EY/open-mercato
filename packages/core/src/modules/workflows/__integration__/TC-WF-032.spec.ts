import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  cancelWorkflowInstanceIfExists,
  createWorkflowDefinitionFixture,
  deleteWorkflowDefinitionIfExists,
  pollWorkflowInstance,
  startWorkflowInstanceFixture,
} from '@open-mercato/core/helpers/integration/workflowsFixtures'

export const integrationMeta = {
  dependsOnModules: ['workflows', 'customers'],
}

type ActivityOutput = {
  body?: { id?: string }
}

test.describe('TC-WF-032: correlated customer-task wait', () => {
  test('only completion of the task created by the workflow resumes its exact wait', async ({ request }) => {
    test.slow()

    const token = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    const workflowId = `qa-wf-correlated-customer-task-${stamp}`
    let companyId: string | null = null
    let definitionId: string | null = null
    let instanceId: string | null = null
    let workflowTaskId: string | null = null
    let controlTaskId: string | null = null

    try {
      companyId = await createCompanyFixture(request, token, `QA Correlated Wait ${stamp}`)
      definitionId = await createWorkflowDefinitionFixture(request, token, {
        workflowId,
        workflowName: `QA Correlated Customer Task ${stamp}`,
        version: 1,
        enabled: true,
        definition: {
          steps: [
            { stepId: 'start', stepName: 'Start', stepType: 'START' },
            {
              stepId: 'wait_for_customer_task',
              stepName: 'Wait for customer task',
              stepType: 'WAIT_FOR_SIGNAL',
              signalConfig: {
                signalName: 'customers.interaction.completed',
                correlation: {
                  contextPath: 'activities.create_customer_task.body.id',
                  payloadPath: 'id',
                },
              },
            },
            { stepId: 'end', stepName: 'End', stepType: 'END' },
          ],
          transitions: [
            {
              transitionId: 'start-to-wait',
              fromStepId: 'start',
              toStepId: 'wait_for_customer_task',
              trigger: 'auto',
              activities: [
                {
                  activityId: 'create_customer_task',
                  activityName: 'Create customer task',
                  activityType: 'CALL_API',
                  config: {
                    endpoint: '/api/customers/interactions',
                    method: 'POST',
                    body: {
                      entityId: '{{context.companyId}}',
                      interactionType: 'task',
                      title: `QA Workflow Task ${stamp}`,
                      status: 'planned',
                    },
                  },
                },
              ],
            },
            {
              transitionId: 'wait-to-end',
              fromStepId: 'wait_for_customer_task',
              toStepId: 'end',
              trigger: 'auto',
            },
          ],
        },
      })

      instanceId = await startWorkflowInstanceFixture(request, token, {
        workflowId,
        initialContext: { companyId },
      })
      const paused = await pollWorkflowInstance(
        request,
        token,
        instanceId,
        (instance) => instance.status === 'PAUSED' && instance.currentStepId === 'wait_for_customer_task',
        { timeoutMs: 30_000 },
      )
      expect(paused?.status, 'workflow should reach its correlated signal wait').toBe('PAUSED')
      const activityOutput = (paused?.context?.activities as Record<string, ActivityOutput> | undefined)
        ?.create_customer_task
      workflowTaskId = activityOutput?.body?.id ?? null
      expect(workflowTaskId, 'CALL_API output should be available under activities.create_customer_task').toBeTruthy()

      const controlCreate = await apiRequest(request, 'POST', '/api/customers/interactions', {
        token,
        data: {
          entityId: companyId,
          interactionType: 'task',
          title: `QA Control Task ${stamp}`,
          status: 'planned',
        },
      })
      const controlBody = await readJsonSafe<{ id?: string }>(controlCreate)
      expect(controlCreate.status(), `control task create failed: ${JSON.stringify(controlBody)}`).toBe(201)
      controlTaskId = controlBody?.id ?? null
      expect(controlTaskId).toBeTruthy()

      const controlComplete = await apiRequest(request, 'POST', '/api/customers/interactions/complete', {
        token,
        data: { id: controlTaskId },
      })
      expect(controlComplete.status()).toBe(200)
      const afterControl = await pollWorkflowInstance(
        request,
        token,
        instanceId,
        (instance) => instance.status !== 'PAUSED',
        { timeoutMs: 2_000 },
      )
      expect(afterControl?.status, 'unrelated customer task must not resume the workflow').toBe('PAUSED')
      expect(afterControl?.currentStepId).toBe('wait_for_customer_task')

      const matchingComplete = await apiRequest(request, 'POST', '/api/customers/interactions/complete', {
        token,
        data: { id: workflowTaskId },
      })
      expect(matchingComplete.status()).toBe(200)
      const completed = await pollWorkflowInstance(
        request,
        token,
        instanceId,
        (instance) => instance.status === 'COMPLETED',
        { timeoutMs: 30_000 },
      )
      expect(completed?.status, 'matching completion event should resume the exact wait').toBe('COMPLETED')

      const retry = await apiRequest(request, 'POST', '/api/customers/interactions/complete', {
        token,
        data: { id: workflowTaskId },
      })
      expect([200, 400, 409], 'a duplicate completion may be accepted or rejected by the domain command').toContain(retry.status())

      const eventsResponse = await apiRequest(
        request,
        'GET',
        `/api/workflows/instances/${encodeURIComponent(instanceId)}/events?eventType=SIGNAL_RECEIVED`,
        { token },
      )
      const eventsBody = await readJsonSafe<{ data?: Array<{ eventType?: string }> }>(eventsResponse)
      expect(eventsResponse.status()).toBe(200)
      expect(eventsBody?.data ?? [], 'the wait should be consumed exactly once').toHaveLength(1)
      instanceId = null
    } finally {
      await cancelWorkflowInstanceIfExists(request, token, instanceId)
      await deleteEntityIfExists(request, token, '/api/customers/interactions', workflowTaskId)
      await deleteEntityIfExists(request, token, '/api/customers/interactions', controlTaskId)
      await deleteWorkflowDefinitionIfExists(request, token, definitionId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})
