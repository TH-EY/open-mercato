import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  cancelWorkflowInstanceIfExists,
  createWorkflowDefinitionFixture,
  deleteWorkflowDefinitionIfExists,
  findInstanceUserTask,
  startWorkflowInstanceFixture,
} from '@open-mercato/core/helpers/integration/workflowsFixtures'
import { putWithLock } from '@open-mercato/core/helpers/integration/optimisticLockUi'

const DEFINITIONS_BASE = '/api/workflows/definitions'

type WorkflowDefinitionRecord = {
  id: string
  workflowId: string
  workflowName: string
  updatedAt: string
  definition: {
    steps: Array<{
      stepId: string
      stepType: string
      userTaskConfig?: Record<string, any>
    }>
    transitions: Array<Record<string, any>>
  }
}

type UserTaskRuntimeRecord = {
  id: string
  status: string
  formSchema?: Record<string, any> | null
  formData?: Record<string, any> | null
}

function buildDefinition(role: string, formKey: string, placeholder: string) {
  return {
    steps: [
      { stepId: 'start', stepName: 'Start', stepType: 'START' },
      {
        stepId: 'initial_contact',
        stepName: 'Initial contact',
        stepType: 'USER_TASK',
        userTaskConfig: {
          assignedToRoles: [role],
          formKey,
          allowedActions: ['complete', 'cancel'],
          formSchema: {
            fields: [
              {
                name: 'conversation_summary',
                type: 'textarea',
                label: 'Conversation summary',
                required: true,
                placeholder,
                defaultValue: 'N/A',
              },
            ],
          },
        },
      },
      { stepId: 'end', stepName: 'End', stepType: 'END' },
    ],
    transitions: [
      {
        transitionId: 'start_to_initial_contact',
        fromStepId: 'start',
        toStepId: 'initial_contact',
        trigger: 'auto',
        priority: 10,
      },
      {
        transitionId: 'initial_contact_to_end',
        fromStepId: 'initial_contact',
        toStepId: 'end',
        trigger: 'manual',
        priority: 20,
      },
    ],
  }
}

async function readDefinition(
  request: APIRequestContext,
  token: string,
  definitionId: string,
): Promise<WorkflowDefinitionRecord> {
  const response = await apiRequest(request, 'GET', `${DEFINITIONS_BASE}/${encodeURIComponent(definitionId)}`, { token })
  const body = await readJsonSafe<{ data?: WorkflowDefinitionRecord; error?: unknown }>(response)
  expect(
    response.status(),
    `GET ${DEFINITIONS_BASE}/${definitionId} failed (${response.status()}): ${JSON.stringify(body)}`,
  ).toBe(200)
  const data = body?.data
  expect(data?.id, 'definition detail should include an id').toBe(definitionId)
  expect(typeof data?.updatedAt, 'definition detail should include updatedAt').toBe('string')
  return data as WorkflowDefinitionRecord
}

function expectUserTaskConfig(record: WorkflowDefinitionRecord, role: string, formKey: string, placeholder: string) {
  const userTask = record.definition.steps.find((step) => step.stepId === 'initial_contact')
  const config = userTask?.userTaskConfig as any
  expect(userTask?.stepType).toBe('USER_TASK')
  expect(config).toMatchObject({
    assignedToRoles: [role],
    formKey,
    allowedActions: ['complete', 'cancel'],
    formSchema: {
      fields: [
        expect.objectContaining({
          name: 'conversation_summary',
          type: 'textarea',
          label: 'Conversation summary',
          required: true,
          placeholder,
          defaultValue: 'N/A',
        }),
      ],
    },
  })
}

