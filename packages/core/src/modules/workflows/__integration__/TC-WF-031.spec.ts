import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createDealFixture,
  deleteEntityIfExists,
} from '@open-mercato/core/helpers/integration/crmFixtures'
import {
  cancelWorkflowInstanceIfExists,
  createWorkflowDefinitionFixture,
  deleteWorkflowDefinitionIfExists,
  findInstanceUserTask,
  pollWorkflowInstance,
  startWorkflowInstanceFixture,
} from '@open-mercato/core/helpers/integration/workflowsFixtures'

/**
 * TC-WF-031: An ordinary sales user completes a role-queued user task from the deal.
 *
 * This is the primary end-user path: the employee does not visit workflow administration
 * or need to know the workflow instance id. The deal widget exposes the active task and
 * completing it resumes the paused workflow automatically.
 */
test.describe('TC-WF-031: deal user-task widget', () => {
  test('lets an employee claim and complete Initial contact from a deal', async ({ page, request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const timestamp = Date.now()
    const workflowId = `qa-wf-deal-task-${timestamp}`
    const dealTitle = `QA Initial contact deal ${timestamp}`
    let definitionId: string | null = null
    let instanceId: string | null = null
    let dealId: string | null = null

    try {
      dealId = await createDealFixture(request, adminToken, { title: dealTitle })
      definitionId = await createWorkflowDefinitionFixture(request, adminToken, {
        workflowId,
        workflowName: `QA Deal Initial Contact ${timestamp}`,
        description: 'Self-contained end-user deal task integration fixture',
        version: 1,
        enabled: true,
        definition: {
          steps: [
            { stepId: 'start', stepName: 'Start', stepType: 'START' },
            {
              stepId: 'initial-contact',
              stepName: 'Initial contact',
              stepType: 'USER_TASK',
              userTaskConfig: { assignedTo: ['employee'] },
            },
            { stepId: 'quotation', stepName: 'Quotation', stepType: 'END' },
          ],
          transitions: [
            {
              transitionId: 'start-to-initial-contact',
              fromStepId: 'start',
              toStepId: 'initial-contact',
              trigger: 'auto',
            },
            {
              transitionId: 'initial-contact-to-quotation',
              fromStepId: 'initial-contact',
              toStepId: 'quotation',
              trigger: 'auto',
            },
          ],
        },
      })
      instanceId = await startWorkflowInstanceFixture(request, adminToken, {
        workflowId,
        initialContext: { dealId },
        metadata: { entityType: 'customers.deal', entityId: dealId },
      })

      const pendingTask = await findInstanceUserTask(request, adminToken, instanceId, {
        statuses: ['PENDING'],
      })
      expect(pendingTask?.assignedToRoles).toContain('employee')

      await login(page, 'employee')
      await page.goto(`/backend/customers/deals/${encodeURIComponent(dealId)}`)

      await expect(page.getByRole('heading', { name: dealTitle })).toBeVisible()
      await expect(page.getByText(/Initial contact .*oczekuje|Initial contact .*waiting/i)).toBeVisible()
      await expect(page.getByRole('link', { name: /Moje zadania|My tasks/i })).toBeVisible()
      await expect(page.getByText(/Silnik Procesów Biznesowych|Workflow Engine/i)).toHaveCount(0)

      await page.getByRole('button', { name: /Przejmij zadanie|Claim task/i }).click()
      await expect(page.getByRole('button', { name: /Zakończ Initial contact|Complete Initial contact/i })).toBeVisible()

      await page.getByRole('button', { name: /Zakończ Initial contact|Complete Initial contact/i }).click()
      await expect(page.getByText(/Initial contact .*oczekuje|Initial contact .*waiting/i)).toHaveCount(0)

      const completedInstance = await pollWorkflowInstance(
        request,
        adminToken,
        instanceId,
        (instance) => instance.status === 'COMPLETED',
      )
      expect(completedInstance?.currentStepId).toBe('quotation')
      expect(completedInstance?.status).toBe('COMPLETED')
      instanceId = null
    } finally {
      await cancelWorkflowInstanceIfExists(request, adminToken, instanceId)
      await deleteWorkflowDefinitionIfExists(request, adminToken, definitionId)
      await deleteEntityIfExists(request, adminToken, '/api/customers/deals', dealId)
    }
  })
})
