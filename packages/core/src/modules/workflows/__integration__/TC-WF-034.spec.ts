import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  createSalesQuoteFixture,
  deleteSalesEntityIfExists,
} from '@open-mercato/core/helpers/integration/salesFixtures'
import {
  cancelWorkflowInstanceIfExists,
  createWorkflowDefinitionFixture,
  deleteWorkflowDefinitionIfExists,
  pollWorkflowInstance,
  startWorkflowInstanceFixture,
} from '@open-mercato/core/helpers/integration/workflowsFixtures'

export const integrationMeta = {
  dependsOnModules: ['workflows', 'sales'],
}

test.describe('TC-WF-034: correlated Quote status wait', () => {
  test('resumes only when the correlated Quote reaches the configured status', async ({ request }) => {
    test.slow()

    const token = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    const workflowId = `qa-wf-quote-status-${stamp}`
    let quoteId: string | null = null
    let definitionId: string | null = null
    let instanceId: string | null = null

    try {
      const catalogResponse = await apiRequest(
        request,
        'GET',
        '/api/events?excludeTriggerExcluded=true',
        { token },
      )
      const catalogBody = await readJsonSafe<{ data?: Array<{ id?: string }> }>(catalogResponse)
      expect(catalogResponse.status()).toBe(200)
      expect(catalogBody?.data?.some((event) => event.id === 'sales.quote.status_changed')).toBe(true)

      quoteId = await createSalesQuoteFixture(request, token)
      const prepareQuote = await apiRequest(request, 'PUT', '/api/sales/quotes', {
        token,
        data: {
          id: quoteId,
          metadata: { customerEmail: `qa-quote-status-${stamp}@example.test` },
        },
      })
      expect(prepareQuote.status()).toBe(200)

      definitionId = await createWorkflowDefinitionFixture(request, token, {
        workflowId,
        workflowName: `QA Quote Status Wait ${stamp}`,
        version: 1,
        enabled: true,
        definition: {
          steps: [
            { stepId: 'start', stepName: 'Start', stepType: 'START' },
            {
              stepId: 'wait_for_quote_status',
              stepName: 'Wait for Quote status',
              stepType: 'WAIT_FOR_SIGNAL',
              signalConfig: {
                signalName: 'sales.quote.status_changed',
                correlation: {
                  contextPath: 'quoteId',
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
              toStepId: 'wait_for_quote_status',
              trigger: 'auto',
            },
            {
              transitionId: 'wait-to-end',
              fromStepId: 'wait_for_quote_status',
              toStepId: 'end',
              trigger: 'auto',
              condition: {
                field: 'signals.wait_for_quote_status.payload.status',
                operator: '=',
                value: 'draft',
              },
            },
          ],
        },
      })

      instanceId = await startWorkflowInstanceFixture(request, token, {
        workflowId,
        initialContext: { quoteId },
      })
      const paused = await pollWorkflowInstance(
        request,
        token,
        instanceId,
        (instance) => instance.status === 'PAUSED' && instance.currentStepId === 'wait_for_quote_status',
        { timeoutMs: 30_000 },
      )
      expect(paused?.status).toBe('PAUSED')

      const send = await apiRequest(request, 'POST', '/api/sales/quotes/send', {
        token,
        data: { quoteId, validForDays: 14 },
      })
      expect(send.status(), `quote send failed: ${JSON.stringify(await readJsonSafe(send))}`).toBe(200)
      const afterSent = await pollWorkflowInstance(
        request,
        token,
        instanceId,
        (instance) => instance.status !== 'PAUSED',
        { timeoutMs: 2_000 },
      )
      expect(afterSent?.status, 'the correlated but non-target sent status must not resume the workflow').toBe('PAUSED')
      expect(afterSent?.currentStepId).toBe('wait_for_quote_status')

      const restoreDraft = await apiRequest(request, 'PUT', '/api/sales/quotes', {
        token,
        data: { id: quoteId, comment: `Return to draft ${stamp}` },
      })
      expect(restoreDraft.status()).toBe(200)
      const completed = await pollWorkflowInstance(
        request,
        token,
        instanceId,
        (instance) => instance.status === 'COMPLETED',
        { timeoutMs: 30_000 },
      )
      expect(completed?.status, 'the target draft status should resume the correlated workflow').toBe('COMPLETED')
      expect(completed?.context).toMatchObject({
        signals: {
          wait_for_quote_status: {
            name: 'sales.quote.status_changed',
            payload: {
              id: quoteId,
              previousStatus: 'sent',
              status: 'draft',
            },
          },
        },
      })
      instanceId = null
    } finally {
      await cancelWorkflowInstanceIfExists(request, token, instanceId)
      await deleteWorkflowDefinitionIfExists(request, token, definitionId)
      await deleteSalesEntityIfExists(request, token, '/api/sales/quotes', quoteId)
    }
  })
})
