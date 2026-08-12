import { expect, test, type APIRequestContext } from '@playwright/test'
import { Client } from 'pg'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { expectOperation, undoOk } from '@open-mercato/core/helpers/integration/undoHarness'
import {
  createCustomerRoleFixture,
  createCustomerUserFixture,
  deleteCustomerRoleFixture,
  deleteCustomerUserFixture,
  portalCookieHeaders,
  portalLogin,
} from '@open-mercato/core/helpers/integration/customerAccountsFixtures'
import {
  createCompanyFixture,
  createDealFixture,
  createPipelineFixture,
  createPipelineStageFixture,
  deleteEntityByBody,
  deleteEntityIfExists,
} from '@open-mercato/core/helpers/integration/crmFixtures'

const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at'
const DEAL_ENTITY_ID = 'customers:customer_deal'

function resolveUrl(path: string): string {
  const baseUrl = process.env.BASE_URL?.trim()
  return baseUrl ? `${baseUrl}${path}` : path
}

function findString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key] as string
  }
  for (const nested of Object.values(record)) {
    const found = findString(nested, keys)
    if (found) return found
  }
  return null
}

async function ensureAffiliateRole(request: APIRequestContext, token: string) {
  const response = await apiRequest(request, 'GET', '/api/customer_accounts/admin/roles?page=1&pageSize=100', { token })
  const payload = await readJsonSafe<{
    roles?: Array<{ id: string; slug: string }>
    items?: Array<{ id: string; slug: string }>
  }>(response)
  const existing = (payload?.roles ?? payload?.items ?? []).find((role) => role.slug === 'affiliate')
  if (existing) {
    return { id: existing.id, created: false }
  }
  const created = await createCustomerRoleFixture(request, token, {
    name: 'Affiliate',
    slug: 'affiliate',
    features: ['portal.finoo_affiliates.view'],
  })
  return { id: created.id, created: true }
}

async function readDealUpdatedAt(request: APIRequestContext, token: string, dealId: string): Promise<string> {
  const response = await apiRequest(request, 'GET', `/api/customers/deals?id=${encodeURIComponent(dealId)}`, { token })
  const payload = await readJsonSafe<{ items?: Array<Record<string, unknown>> }>(response)
  const value = payload?.items?.[0]?.updated_at ?? payload?.items?.[0]?.updatedAt
  expect(typeof value).toBe('string')
  return String(value)
}

async function readPersistedDealTimeline(dealId: string): Promise<{
  createdAt: string
  capturedCompletedAt: string | null
  completedAt: string | null
}> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required for Finoo persistence assertions')
  const client = new Client({ connectionString })
  await client.connect()
  try {
    const result = await client.query(
      `select d.created_at,
              min(t.transitioned_at) filter (where lower(btrim(t.stage_label)) = 'completed') as completed_at,
              c.completed_at as captured_completed_at
       from customer_deals d
       left join customer_deal_stage_transitions t
         on t.deal_id = d.id and t.deleted_at is null
       left join finoo_deal_completions c
         on c.deal_id = d.id
        and c.tenant_id = d.tenant_id
        and c.organization_id = d.organization_id
       where d.id = $1
       group by d.created_at, c.completed_at`,
      [dealId],
    ) as { rows: Array<{
      created_at: Date
      completed_at: Date | null
      captured_completed_at: Date | null
    }> }
    const row = result.rows[0]
    expect(row).toBeTruthy()
    return {
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
      capturedCompletedAt: row.captured_completed_at?.toISOString() ?? null,
    }
  } finally {
    await client.end()
  }
}

async function waitForCount(
  read: () => Promise<number>,
  expected: number,
): Promise<void> {
  await expect.poll(read, { timeout: 10_000, intervals: [200, 400, 800] }).toBe(expected)
}

async function createTextDealDefinition(request: APIRequestContext, token: string, key: string): Promise<void> {
  const response = await apiRequest(request, 'POST', '/api/entities/definitions', {
    token,
    data: {
      entityId: DEAL_ENTITY_ID,
      key,
      kind: 'text',
      configJson: { label: key, validation: [] },
    },
  })
  expect(response.status()).toBe(200)
}

