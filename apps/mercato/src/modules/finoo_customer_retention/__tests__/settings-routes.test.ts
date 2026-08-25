const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'
const updatedAt = '2026-08-24T10:00:00.000Z'

const execute = jest.fn()
const runRouteMutationGuards = jest.fn()
const runAfterSuccess = jest.fn()
const container = {
  resolve: jest.fn((name: string) => {
    if (name === 'commandBus') return { execute }
    throw new Error(`Unexpected registration: ${name}`)
  }),
}
const context = {
  container,
  auth: { sub: userId, tenantId, orgId: organizationId },
  tenantId,
  organizationId,
  organizationScope: { tenantId, organizationId, organizationIds: [organizationId] },
  service: { get: jest.fn() },
}

jest.mock('@open-mercato/shared/lib/crud/route-mutation-guard', () => ({
  runRouteMutationGuards: (...args: unknown[]) => runRouteMutationGuards(...args),
}))

jest.mock('../api/settings/_context', () => ({
  resolveRetentionSettingsContext: jest.fn(async () => context),
}))

import { POST as previewSettings } from '../api/settings/preview/route'
import { PUT as updateSettings } from '../api/settings/route'

function request(path: string, method: string, body: unknown, withVersion = true): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(withVersion
        ? { 'x-om-ext-optimistic-lock-expected-updated-at': updatedAt }
        : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('Finoo retention settings write routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    runAfterSuccess.mockResolvedValue(undefined)
    runRouteMutationGuards.mockResolvedValue({ ok: true, runAfterSuccess })
    execute.mockImplementation(async (commandId: string) => commandId.endsWith('.preview')
      ? {
          result: {
            token: 'preview-token',
            expiresAt: '2026-08-24T10:10:00.000Z',
            updatedAt,
            totalEligible: 10,
            newlyExpired: 2,
            alreadyExpired: 1,
          },
        }
      : {
          result: {
            setting: {
              inactivityWindowDays: 30,
              reconciliationGeneration: 1,
              updatedAt,
            },
            progressJobId: '44444444-4444-4444-8444-444444444444',
          },
        })
  })

  it.each([
    ['preview', () => previewSettings(request(
      '/api/finoo_customer_retention/settings/preview',
      'POST',
      { inactivityWindowDays: 30 },
      false,
    ))],
    ['update', () => updateSettings(request(
      '/api/finoo_customer_retention/settings',
      'PUT',
      { inactivityWindowDays: 30 },
      false,
    ))],
  ])('requires an optimistic-lock version for %s', async (_name, invoke) => {
    const response = await invoke()
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'optimistic_lock_required' })
    expect(runRouteMutationGuards).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    ['preview', previewSettings, '/api/finoo_customer_retention/settings/preview', 'POST'],
    ['update', updateSettings, '/api/finoo_customer_retention/settings', 'PUT'],
  ])('blocks %s when a registry guard rejects it', async (_name, route, path, method) => {
    runRouteMutationGuards.mockResolvedValueOnce({
      ok: false,
      response: Response.json({ error: 'blocked' }, { status: 409 }),
    })
    const response = await route(request(path, method, { inactivityWindowDays: 30 }))
    expect(response.status).toBe(409)
    expect(execute).not.toHaveBeenCalled()
    expect(runAfterSuccess).not.toHaveBeenCalled()
  })

  it.each([
    ['preview', previewSettings, '/api/finoo_customer_retention/settings/preview', 'POST'],
    ['update', updateSettings, '/api/finoo_customer_retention/settings', 'PUT'],
  ])('applies a transformed %s payload and runs the after-success hook', async (
    _name,
    route,
    path,
    method,
  ) => {
    runRouteMutationGuards.mockResolvedValueOnce({
      ok: true,
      modifiedPayload: { inactivityWindowDays: 31 },
      runAfterSuccess,
    })
    const response = await route(request(path, method, { inactivityWindowDays: 30 }))
    expect(response.status).toBe(method === 'PUT' ? 202 : 200)
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/^finoo_customer_retention\.settings\.(preview|update)$/),
      expect.objectContaining({
        input: expect.objectContaining({ inactivityWindowDays: 31 }),
      }),
    )
    expect(runAfterSuccess).toHaveBeenCalledTimes(1)
  })
})