test.describe('TC-WF-030: workflow user task form config round-trip', () => {
  test('preserves userTaskConfig assignment, form key, actions, and field metadata on create and update', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    const workflowId = `qa-wf-user-task-config-${stamp}`
    let definitionId: string | null = null
    let instanceId: string | null = null

    try {
      definitionId = await createWorkflowDefinitionFixture(request, token, {
        workflowId,
        workflowName: `QA User Task Config ${stamp}`,
        version: 1,
        enabled: true,
        definition: buildDefinition(
          'Sales Representative',
          'initial_contact_form',
          'Please fill in the details of the conversation',
        ),
      })

      const afterCreate = await readDefinition(request, token, definitionId)
      expectUserTaskConfig(
        afterCreate,
        'Sales Representative',
        'initial_contact_form',
        'Please fill in the details of the conversation',
      )

      const updateResponse = await putWithLock(
        request,
        token,
        `${DEFINITIONS_BASE}/${definitionId}`,
        {
          workflowId,
          workflowName: `QA User Task Config ${stamp} updated`,
          version: 1,
          enabled: true,
          definition: buildDefinition(
            'Account Executive',
            'updated_initial_contact_form',
            'Capture the updated conversation summary',
          ),
        },
        afterCreate.updatedAt,
      )
      const updateBody = await readJsonSafe<{ data?: WorkflowDefinitionRecord; error?: unknown }>(updateResponse)
      expect(
        updateResponse.status(),
        `PUT ${DEFINITIONS_BASE}/${definitionId} failed (${updateResponse.status()}): ${JSON.stringify(updateBody)}`,
      ).toBe(200)

      const afterUpdate = await readDefinition(request, token, definitionId)
      expectUserTaskConfig(
        afterUpdate,
        'Account Executive',
        'updated_initial_contact_form',
        'Capture the updated conversation summary',
      )

      instanceId = await startWorkflowInstanceFixture(request, token, {
        workflowId,
        initialContext: { qaStamp: stamp },
      })

      const pendingTask = await findInstanceUserTask(request, token, instanceId, { statuses: ['PENDING'] })
      expect(pendingTask?.id, 'workflow start should create a pending user task').toBeTruthy()

      const taskId = pendingTask!.id!
      const taskDetailResponse = await apiRequest(
        request,
        'GET',
        `/api/workflows/tasks/${encodeURIComponent(taskId)}`,
        { token },
      )
      const taskDetailBody = await readJsonSafe<{ data?: UserTaskRuntimeRecord; error?: unknown }>(taskDetailResponse)
      expect(
        taskDetailResponse.status(),
        `GET /api/workflows/tasks/${taskId} failed (${taskDetailResponse.status()}): ${JSON.stringify(taskDetailBody)}`,
      ).toBe(200)

      expect(taskDetailBody?.data?.formSchema).toMatchObject({
        type: 'object',
        fields: [
          expect.objectContaining({
            name: 'conversation_summary',
            type: 'textarea',
            label: 'Conversation summary',
            required: true,
            placeholder: 'Capture the updated conversation summary',
            defaultValue: 'N/A',
          }),
        ],
        required: ['conversation_summary'],
        properties: {
          conversation_summary: expect.objectContaining({
            type: 'string',
            title: 'Conversation summary',
            description: 'Capture the updated conversation summary',
            placeholder: 'Capture the updated conversation summary',
            default: 'N/A',
          }),
        },
      })

      const missingRequiredResponse = await apiRequest(
        request,
        'POST',
        `/api/workflows/tasks/${encodeURIComponent(taskId)}/complete`,
        { token, data: { formData: {} } },
      )
      const missingRequiredBody = await readJsonSafe<{ error?: string; code?: string }>(missingRequiredResponse)
      expect(
        missingRequiredResponse.status(),
        `missing required form data should return 400 (got ${missingRequiredResponse.status()}): ${JSON.stringify(missingRequiredBody)}`,
      ).toBe(400)
      expect(missingRequiredBody?.code).toBe('FORM_VALIDATION_FAILED')

      const completeResponse = await apiRequest(
        request,
        'POST',
        `/api/workflows/tasks/${encodeURIComponent(taskId)}/complete`,
        {
          token,
          data: {
            formData: {
              conversation_summary: 'Reached the customer and captured the first-call summary.',
            },
          },
        },
      )
      const completeBody = await readJsonSafe<{ data?: UserTaskRuntimeRecord; error?: unknown }>(completeResponse)
      expect(
        completeResponse.status(),
        `POST /api/workflows/tasks/${taskId}/complete failed (${completeResponse.status()}): ${JSON.stringify(completeBody)}`,
      ).toBe(200)
      expect(completeBody?.data?.status).toBe('COMPLETED')
      expect(completeBody?.data?.formData).toMatchObject({
        conversation_summary: 'Reached the customer and captured the first-call summary.',
      })
    } finally {
      await cancelWorkflowInstanceIfExists(request, token, instanceId)
      await deleteWorkflowDefinitionIfExists(request, token, definitionId)
    }
  })
})