async function deleteDealDefinition(request: APIRequestContext, token: string, key: string): Promise<void> {
  const response = await apiRequest(request, 'DELETE', '/api/entities/definitions', {
    token,
    data: { entityId: DEAL_ENTITY_ID, key },
  })
  expect([200, 404]).toContain(response.status())
}

test.describe('TC-FINOO-AFF-001..008: Finoo affiliate portal', () => {
  test('tracks one human visit, scopes portal data, records the first Completed transition, and enforces commission locking', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const { tenantId } = getTokenContext(token)
    const role = await ensureAffiliateRole(request, token)
    let affiliateUserId: string | null = null
    let otherAffiliateUserId: string | null = null
    let companyId: string | null = null
    let pipelineId: string | null = null
    let openStageId: string | null = null
    let completedStageId: string | null = null
    let dealId: string | null = null
    let completedBeforeAttributionDealId: string | null = null
    let linkId: string | null = null

    try {
      const affiliate = await createCustomerUserFixture(request, token, { roleIds: [role.id] })
      affiliateUserId = affiliate.id
      const otherAffiliate = await createCustomerUserFixture(request, token, { roleIds: [role.id] })
      otherAffiliateUserId = otherAffiliate.id
      companyId = await createCompanyFixture(request, token, `Finoo integration ${Date.now()}`)
      pipelineId = await createPipelineFixture(request, token, { name: `Finoo pipeline ${Date.now()}` })
      openStageId = await createPipelineStageFixture(request, token, { pipelineId, label: 'Open', order: 0 })
      completedStageId = await createPipelineStageFixture(request, token, { pipelineId, label: 'Completed', order: 1 })
      dealId = await createDealFixture(request, token, {
        title: `Finoo affiliate Deal ${Date.now()}`,
        companyIds: [companyId],
        pipelineId,
        pipelineStageId: openStageId,
      })

      const editorResponse = await apiRequest(
        request,
        'GET',
        `/api/finoo_affiliates/deal-attributions?dealId=${encodeURIComponent(dealId)}`,
        { token },
      )
      expect(editorResponse.status()).toBe(200)
      const editor = await readJsonSafe<{
        statuses?: Array<{ id: string; value: string }>
        attribution?: { updatedAt: string } | null
      }>(editorResponse)
      const waitingStatusId = editor?.statuses?.find((status) => status.value === 'waiting')?.id
      expect(waitingStatusId).toBeTruthy()

      const createAttribution = await apiRequest(request, 'PUT', '/api/finoo_affiliates/deal-attributions', {
        token,
        data: {
          dealId,
          affiliateUserId,
          commissionStatusEntryId: waitingStatusId,
          commissionAmount: 125,
        },
      })
      expect(createAttribution.status()).toBe(200)
      const createAttributionOperation = expectOperation(createAttribution, 'create Finoo Deal attribution')
      await undoOk(request, token, createAttributionOperation.undoToken, 'create Finoo Deal attribution')

      const dealVersionAfterAttributionUndo = await readDealUpdatedAt(request, token, dealId)
      const updateAfterAttributionUndo = await request.put(resolveUrl('/api/customers/deals'), {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          [LOCK_HEADER]: dealVersionAfterAttributionUndo,
        },
        data: { id: dealId, title: `Finoo affiliate Deal after undo ${Date.now()}` },
      })
      expect(updateAfterAttributionUndo.status()).toBeLessThan(300)
      await expect.poll(async () => {
        const response = await apiRequest(
          request,
          'GET',
          `/api/finoo_affiliates/deal-attributions?dealId=${encodeURIComponent(String(dealId))}`,
          { token },
        )
        return (await readJsonSafe<{ attribution?: unknown }>(response))?.attribution ?? null
      }).toBeNull()

      const restoreAttribution = await apiRequest(request, 'PUT', '/api/finoo_affiliates/deal-attributions', {
        token,
        data: {
          dealId,
          affiliateUserId,
          commissionStatusEntryId: waitingStatusId,
          commissionAmount: 125,
        },
      })
      expect(restoreAttribution.status()).toBe(200)

      let attributionUpdatedAt: string | undefined
      let previousUpdatedAt: string | undefined
      await expect.poll(async () => {
        const refreshedEditorResponse = await apiRequest(
          request,
          'GET',
          `/api/finoo_affiliates/deal-attributions?dealId=${encodeURIComponent(String(dealId))}`,
          { token },
        )
        const refreshedEditor = await readJsonSafe<{ attribution?: { updatedAt: string } }>(refreshedEditorResponse)
        attributionUpdatedAt = refreshedEditor?.attribution?.updatedAt
        const isStable = Boolean(attributionUpdatedAt && attributionUpdatedAt === previousUpdatedAt)
        previousUpdatedAt = attributionUpdatedAt
        return isStable
      }, { intervals: [200, 400, 800] }).toBe(true)
      expect(attributionUpdatedAt).toBeTruthy()
      const dealTimeline = await readPersistedDealTimeline(dealId)
      const restoredEditorResponse = await apiRequest(
        request,
        'GET',
        `/api/finoo_affiliates/deal-attributions?dealId=${encodeURIComponent(dealId)}`,
        { token },
      )
      const restoredEditor = await readJsonSafe<{ attribution?: { leadAt: string } }>(restoredEditorResponse)
      expect(restoredEditor?.attribution?.leadAt).toBe(dealTimeline.createdAt)

      const updateAttribution = await request.put(resolveUrl('/api/finoo_affiliates/deal-attributions'), {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          [LOCK_HEADER]: String(attributionUpdatedAt),
        },
        data: {
          dealId,
          affiliateUserId,
          commissionStatusEntryId: waitingStatusId,
          commissionAmount: 250,
        },
      })
      expect(updateAttribution.status()).toBe(200)
      const staleUpdate = await request.put(resolveUrl('/api/finoo_affiliates/deal-attributions'), {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          [LOCK_HEADER]: String(attributionUpdatedAt),
        },
        data: {
          dealId,
          affiliateUserId,
          commissionStatusEntryId: waitingStatusId,
          commissionAmount: 300,
        },
      })
      expect(staleUpdate.status()).toBe(409)

      const baseUrl = new URL(resolveUrl('/'))
      const createLinkResponse = await apiRequest(request, 'POST', '/api/finoo_affiliates/links', {
        token,
        data: {
          affiliateUserId,
          label: 'Integration link',
          destinationUrl: `${baseUrl.origin}/finoo-application?campaign=integration`,
          isActive: true,
        },
      })
      expect(createLinkResponse.status()).toBe(201)
      const createdLink = await readJsonSafe(createLinkResponse)
      linkId = findString(createdLink, ['id'])
      const code = findString(createdLink, ['code'])
      expect(linkId).toBeTruthy()
      expect(code).toBeTruthy()

      const firstRedirect = await request.get(resolveUrl(`/api/finoo_affiliates/r/${code}`), {
        headers: { 'user-agent': 'Mozilla/5.0 Safari/605.1', 'x-forwarded-for': '198.51.100.10' },
        maxRedirects: 0,
      })
      expect(firstRedirect.status()).toBe(302)
      const location = firstRedirect.headers().location
      expect(location).toContain('campaign=integration')
      expect(location).toContain(`affiliate_code=${code}`)
      const visitorCookie = firstRedirect.headers()['set-cookie']?.match(/finoo_affiliate_visitor=[^;]+/)?.[0]
      expect(visitorCookie).toBeTruthy()
      const duplicateRedirect = await request.get(resolveUrl(`/api/finoo_affiliates/r/${code}`), {
        headers: { 'user-agent': 'Mozilla/5.0 Safari/605.1', 'x-forwarded-for': '198.51.100.10', Cookie: String(visitorCookie) },
        maxRedirects: 0,
      })
      expect(duplicateRedirect.status()).toBe(302)
      const botRedirect = await request.get(resolveUrl(`/api/finoo_affiliates/r/${code}`), {
        headers: { 'user-agent': 'Googlebot/2.1', 'x-forwarded-for': '198.51.100.10' },
        maxRedirects: 0,
      })
      expect(botRedirect.status()).toBe(302)
      expect(botRedirect.headers()['set-cookie']).toBeUndefined()

      const affiliateSession = await portalLogin(request, {
        email: affiliate.email,
        password: affiliate.password,
        tenantId,
      })
      const otherSession = await portalLogin(request, {
        email: otherAffiliate.email,
        password: otherAffiliate.password,
        tenantId,
      })

      const readDashboardCount = async (metric: 'clicks' | 'transactions') => {
        const response = await request.get(resolveUrl('/api/finoo_affiliates/portal/dashboard'), {
          headers: portalCookieHeaders(affiliateSession),
        })
        expect(response.status()).toBe(200)
        const payload = await readJsonSafe<Record<string, Array<{ count: number }>>>(response)
        return (payload?.[metric] ?? []).reduce((sum, point) => sum + point.count, 0)
      }
      await waitForCount(() => readDashboardCount('clicks'), 1)

      const leadsResponse = await request.get(resolveUrl('/api/finoo_affiliates/portal/leads?page=1&pageSize=25'), {
        headers: portalCookieHeaders(affiliateSession),
      })
      const leads = await readJsonSafe<{
        total: number
        items: Array<{ dealId: string; companyName: string | null; commissionAmount: number; commissionStatus: string }>
      }>(leadsResponse)
      expect(leadsResponse.status()).toBe(200)
      expect(leads?.total).toBe(1)
      expect(leads?.items?.[0]).toMatchObject({ dealId, commissionAmount: 250, commissionStatus: 'waiting' })

      const isolatedLeadsResponse = await request.get(resolveUrl('/api/finoo_affiliates/portal/leads?page=1&pageSize=25'), {
        headers: portalCookieHeaders(otherSession),
      })
      const isolatedLeads = await readJsonSafe<{ total: number }>(isolatedLeadsResponse)
      expect(isolatedLeads?.total).toBe(0)

      const dealUpdatedAt = await readDealUpdatedAt(request, token, dealId)
      const completeDeal = await request.put(resolveUrl('/api/customers/deals'), {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          [LOCK_HEADER]: dealUpdatedAt,
        },
        data: { id: dealId, pipelineId, pipelineStageId: completedStageId },
      })
      expect(completeDeal.status()).toBeLessThan(300)
      await waitForCount(() => readDashboardCount('transactions'), 1)
      const firstCompletion = await readPersistedDealTimeline(dealId)
      const firstCompletedAt = firstCompletion.completedAt
      expect(firstCompletedAt).toBeTruthy()
      expect(firstCompletion.capturedCompletedAt).toBe(firstCompletedAt)
      await expect.poll(async () => {
        const response = await apiRequest(
          request,
          'GET',
          `/api/finoo_affiliates/deal-attributions?dealId=${encodeURIComponent(String(dealId))}`,
          { token },
        )
        return (await readJsonSafe<{ attribution?: { transactionAt: string | null } }>(response))
          ?.attribution?.transactionAt ?? null
      }, { timeout: 10_000, intervals: [200, 400, 800] }).toBe(firstCompletedAt)

      const reopenVersion = await readDealUpdatedAt(request, token, dealId)
      const reopenDeal = await request.put(resolveUrl('/api/customers/deals'), {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          [LOCK_HEADER]: reopenVersion,
        },
        data: { id: dealId, pipelineId, pipelineStageId: openStageId },
      })
      expect(reopenDeal.status()).toBeLessThan(300)
      const recompleteVersion = await readDealUpdatedAt(request, token, dealId)
      const recompleteDeal = await request.put(resolveUrl('/api/customers/deals'), {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          [LOCK_HEADER]: recompleteVersion,
        },
        data: { id: dealId, pipelineId, pipelineStageId: completedStageId },
      })
      expect(recompleteDeal.status()).toBeLessThan(300)
      await waitForCount(() => readDashboardCount('transactions'), 1)
      const recompletedEditorResponse = await apiRequest(
        request,
        'GET',
        `/api/finoo_affiliates/deal-attributions?dealId=${encodeURIComponent(dealId)}`,
        { token },
      )
      const recompletedEditor = await readJsonSafe<{ attribution?: { transactionAt: string | null } }>(recompletedEditorResponse)
      expect(recompletedEditor?.attribution?.transactionAt).toBe(firstCompletedAt)

      completedBeforeAttributionDealId = await createDealFixture(request, token, {
        title: `Finoo completed before attribution ${Date.now()}`,
        companyIds: [companyId],
        pipelineId,
        pipelineStageId: completedStageId,
      })
      const attachCompletedDeal = await apiRequest(request, 'PUT', '/api/finoo_affiliates/deal-attributions', {
        token,
        data: {
          dealId: completedBeforeAttributionDealId,
          affiliateUserId,
          commissionStatusEntryId: waitingStatusId,
          commissionAmount: 75,
        },
      })
      expect(attachCompletedDeal.status()).toBe(200)
      const completedEditorResponse = await apiRequest(
        request,
        'GET',
        `/api/finoo_affiliates/deal-attributions?dealId=${encodeURIComponent(completedBeforeAttributionDealId)}`,
        { token },
      )
      const completedEditor = await readJsonSafe<{ attribution?: { leadAt: string; transactionAt: string | null } }>(completedEditorResponse)
      const completedBeforeAttributionTimeline = await readPersistedDealTimeline(completedBeforeAttributionDealId)
      expect(completedBeforeAttributionTimeline.capturedCompletedAt).toBe(completedBeforeAttributionTimeline.completedAt)
      expect(completedEditor?.attribution?.leadAt).toBe(completedBeforeAttributionTimeline.createdAt)
      expect(completedEditor?.attribution?.transactionAt).toBe(completedBeforeAttributionTimeline.completedAt)
      await waitForCount(() => readDashboardCount('transactions'), 2)

      const invalidRange = await request.get(resolveUrl('/api/finoo_affiliates/portal/dashboard?from=2025-01-01&to=2026-01-02'), {
        headers: portalCookieHeaders(affiliateSession),
      })
      expect(invalidRange.status()).toBe(400)
    } finally {
      if (linkId) {
        await apiRequest(request, 'DELETE', '/api/finoo_affiliates/links', { token, data: { id: linkId } }).catch(() => undefined)
      }
      await deleteEntityByBody(request, token, '/api/customers/deals', completedBeforeAttributionDealId)
      await deleteEntityByBody(request, token, '/api/customers/deals', dealId)
      await deleteEntityIfExists(request, token, '/api/customers/pipeline-stages', completedStageId)
      await deleteEntityIfExists(request, token, '/api/customers/pipeline-stages', openStageId)
      await deleteEntityIfExists(request, token, '/api/customers/pipelines', pipelineId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
      await deleteCustomerUserFixture(request, token, otherAffiliateUserId)
      await deleteCustomerUserFixture(request, token, affiliateUserId)
      if (role.created) await deleteCustomerRoleFixture(request, token, role.id)
    }
  })

  test('disables the public signup API/page while keeping login available', async ({ request }) => {
    const signupApi = await request.post(resolveUrl('/api/customer_accounts/signup'), {
      data: { email: `disabled-${Date.now()}@test.local` },
    })
    expect([404, 405]).toContain(signupApi.status())

    const signupPage = await request.get(resolveUrl('/integration/portal/signup'), { maxRedirects: 0 })
    expect([301, 302, 303, 307, 308]).toContain(signupPage.status())
    expect(signupPage.headers().location).toBe('/integration/portal/login')

    const loginPage = await request.get(resolveUrl('/integration/portal/login'), { maxRedirects: 0 })
    expect(loginPage.status()).toBeLessThan(400)
  })

  test('automatically attributes a Deal from affiliate_code and exposes the required lead fields', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const { tenantId } = getTokenContext(token)
    const role = await ensureAffiliateRole(request, token)
    const fieldKeys = ['affiliate_code', 'landing_page', 'initial_referrer']
    let affiliateUserId: string | null = null
    let companyId: string | null = null
    let pipelineId: string | null = null
    let openStageId: string | null = null
    let dealId: string | null = null
    let linkId: string | null = null

    try {
      for (const key of fieldKeys) await createTextDealDefinition(request, token, key)
      const affiliate = await createCustomerUserFixture(request, token, { roleIds: [role.id] })
      affiliateUserId = affiliate.id
      companyId = await createCompanyFixture(request, token, `Finoo automatic ${Date.now()}`)
      pipelineId = await createPipelineFixture(request, token, { name: `Finoo automatic pipeline ${Date.now()}` })
      openStageId = await createPipelineStageFixture(request, token, { pipelineId, label: 'Open', order: 0 })
      const baseUrl = new URL(resolveUrl('/'))
      const createLinkResponse = await apiRequest(request, 'POST', '/api/finoo_affiliates/links', {
        token,
        data: {
          affiliateUserId,
          label: 'Automatic attribution link',
          destinationUrl: `${baseUrl.origin}/finoo-application`,
          isActive: true,
        },
      })
      expect(createLinkResponse.status()).toBe(201)
      const linkPayload = await readJsonSafe(createLinkResponse)
      linkId = findString(linkPayload, ['id'])
      const code = findString(linkPayload, ['code'])
      expect(code).toBeTruthy()

      const createDealResponse = await apiRequest(request, 'POST', '/api/customers/deals', {
        token,
        data: {
          title: `Automatically attributed Deal ${Date.now()}`,
          companyIds: [companyId],
          pipelineId,
          pipelineStageId: openStageId,
          customFields: {
            affiliate_code: code,
            landing_page: '/application/automatic',
            initial_referrer: 'https://affiliate.example/campaign',
          },
        },
      })
      expect(createDealResponse.status()).toBeLessThan(300)
      dealId = findString(await readJsonSafe(createDealResponse), ['dealId', 'id', 'entityId'])
      expect(dealId).toBeTruthy()

      await expect.poll(async () => {
        const response = await apiRequest(
          request,
          'GET',
          `/api/finoo_affiliates/deal-attributions?dealId=${encodeURIComponent(String(dealId))}`,
          { token },
        )
        return (await readJsonSafe<{ attribution?: { affiliateUserId: string } | null }>(response))?.attribution?.affiliateUserId ?? null
      }, { timeout: 10_000, intervals: [200, 400, 800] }).toBe(affiliateUserId)

      const session = await portalLogin(request, {
        email: affiliate.email,
        password: affiliate.password,
        tenantId,
      })
      const leadsResponse = await request.get(resolveUrl('/api/finoo_affiliates/portal/leads?page=1&pageSize=25'), {
        headers: portalCookieHeaders(session),
      })
      const leads = await readJsonSafe<{
        total: number
        items: Array<{ dealId: string; companyName: string | null; landingPage: string | null; initialReferrer: string | null }>
      }>(leadsResponse)
      expect(leadsResponse.status()).toBe(200)
      expect(leads?.total).toBe(1)
      expect(leads?.items?.[0]).toMatchObject({
        dealId,
        landingPage: '/application/automatic',
        initialReferrer: 'https://affiliate.example/campaign',
      })
      expect(leads?.items?.[0]?.companyName).toContain('Finoo automatic')
    } finally {
      if (linkId) await apiRequest(request, 'DELETE', '/api/finoo_affiliates/links', { token, data: { id: linkId } }).catch(() => undefined)
      await deleteEntityByBody(request, token, '/api/customers/deals', dealId)
      await deleteEntityIfExists(request, token, '/api/customers/pipeline-stages', openStageId)
      await deleteEntityIfExists(request, token, '/api/customers/pipelines', pipelineId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
      await deleteCustomerUserFixture(request, token, affiliateUserId)
      for (const key of [...fieldKeys].reverse()) await deleteDealDefinition(request, token, key)
      if (role.created) await deleteCustomerRoleFixture(request, token, role.id)
    }
  })
})
