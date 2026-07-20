import { readCorrelationScalar } from '../signal-correlation'

describe('signal correlation paths', () => {
  it.each([
    ['activities.create_customer_task.body.id', 'task-123'],
    ['activities.create-task.body.count', '0'],
    ['flags.completed', 'false'],
  ])('resolves and normalizes %s', (path, expected) => {
    const context = {
      activities: {
        create_customer_task: { body: { id: 'task-123' } },
        'create-task': { body: { count: 0 } },
      },
      flags: { completed: false },
    }

    expect(readCorrelationScalar(context, path)).toBe(expected)
  })

  it.each([
    ['missing.path', undefined],
    ['value', null],
    ['value', ''],
    ['value', {}],
    ['value', []],
    ['items.0.id', 'array-indexes-are-not-supported'],
    ['value.__proto__.polluted', 'unsafe'],
  ])('returns null for unsupported or non-scalar input at %s', (path, value) => {
    const source = path === 'missing.path' ? {} : path.startsWith('items')
      ? { items: [{ id: value }] }
      : { value }

    expect(readCorrelationScalar(source, path)).toBeNull()
  })

  it('rejects string keys that cannot fit the persisted routing key', () => {
    expect(readCorrelationScalar({ id: 'x'.repeat(256) }, 'id')).toBeNull()
  })
})
