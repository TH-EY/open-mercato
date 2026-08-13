/** @jest-environment node */

type DeleteMapInput = (input: {
  raw: { body: unknown; query: Record<string, string> }
}) => unknown

let capturedDeleteMapInput: DeleteMapInput | null = null

jest.mock('@open-mercato/shared/lib/crud/factory', () => ({
  makeCrudRoute: jest.fn((options: {
    actions?: { delete?: { mapInput?: DeleteMapInput } }
  }) => {
    capturedDeleteMapInput = options.actions?.delete?.mapInput ?? null
    return {
      metadata: {},
      GET: jest.fn(),
      POST: jest.fn(),
      PUT: jest.fn(),
      DELETE: jest.fn(),
    }
  }),
}))

describe('Finoo affiliate links route', () => {
  beforeAll(async () => {
    await import('../route')
  })

  it('maps the DELETE identifier from the request body', () => {
    const id = '2cc086c0-e44c-4dd0-9914-696bfa55d871'

    expect(capturedDeleteMapInput?.({
      raw: { body: { id }, query: {} },
    })).toEqual({ id })
  })
})
