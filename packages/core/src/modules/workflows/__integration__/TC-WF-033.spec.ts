import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  createWorkflowDefinitionFixture,
  deleteWorkflowDefinitionIfExists,
} from '@open-mercato/core/helpers/integration/workflowsFixtures'
import { putWithLock } from '@open-mercato/core/helpers/integration/optimisticLockUi'

export const integrationMeta = {
  dependsOnModules: ['workflows'],
}

type DefinitionRecord = {
  id: string
  updatedAt: string
  definition: {
    steps: Array<{
      stepId: string
      signalConfig?: {
        signalName?: string
        correlation?: { contextPath?: string; payloadPath?: string }
      }
    }>
  }
}

function definitionFor(contextPath: string, payloadPath: string) {
  return {
    steps: [
      { stepId: 'start', stepName: 'Start', stepType: 'START' },
      {
        stepId: 'wait',
        stepName: 'Wait',
        stepType: 'WAIT_FOR_SIGNAL',
        signalConfig: {
          signalName: 'customers.interaction.completed',
          correlation: { contextPath, payloadPath },
        },
      },
      { stepId: 'end', stepName: 'End', stepType: 'END' },
    ],
    transitions: [
      { transitionId: 'start-to-wait', fromStepId: 'start', toStepId: 'wait', trigger: 'auto' },
      { transitionId: 'wait-to-end', fromStepId: 'wait', toStepId: 'end', trigger: 'auto' },
    ],
  }
}

async function readDefinition(request: APIRequestContext, token: string, definitionId: string) {
  const response = await apiRequest(
    request,
    'GET',
    `/api/workflows/definitions/${encodeURIComponent(definitionId)}`,
    { token },
  )
  const body = await readJsonSafe<{ data?: DefinitionRecord }>(response)
  expect(response.status(), `definition read failed: ${JSON.stringify(body)}`).toBe(200)
  return body?.data as DefinitionRecord
}

function expectCorrelation(record: DefinitionRecord, contextPath: string, payloadPath: string) {
  const wait = record.definition.steps.find((step) => step.stepId === 'wait')
  expect(wait?.signalConfig).toEqual({
    signalName: 'customers.interaction.completed',
    correlation: { contextPath, payloadPath },
  })
}

test.describe('TC-WF-033: signal correlation definition round-trip', () => {
  test('preserves both correlation paths on create and update', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    const workflowId = `qa-wf-correlation-roundtrip-${stamp}`
    let definitionId: string | null = null

    try {
      definitionId = await createWorkflowDefinitionFixture(request, token, {
        workflowId,
        workflowName: `QA Correlation Round-trip ${stamp}`,
        version: 1,
        enabled: true,
        definition: definitionFor('activities.create_customer_task.body.id', 'id'),
      })
      const created = await readDefinition(request, token, definitionId)
      expectCorrelation(created, 'activities.create_customer_task.body.id', 'id')

      const update = await putWithLock(
        request,
        token,
        `/api/workflows/definitions/${encodeURIComponent(definitionId)}`,
        {
          workflowId,
          workflowName: `QA Correlation Round-trip ${stamp} updated`,
          version: 1,
          enabled: true,
          definition: definitionFor('activities.create_follow_up.body.id', 'interaction.id'),
        },
        created.updatedAt,
      )
      expect(update.status()).toBe(200)

      const updated = await readDefinition(request, token, definitionId)
      expectCorrelation(updated, 'activities.create_follow_up.body.id', 'interaction.id')
    } finally {
      await deleteWorkflowDefinitionIfExists(request, token, definitionId)
    }
  })
})
