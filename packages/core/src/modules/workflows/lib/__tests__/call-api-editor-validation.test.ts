import {
  createCallApiActivitiesFormSchema,
  firstCallApiActivityValidationKey,
} from '../call-api-editor-validation'

describe('CALL_API editor validation', () => {
  it('requires picker placeholders to be resolved before save', () => {
    expect(firstCallApiActivityValidationKey([
      {
        activityType: 'CALL_API',
        config: {
          endpoint: '/api/orders/{__om_required_id}?page={__om_required_page}',
          headers: { 'x-region': '{__om_required_region}' },
        },
      },
    ])).toBe('workflows.endpointPicker.requiredParametersMissing')

    expect(firstCallApiActivityValidationKey([
      {
        activityType: 'CALL_API',
        config: {
          endpoint: '/api/orders/{{context.orderId}}?page=1',
          headers: { 'x-region': '{{context.region}}' },
        },
      },
    ])).toBeNull()
  })

  it('does not reject unknown manual endpoints, including braces, or unrelated activities', () => {
    expect(firstCallApiActivityValidationKey([
      { activityType: 'CALL_API', config: { endpoint: '/api/custom/{tenant}', method: 'POST' } },
      { activityType: 'EMIT_EVENT', config: {} },
    ])).toBeNull()
  })

  it('reports CrudForm paths for edge, node, and definition transition activity collections', () => {
    const schema = createCallApiActivitiesFormSchema((key) => key)
    const edgeResult = schema.safeParse({
      activities: [{
        activityType: 'CALL_API',
        config: { endpoint: '/api/orders/{__om_required_id}' },
      }],
    })
    const nodeResult = schema.safeParse({
      stepActivities: [{
        activityType: 'CALL_API',
        config: { endpoint: '/api/orders/{__om_required_id}' },
      }],
    })
    const definitionResult = schema.safeParse({
      transitions: [{
        activities: [{
          activityType: 'CALL_API',
          config: { endpoint: '/api/orders/{__om_required_id}' },
        }],
      }],
    })

    expect(edgeResult.success).toBe(false)
    expect(edgeResult.error?.issues[0]).toMatchObject({
      path: ['activities'],
      message: 'workflows.endpointPicker.requiredParametersMissing',
    })
    expect(nodeResult.success).toBe(false)
    expect(nodeResult.error?.issues[0]).toMatchObject({
      path: ['stepActivities'],
      message: 'workflows.endpointPicker.requiredParametersMissing',
    })
    expect(definitionResult.success).toBe(false)
    expect(definitionResult.error?.issues[0]).toMatchObject({
      path: ['transitions'],
      message: 'workflows.endpointPicker.requiredParametersMissing',
    })
  })
})
