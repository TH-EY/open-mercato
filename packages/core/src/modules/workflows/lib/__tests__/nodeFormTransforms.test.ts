import { formValuesToNodeUpdates, nodeToFormValues } from '../nodeFormTransforms'

describe('nodeFormTransforms', () => {
  it('keeps user task form config when advanced config contains stale empty userTaskConfig', () => {
    const updates = formValuesToNodeUpdates(
      {
        stepName: 'Initial contact',
        assignedToRoles: 'Sales Representative',
        formKey: 'initial_contact_form',
        formFields: [
          {
            name: 'conversation_summary',
            type: 'textarea',
            label: 'Conversation summary',
            required: true,
            placeholder: 'Please fill in the details of the conversation',
          },
        ],
        advancedConfig: {
          userTaskConfig: {},
        },
      },
      {
        id: 'usertask_initial_contact',
        type: 'userTask',
        data: {
          userTaskConfig: {},
        },
      } as any,
    )

    expect(updates).toMatchObject({
      assignedToRoles: ['Sales Representative'],
      formKey: 'initial_contact_form',
      userTaskConfig: {
        assignedToRoles: ['Sales Representative'],
        formSchema: {
          fields: [
            {
              name: 'conversation_summary',
              type: 'textarea',
              label: 'Conversation summary',
              required: true,
              placeholder: 'Please fill in the details of the conversation',
            },
          ],
        },
      },
    })
  })

  it('round-trips correlated signal paths', () => {
    const node = {
      id: 'wait_for_task',
      type: 'waitForSignal',
      data: {
        stepName: 'Wait for task',
        signalConfig: {
          signalName: 'customers.interaction.completed',
          timeout: 'PT5M',
          correlation: {
            contextPath: 'activities.create_customer_task.body.id',
            payloadPath: 'id',
          },
        },
      },
    } as any

    const values = nodeToFormValues(node)
    expect(values.signalCorrelationContextPath).toBe('activities.create_customer_task.body.id')
    expect(values.signalCorrelationPayloadPath).toBe('id')

    expect(formValuesToNodeUpdates(values, node)).toMatchObject({
      signalConfig: {
        signalName: 'customers.interaction.completed',
        timeout: 'PT5M',
        correlation: {
          contextPath: 'activities.create_customer_task.body.id',
          payloadPath: 'id',
        },
      },
    })
  })

  it('removes correlation when both paths are cleared and rejects partial input', () => {
    const node = {
      id: 'wait_for_task',
      type: 'waitForSignal',
      data: {},
    } as any

    expect(formValuesToNodeUpdates({
      stepName: 'Wait for task',
      signalName: 'customers.interaction.completed',
      signalCorrelationContextPath: '',
      signalCorrelationPayloadPath: '',
    }, node)).toEqual(expect.objectContaining({
      signalConfig: {
        signalName: 'customers.interaction.completed',
      },
    }))

    expect(() => formValuesToNodeUpdates({
      stepName: 'Wait for task',
      signalName: 'customers.interaction.completed',
      signalCorrelationContextPath: 'activities.create_customer_task.body.id',
      signalCorrelationPayloadPath: '',
    }, node)).toThrow(/both correlation paths/i)
  })
})
