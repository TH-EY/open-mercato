import { graphToDefinition } from '../graph-utils'

describe('graphToDefinition activity serialization', () => {
  it('keeps activity names and complete retry policies from transition edge data', () => {
    const definition = graphToDefinition(
      [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } },
        { id: 'end', type: 'end', position: { x: 0, y: 0 }, data: { label: 'End' } },
      ] as any,
      [
        {
          id: 'start_to_end',
          source: 'start',
          target: 'end',
          data: {
            trigger: 'auto',
            activities: [
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
          },
        },
      ] as any,
    )

    expect(definition.transitions[0].activities?.[0]).toMatchObject({
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
