import type { Edge } from '@xyflow/react'
import { edgeToFormValues, formValuesToEdgeUpdates } from '../edgeFormTransforms'

describe('edge form transforms', () => {
  it('preserves renamed and newly added activities in edge updates', () => {
    const edge = {
      id: 'start_to_end',
      source: 'start',
      target: 'end',
      data: {
        transitionName: 'Start to End',
        trigger: 'auto',
        priority: 100,
        activities: [
          {
            activityId: 'send_email',
            activityName: 'Send email',
            activityType: 'SEND_EMAIL',
            config: { to: 'test@example.com' },
            retryPolicy: {
              maxAttempts: 3,
              initialIntervalMs: 1000,
              backoffCoefficient: 2,
              maxIntervalMs: 10000,
            },
          },
        ],
      },
    } as unknown as Edge

    const values = edgeToFormValues(edge)
    const updates = formValuesToEdgeUpdates({
      ...values,
      activities: [
        {
          ...values.activities[0],
          activityName: 'Renamed email',
        },
        {
          activityId: 'lookup_deal',
          activityName: 'Lookup deal',
          activityType: 'CALL_API',
          config: { endpoint: '/api/customers/deals?id={{context.id}}' },
          retryPolicy: {
            maxAttempts: 2,
            initialIntervalMs: 500,
            backoffCoefficient: 2,
            maxIntervalMs: 5000,
          },
        },
      ],
    }, edge)

    expect((updates as any).activities).toHaveLength(2)
    expect((updates as any).activities[0].activityName).toBe('Renamed email')
    expect((updates as any).activities[1]).toMatchObject({
      activityId: 'lookup_deal',
      activityName: 'Lookup deal',
      activityType: 'CALL_API',
      retryPolicy: {
        maxAttempts: 2,
        initialIntervalMs: 500,
        backoffCoefficient: 2,
        maxIntervalMs: 5000,
      },
    })
  })
})
