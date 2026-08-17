import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import {
  apiRequest,
  getAuthToken,
} from "@open-mercato/core/helpers/integration/api";
import {
  createCustomerRoleFixture,
  createCustomerUserFixture,
  deleteCustomerRoleFixture,
  deleteCustomerUserFixture,
  portalCookieHeaders,
  portalLogin,
  type CustomerUserFixture,
} from "@open-mercato/core/helpers/integration/customerAccountsFixtures";
import {
  createCompanyFixture,
  createDealFixture,
  createPipelineFixture,
  createPipelineStageFixture,
  deleteEntityByBody,
  deleteEntityIfExists,
} from "@open-mercato/core/helpers/integration/crmFixtures";
import {
  getTokenContext,
  readJsonSafe,
} from "@open-mercato/core/helpers/integration/generalFixtures";
import { login } from "@open-mercato/core/helpers/integration/auth";

const LOCK_HEADER = "x-om-ext-optimistic-lock-expected-updated-at";
const COMMISSION_DIALOG_NAME = /Edit commission rule|Edytuj regułę prowizji/;
const COMMISSION_MODE_NAME = /Commission type|Typ prowizji/;
const COMMISSION_PERCENTAGE_NAME = /Percentage|Procent(?:owa)?/;
const COMMISSION_FIXED_NAME = /Fixed amount|Stała kwota/;

type Scope = { tenantId: string; organizationId: string };
type DbClient = {
  connect(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};
type AffiliateFixture = {
  id: string;
  email: string;
  code: string;
  user: CustomerUserFixture;
};
type AffiliateSettings = {
  id: string;
  commissionMode: "percentage" | "fixed" | null;
  commissionRateBps: number | null;
  commissionFixedAmount: number | null;
  updatedAt: string;
};
type AffiliateRoleFixture = { id: string; created: boolean };
type TransactionSnapshot = {
  id: string;
  commissionAmount: number;
  commissionMode: "legacy_deal_amount" | "percentage" | "fixed";
  commissionRateBps: number | null;
  commissionFixedAmount: number | null;
  commissionBaseAmount: string | null;
};
type DealEditorProjection = {
  attribution: null | {
    commissionAmount: number;
    affiliateTransactionId: string | null;
    affiliateTransactionAmount: number | null;
    affiliateTransactionCurrency: string | null;
    affiliateTransactionStatus: "processing" | "approved" | "rejected" | "paid_out" | null;
    affiliateTransactionCommissionMode: TransactionSnapshot["commissionMode"] | null;
  };
  affiliates: Array<{
    id: string;
    commissionMode: "percentage" | "fixed" | null;
  }>;
  statuses: Array<{ id: string; value: string }>;
};

function resolveUrl(path: string): string {
  const baseUrl = process.env.BASE_URL?.trim();
  return baseUrl ? `${baseUrl}${path}` : path;
}

function requireDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString)
    throw new Error("DATABASE_URL is required for Finoo commission fixtures");
  return connectionString;
}

async function createAffiliateFixture(
  request: APIRequestContext,
  client: DbClient,
  token: string,
  scope: Scope,
  roleId: string,
  label: string,
): Promise<AffiliateFixture> {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const user = await createCustomerUserFixture(request, token, {
    email: `thom91-${label}-${suffix}@test.local`,
    displayName: `THOM-91 ${label} ${suffix}`,
    roleIds: [roleId],
  });
  const id = randomUUID();
  const code = randomUUID().replaceAll("-", "").slice(0, 24).toUpperCase();
  await client.query(
    `insert into finoo_affiliates
       (id, organization_id, tenant_id, customer_user_id, email, email_hash, code,
        is_active, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, true, now(), now())`,
    [
      id,
      scope.organizationId,
      scope.tenantId,
      user.id,
      user.email,
      `thom91-${randomUUID()}`,
      code,
    ],
  );
  return { id, email: user.email, code, user };
}

async function ensureAffiliateRole(
  request: APIRequestContext,
  token: string,
): Promise<AffiliateRoleFixture> {
  const response = await apiRequest(
    request,
    "GET",
    "/api/customer_accounts/admin/roles?page=1&pageSize=100",
    { token },
  );
  expect(response.status()).toBe(200);
  const body = await readJsonSafe<{
    items?: Array<{ id: string; slug: string }>;
  }>(response);
  const existing = body?.items?.find((role) => role.slug === "affiliate");
  if (existing) return { id: existing.id, created: false };
  const role = await createCustomerRoleFixture(request, token, {
    name: "Affiliate",
    slug: "affiliate",
    features: [
      "portal.finoo_affiliates.view",
      "portal.finoo_affiliates.profile.manage",
    ],
  });
  return { id: role.id, created: true };
}

async function cleanupAffiliateFixture(
  request: APIRequestContext,
  client: DbClient,
  token: string,
  fixture: AffiliateFixture | null,
): Promise<void> {
  if (!fixture) return;
  await client.query(
    "delete from finoo_affiliate_transactions where affiliate_id = $1",
    [fixture.id],
  );
  await client.query(
    "delete from finoo_deal_attributions where affiliate_id = $1",
    [fixture.id],
  );
  await client.query(
    "delete from finoo_affiliate_links where affiliate_id = $1",
    [fixture.id],
  );
  await client.query("delete from finoo_affiliates where id = $1", [fixture.id]);
  await deleteCustomerUserFixture(request, token, fixture.user.id);
}

async function readAffiliateSettings(
  request: APIRequestContext,
  token: string,
  affiliateId: string,
): Promise<AffiliateSettings> {
  const response = await apiRequest(
    request,
    "GET",
    "/api/finoo_affiliates/affiliates?page=1&pageSize=100",
    { token },
  );
  expect(response.status()).toBe(200);
  const body = await readJsonSafe<{ items?: AffiliateSettings[] }>(response);
  const settings = body?.items?.find((item) => item.id === affiliateId);
  expect(settings).toBeTruthy();
  return settings!;
}

async function patchCommission(
  request: APIRequestContext,
  token: string,
  input: AffiliateSettings,
) {
  return request.patch(resolveUrl("/api/finoo_affiliates/affiliates"), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      [LOCK_HEADER]: input.updatedAt,
    },
    data: input,
  });
}

async function readDealUpdatedAt(
  client: DbClient,
  dealId: string,
): Promise<string> {
  const result = await client.query<{ updated_at: Date }>(
    "select updated_at from customer_deals where id = $1",
    [dealId],
  );
  expect(result.rows[0]?.updated_at).toBeTruthy();
  return result.rows[0].updated_at.toISOString();
}

async function updateDealStage(
  request: APIRequestContext,
  client: DbClient,
  token: string,
  dealId: string,
  pipelineId: string,
  pipelineStageId: string,
): Promise<void> {
  const response = await requestDealStageUpdate(
    request,
    client,
    token,
    dealId,
    pipelineId,
    pipelineStageId,
  );
  expect(response.status()).toBeLessThan(300);
}

async function requestDealStageUpdate(
  request: APIRequestContext,
  client: DbClient,
  token: string,
  dealId: string,
  pipelineId: string,
  pipelineStageId: string,
) {
  const updatedAt = await readDealUpdatedAt(client, dealId);
  return request.put(resolveUrl("/api/customers/deals"), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      [LOCK_HEADER]: updatedAt,
    },
    data: { id: dealId, pipelineId, pipelineStageId },
  });
}

async function waitForAffiliateLockWaiters(
  client: DbClient,
  minimumCount: number,
): Promise<void> {
  await expect
    .poll(async () => {
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count
           from pg_stat_activity
          where wait_event_type = 'Lock'
            and query ilike '%finoo_affiliates%'`,
      );
      return Number(result.rows[0]?.count ?? 0);
    }, { timeout: 10_000, intervals: [100, 200, 400] })
    .toBeGreaterThanOrEqual(minimumCount);
}

async function assignDeal(
  request: APIRequestContext,
  token: string,
  dealId: string,
  affiliateUserId: string,
  legacyAmount?: number,
): Promise<void> {
  const editorResponse = await apiRequest(
    request,
    "GET",
    `/api/finoo_affiliates/deal-attributions?dealId=${dealId}`,
    { token },
  );
  const editor = await readJsonSafe<{
    statuses?: Array<{ id: string; value: string }>;
  }>(editorResponse);
  const waitingStatusId = editor?.statuses?.find(
    (status) => status.value === "waiting",
  )?.id;
  expect(waitingStatusId).toBeTruthy();
  const response = await apiRequest(
    request,
    "PUT",
    "/api/finoo_affiliates/deal-attributions",
    {
      token,
      data: {
        dealId,
        affiliateUserId,
        commissionStatusEntryId: waitingStatusId,
        ...(legacyAmount === undefined ? {} : { commissionAmount: legacyAmount }),
      },
    },
  );
  expect(response.status()).toBe(200);
}

async function readDealEditor(
  request: APIRequestContext,
  token: string,
  dealId: string,
): Promise<DealEditorProjection> {
  const response = await apiRequest(
    request,
    "GET",
    `/api/finoo_affiliates/deal-attributions?dealId=${dealId}`,
    { token },
  );
  expect(response.status()).toBe(200);
  return (await readJsonSafe<DealEditorProjection>(response))!;
}

async function readTransaction(
  client: DbClient,
  dealId: string,
): Promise<TransactionSnapshot | null> {
  const result = await client.query<{
    id: string;
    commission_amount: number;
    commission_mode: TransactionSnapshot["commissionMode"];
    commission_rate_bps: number | null;
    commission_fixed_amount: number | null;
    commission_base_amount: string | null;
  }>(
    `select id, commission_amount, commission_mode, commission_rate_bps,
            commission_fixed_amount, commission_base_amount
       from finoo_affiliate_transactions
      where deal_id = $1`,
    [dealId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        commissionAmount: row.commission_amount,
        commissionMode: row.commission_mode,
        commissionRateBps: row.commission_rate_bps,
        commissionFixedAmount: row.commission_fixed_amount,
        commissionBaseAmount: row.commission_base_amount,
      }
    : null;
}

async function countTransactions(client: DbClient, dealId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    "select count(*)::text as count from finoo_affiliate_transactions where deal_id = $1",
    [dealId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function openCommissionDialog(page: Parameters<typeof login>[0], code: string) {
  await expect(
    page.getByRole("button", { name: /Invite affiliate|Zaproś/ }),
  ).toBeVisible();
  const row = page.getByRole("row", { name: new RegExp(code) });
  const actions = row.getByRole("button", { name: /Open actions|Otwórz akcje/ });
  const editCommission = page
    .locator('[role="menuitem"]:visible')
    .filter({ hasText: /Edit commission|Edytuj prowizję/ })
    .last();
  await expect(async () => {
    if (!(await editCommission.isVisible())) await actions.click({ force: true });
    await expect(editCommission).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 5_000 });
  await editCommission.click({ force: true });
  await expect(
    page.getByRole("heading", { name: COMMISSION_DIALOG_NAME }),
  ).toBeVisible();
}

test.describe("TC-FINOO-AFF-017..018: affiliate commission persistence and UI", () => {
  test("TC-017: persists exact percentage/fixed snapshots and keeps existing transactions immutable", async ({
    request,
  }) => {
    const token = await getAuthToken(request, "admin");
    const tokenContext = getTokenContext(token);
    const scope = {
      tenantId: tokenContext.tenantId,
      organizationId: tokenContext.organizationId,
    };
    const client: DbClient = new Client({ connectionString: requireDatabaseUrl() });
    const locker: DbClient = new Client({ connectionString: requireDatabaseUrl() });
    await client.connect();
    await locker.connect();
    let affiliateLockOpen = false;
    let affiliate: AffiliateFixture | null = null;
    let affiliateRole: AffiliateRoleFixture | null = null;
    let companyId: string | null = null;
    let pipelineId: string | null = null;
    let openStageId: string | null = null;
    let acceptedStageId: string | null = null;
    const dealIds: string[] = [];

    try {
      affiliateRole = await ensureAffiliateRole(request, token);
      affiliate = await createAffiliateFixture(
        request,
        client,
        token,
        scope,
        affiliateRole.id,
        "api",
      );
      const initial = await readAffiliateSettings(request, token, affiliate.id);
      expect(initial).toMatchObject({
        id: affiliate.id,
        commissionMode: null,
        commissionRateBps: null,
        commissionFixedAmount: null,
      });

      companyId = await createCompanyFixture(
        request,
        token,
        `THOM-91 Commission ${Date.now()}`,
      );
      pipelineId = await createPipelineFixture(request, token, {
        name: `THOM-91 Commission ${Date.now()}`,
      });
      openStageId = await createPipelineStageFixture(request, token, {
        pipelineId,
        label: "Open",
        order: 0,
      });
      acceptedStageId = await createPipelineStageFixture(request, token, {
        pipelineId,
        label: "Accepted",
        order: 1,
      });

      const legacyDealId = await createDealFixture(request, token, {
        title: `THOM-91 Legacy ${Date.now()}`,
        companyIds: [companyId],
        pipelineId,
        pipelineStageId: openStageId,
        valueAmount: 999,
        valueCurrency: "PLN",
      });
      dealIds.push(legacyDealId);
      const legacyEditor = await readDealEditor(request, token, legacyDealId);
      const waitingStatusId = legacyEditor.statuses.find(
        (status) => status.value === "waiting",
      )?.id;
      expect(legacyEditor.affiliates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: affiliate.user.id,
          commissionMode: null,
        }),
      ]));
      const missingLegacyAmount = await apiRequest(
        request,
        "PUT",
        "/api/finoo_affiliates/deal-attributions",
        {
          token,
          data: {
            dealId: legacyDealId,
            affiliateUserId: affiliate.user.id,
            commissionStatusEntryId: waitingStatusId,
          },
        },
      );
      expect(missingLegacyAmount.status()).toBe(422);
      expect(await readJsonSafe<{ code?: string }>(missingLegacyAmount)).toMatchObject({
        code: "legacy_commission_amount_required",
      });
      await assignDeal(request, token, legacyDealId, affiliate.user.id, 77);
      await updateDealStage(
        request,
        client,
        token,
        legacyDealId,
        pipelineId,
        acceptedStageId,
      );
      await expect.poll(() => readTransaction(client, legacyDealId)).not.toBeNull();
      expect(await readTransaction(client, legacyDealId)).toMatchObject({
        commissionAmount: 77,
        commissionMode: "legacy_deal_amount",
        commissionRateBps: null,
        commissionFixedAmount: null,
        commissionBaseAmount: null,
      });
      expect((await readDealEditor(request, token, legacyDealId)).attribution).toMatchObject({
        affiliateTransactionAmount: 77,
        affiliateTransactionCurrency: "PLN",
        affiliateTransactionStatus: "processing",
        affiliateTransactionCommissionMode: "legacy_deal_amount",
      });

      const percentageResponse = await patchCommission(request, token, {
        ...initial,
        commissionMode: "percentage",
        commissionRateBps: 1250,
        commissionFixedAmount: null,
      });
      expect(percentageResponse.status()).toBe(200);
      const percentage = await readJsonSafe<AffiliateSettings>(percentageResponse);
      expect(percentage).toMatchObject({
        id: affiliate.id,
        commissionMode: "percentage",
        commissionRateBps: 1250,
        commissionFixedAmount: null,
      });
      await expect(
        readAffiliateSettings(request, token, affiliate.id),
      ).resolves.toMatchObject({
        commissionMode: "percentage",
        commissionRateBps: 1250,
        commissionFixedAmount: null,
      });

      const staleResponse = await patchCommission(request, token, {
        ...initial,
        commissionMode: "fixed",
        commissionRateBps: null,
        commissionFixedAmount: 999,
      });
      expect(staleResponse.status()).toBe(409);

      const percentageDealId = await createDealFixture(request, token, {
        title: `THOM-91 Percentage ${Date.now()}`,
        companyIds: [companyId],
        pipelineId,
        pipelineStageId: openStageId,
        valueAmount: 1000,
        valueCurrency: "PLN",
      });
      dealIds.push(percentageDealId);
      await assignDeal(request, token, percentageDealId, affiliate.user.id);
      const pendingPercentageEditor = await readDealEditor(request, token, percentageDealId);
      expect(pendingPercentageEditor.affiliates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: affiliate.user.id,
          commissionMode: "percentage",
        }),
      ]));
      expect(pendingPercentageEditor.attribution).toMatchObject({
        affiliateTransactionId: null,
        affiliateTransactionAmount: null,
        affiliateTransactionCurrency: null,
        affiliateTransactionStatus: null,
        affiliateTransactionCommissionMode: null,
      });
      await updateDealStage(
        request,
        client,
        token,
        percentageDealId,
        pipelineId,
        acceptedStageId,
      );
      await expect
        .poll(() => readTransaction(client, percentageDealId))
        .not.toBeNull();
      const percentageTransaction = await readTransaction(
        client,
        percentageDealId,
      );
      expect(percentageTransaction).toMatchObject({
        commissionAmount: 125,
        commissionMode: "percentage",
        commissionRateBps: 1250,
        commissionFixedAmount: null,
        commissionBaseAmount: "1000.00",
      });
      expect((await readDealEditor(request, token, percentageDealId)).attribution).toMatchObject({
        affiliateTransactionId: percentageTransaction!.id,
        affiliateTransactionAmount: 125,
        affiliateTransactionCurrency: "PLN",
        affiliateTransactionStatus: "processing",
        affiliateTransactionCommissionMode: "percentage",
      });

      const delayedDealId = await createDealFixture(request, token, {
        title: `THOM-91 Delayed ${Date.now()}`,
        companyIds: [companyId],
        pipelineId,
        pipelineStageId: openStageId,
        valueAmount: 400,
        valueCurrency: "PLN",
      });
      dealIds.push(delayedDealId);
      await assignDeal(request, token, delayedDealId, affiliate.user.id, 44);
      await client.query(
        "update finoo_affiliates set is_active = false, updated_at = now() where id = $1",
        [affiliate.id],
      );
      await updateDealStage(
        request,
        client,
        token,
        delayedDealId,
        pipelineId,
        acceptedStageId,
      );
      const capturedAcceptance = await client.query<{
        deal_value_amount: string | null;
        deal_value_currency: string | null;
      }>(
        `select deal_value_amount, deal_value_currency
           from finoo_deal_acceptances
          where deal_id = $1`,
        [delayedDealId],
      );
      expect(capturedAcceptance.rows[0]).toEqual({
        deal_value_amount: "400.00",
        deal_value_currency: "PLN",
      });
      expect(await readTransaction(client, delayedDealId)).toBeNull();
      await client.query(
        "update customer_deals set value_amount = '800.00', updated_at = now() where id = $1",
        [delayedDealId],
      );
      await client.query(
        "update finoo_affiliates set is_active = true, updated_at = now() where id = $1",
        [affiliate.id],
      );
      await updateDealStage(
        request,
        client,
        token,
        delayedDealId,
        pipelineId,
        openStageId,
      );
      await expect.poll(() => readTransaction(client, delayedDealId)).not.toBeNull();
      expect(await readTransaction(client, delayedDealId)).toMatchObject({
        commissionAmount: 50,
        commissionMode: "percentage",
        commissionRateBps: 1250,
        commissionFixedAmount: null,
        commissionBaseAmount: "400.00",
      });

      const currentPercentage = await readAffiliateSettings(
        request,
        token,
        affiliate.id,
      );
      const fixedResponse = await patchCommission(request, token, {
        ...currentPercentage,
        commissionMode: "fixed",
        commissionRateBps: null,
        commissionFixedAmount: 90,
      });
      expect(fixedResponse.status()).toBe(200);
      const fixed = await readJsonSafe<AffiliateSettings>(fixedResponse);
      expect(fixed).toMatchObject({
        commissionMode: "fixed",
        commissionRateBps: null,
        commissionFixedAmount: 90,
      });
      await client.query(
        "update customer_deals set value_amount = '2000.00', updated_at = now() where id = $1",
        [percentageDealId],
      );
      expect(await readTransaction(client, percentageDealId)).toEqual(
        percentageTransaction,
      );

      const fixedDealId = await createDealFixture(request, token, {
        title: `THOM-91 Fixed ${Date.now()}`,
        companyIds: [companyId],
        pipelineId,
        pipelineStageId: openStageId,
        valueAmount: 777,
        valueCurrency: "PLN",
      });
      dealIds.push(fixedDealId);
      await assignDeal(request, token, fixedDealId, affiliate.user.id);
      await updateDealStage(
        request,
        client,
        token,
        fixedDealId,
        pipelineId,
        acceptedStageId,
      );
      await expect.poll(() => readTransaction(client, fixedDealId)).not.toBeNull();
      expect(await readTransaction(client, fixedDealId)).toMatchObject({
        commissionAmount: 90,
        commissionMode: "fixed",
        commissionRateBps: null,
        commissionFixedAmount: 90,
        commissionBaseAmount: null,
      });
      expect((await readDealEditor(request, token, fixedDealId)).attribution).toMatchObject({
        affiliateTransactionAmount: 90,
        affiliateTransactionCurrency: "PLN",
        affiliateTransactionStatus: "processing",
        affiliateTransactionCommissionMode: "fixed",
      });

      const fixedSnapshot = await readTransaction(client, fixedDealId);
      await updateDealStage(
        request,
        client,
        token,
        fixedDealId,
        pipelineId,
        openStageId,
      );
      await updateDealStage(
        request,
        client,
        token,
        fixedDealId,
        pipelineId,
        acceptedStageId,
      );
      await expect.poll(() => countTransactions(client, fixedDealId)).toBe(1);
      expect(await readTransaction(client, fixedDealId)).toEqual(fixedSnapshot);

      const portalSession = await portalLogin(request, {
        email: affiliate.user.email,
        password: affiliate.user.password,
        tenantId: scope.tenantId,
      });
      const portalLeadsResponse = await request.get(
        resolveUrl("/api/finoo_affiliates/portal/leads?page=1&pageSize=100"),
        { headers: portalCookieHeaders(portalSession) },
      );
      expect(portalLeadsResponse.status()).toBe(200);
      const portalLeads = await readJsonSafe<{
        items?: Array<Record<string, unknown> & {
          dealId?: string;
          affiliateTransactionAmount?: number | null;
        }>;
      }>(portalLeadsResponse);
      const percentagePortalLead = portalLeads?.items?.find(
        (item) => item.dealId === percentageDealId,
      );
      expect(percentagePortalLead).toMatchObject({
        affiliateTransactionAmount: 125,
      });
      expect(percentagePortalLead).not.toHaveProperty("commissionMode");
      expect(percentagePortalLead).not.toHaveProperty("commissionRateBps");
      expect(percentagePortalLead).not.toHaveProperty("commissionFixedAmount");
      expect(percentagePortalLead).not.toHaveProperty("commissionBaseAmount");

      const hiddenAffiliateId = randomUUID();
      const hiddenOrganizationId = randomUUID();
      const hiddenCode = randomUUID().replaceAll("-", "").slice(0, 24).toUpperCase();
      await client.query(
        `insert into finoo_affiliates
           (id, organization_id, tenant_id, email, email_hash, code, is_active, created_at, updated_at)
         select $1, $2, tenant_id, email, email_hash || '-other', $3, true, now(), now()
           from finoo_affiliates where id = $4`,
        [hiddenAffiliateId, hiddenOrganizationId, hiddenCode, affiliate.id],
      );
      try {
        const isolatedList = await apiRequest(
          request,
          "GET",
          `/api/finoo_affiliates/affiliates?search=${hiddenCode}`,
          { token },
        );
        expect(isolatedList.status()).toBe(200);
        expect(await readJsonSafe<{ total?: number }>(isolatedList)).toMatchObject({
          total: 0,
        });
        const crossScopePatch = await request.patch(
          resolveUrl("/api/finoo_affiliates/affiliates"),
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              [LOCK_HEADER]: new Date().toISOString(),
            },
            data: {
              id: hiddenAffiliateId,
              updatedAt: new Date().toISOString(),
              commissionMode: "fixed",
              commissionRateBps: null,
              commissionFixedAmount: 999,
            },
          },
        );
        expect(crossScopePatch.status()).toBe(404);
        const hiddenRule = await client.query<{
          commission_mode: string | null;
          commission_fixed_amount: number | null;
        }>(
          "select commission_mode, commission_fixed_amount from finoo_affiliates where id = $1",
          [hiddenAffiliateId],
        );
        expect(hiddenRule.rows[0]).toEqual({
          commission_mode: null,
          commission_fixed_amount: null,
        });
      } finally {
        await client.query("delete from finoo_affiliates where id = $1", [hiddenAffiliateId]);
      }

      const transactionsResponse = await apiRequest(
        request,
        "GET",
        "/api/finoo_affiliates/transactions?page=1&pageSize=100",
        { token },
      );
      const transactions = await readJsonSafe<{
        items?: TransactionSnapshot[];
      }>(transactionsResponse);
      expect(transactions?.items).toEqual(expect.arrayContaining([
        expect.objectContaining(percentageTransaction!),
        expect.objectContaining({
          id: (await readTransaction(client, fixedDealId))!.id,
          commissionAmount: 90,
          commissionMode: "fixed",
          commissionFixedAmount: 90,
        }),
      ]));

      const concurrentDealId = await createDealFixture(request, token, {
        title: `THOM-91 Concurrent ${Date.now()}`,
        companyIds: [companyId],
        pipelineId,
        pipelineStageId: openStageId,
        valueAmount: 500,
        valueCurrency: "PLN",
      });
      dealIds.push(concurrentDealId);
      await assignDeal(request, token, concurrentDealId, affiliate.user.id, 11);

      await locker.query("begin");
      affiliateLockOpen = true;
      await locker.query(
        "select id from finoo_affiliates where id = $1 for update",
        [affiliate.id],
      );
      const acceptancePromise = requestDealStageUpdate(
        request,
        client,
        token,
        concurrentDealId,
        pipelineId,
        acceptedStageId,
      );
      await waitForAffiliateLockWaiters(client, 1);
      const concurrentRuleUpdatePromise = patchCommission(request, token, {
        ...fixed!,
        commissionMode: "percentage",
        commissionRateBps: 5000,
        commissionFixedAmount: null,
      });
      await waitForAffiliateLockWaiters(client, 2);
      await locker.query("commit");
      affiliateLockOpen = false;

      const [acceptanceResponse, concurrentRuleUpdateResponse] = await Promise.all([
        acceptancePromise,
        concurrentRuleUpdatePromise,
      ]);
      expect(acceptanceResponse.status()).toBeLessThan(300);
      expect(concurrentRuleUpdateResponse.status()).toBe(200);
      const concurrentPercentage = await readJsonSafe<AffiliateSettings>(
        concurrentRuleUpdateResponse,
      );
      await expect.poll(() => readTransaction(client, concurrentDealId)).not.toBeNull();
      expect(await readTransaction(client, concurrentDealId)).toMatchObject({
        commissionAmount: 90,
        commissionMode: "fixed",
        commissionRateBps: null,
        commissionFixedAmount: 90,
      });

      const updateFirstDealId = await createDealFixture(request, token, {
        title: `THOM-91 Update First ${Date.now()}`,
        companyIds: [companyId],
        pipelineId,
        pipelineStageId: openStageId,
        valueAmount: 500,
        valueCurrency: "PLN",
      });
      dealIds.push(updateFirstDealId);
      await assignDeal(request, token, updateFirstDealId, affiliate.user.id, 12);

      await locker.query("begin");
      affiliateLockOpen = true;
      await locker.query(
        "select id from finoo_affiliates where id = $1 for update",
        [affiliate.id],
      );
      const updateFirstRulePromise = patchCommission(request, token, {
        ...concurrentPercentage!,
        commissionMode: "fixed",
        commissionRateBps: null,
        commissionFixedAmount: 120,
      });
      await waitForAffiliateLockWaiters(client, 1);
      const updateFirstAcceptancePromise = requestDealStageUpdate(
        request,
        client,
        token,
        updateFirstDealId,
        pipelineId,
        acceptedStageId,
      );
      await waitForAffiliateLockWaiters(client, 2);
      await locker.query("commit");
      affiliateLockOpen = false;

      const [updateFirstRuleResponse, updateFirstAcceptanceResponse] =
        await Promise.all([updateFirstRulePromise, updateFirstAcceptancePromise]);
      expect(updateFirstRuleResponse.status()).toBe(200);
      expect(updateFirstAcceptanceResponse.status()).toBeLessThan(300);
      await expect.poll(() => readTransaction(client, updateFirstDealId)).not.toBeNull();
      expect(await readTransaction(client, updateFirstDealId)).toMatchObject({
        commissionAmount: 120,
        commissionMode: "fixed",
        commissionRateBps: null,
        commissionFixedAmount: 120,
      });
    } finally {
      if (affiliateLockOpen) await locker.query("rollback").catch(() => undefined);
      for (const dealId of dealIds) {
        await client
          .query("delete from finoo_deal_acceptances where deal_id = $1", [dealId])
          .catch(() => undefined);
        await deleteEntityByBody(request, token, "/api/customers/deals", dealId);
      }
      await deleteEntityIfExists(
        request,
        token,
        "/api/customers/pipeline-stages",
        acceptedStageId,
      );
      await deleteEntityIfExists(
        request,
        token,
        "/api/customers/pipeline-stages",
        openStageId,
      );
      await deleteEntityIfExists(
        request,
        token,
        "/api/customers/pipelines",
        pipelineId,
      );
      await deleteEntityIfExists(
        request,
        token,
        "/api/customers/companies",
        companyId,
      );
      await cleanupAffiliateFixture(request, client, token, affiliate);
      if (affiliateRole?.created) {
        await deleteCustomerRoleFixture(request, token, affiliateRole.id);
      }
      await client.end();
      await locker.end();
    }
  });

  test("TC-018: saves both dialog modes, exposes stale conflicts, and remains usable at narrow width", async ({
    page,
    request,
  }) => {
    test.setTimeout(30_000);
    const token = await getAuthToken(request, "admin");
    const tokenContext = getTokenContext(token);
    const scope = {
      tenantId: tokenContext.tenantId,
      organizationId: tokenContext.organizationId,
    };
    const client: DbClient = new Client({ connectionString: requireDatabaseUrl() });
    await client.connect();
    let affiliate: AffiliateFixture | null = null;
    let affiliateRole: AffiliateRoleFixture | null = null;

    try {
      affiliateRole = await ensureAffiliateRole(request, token);
      affiliate = await createAffiliateFixture(
        request,
        client,
        token,
        scope,
        affiliateRole.id,
        "ui",
      );
      await login(page, "admin");
      await page.goto("/backend/finoo-affiliates/affiliates");
      await openCommissionDialog(page, affiliate.code);

      await page.getByRole("spinbutton", { name: COMMISSION_PERCENTAGE_NAME }).fill("0.07");
      await page.getByRole("spinbutton", { name: COMMISSION_PERCENTAGE_NAME }).press("Control+Enter");
      await expect(
        page.getByRole("heading", { name: COMMISSION_DIALOG_NAME }),
      ).not.toBeVisible();
      await page.reload();
      await expect(
        page.getByRole("row", { name: new RegExp(affiliate.code) }),
      ).toContainText("0.07%");

      await openCommissionDialog(page, affiliate.code);
      await page.getByRole("combobox", { name: COMMISSION_MODE_NAME }).click();
      await page.getByRole("option", { name: COMMISSION_FIXED_NAME }).click();
      await page.getByRole("textbox", { name: /Fixed commission|Stała prowizja/ }).fill("90");
      await page.getByRole("button", { name: /Save|Zapisz/ }).click();
      await page.reload();
      await expect(
        page.getByRole("row", { name: new RegExp(affiliate.code) }),
      ).toContainText("90 PLN");

      await openCommissionDialog(page, affiliate.code);
      await client.query(
        "update finoo_affiliates set updated_at = clock_timestamp() where id = $1",
        [affiliate.id],
      );
      await page.getByRole("combobox", { name: COMMISSION_MODE_NAME }).click();
      await page.getByRole("option", { name: COMMISSION_PERCENTAGE_NAME }).click();
      await page.getByRole("spinbutton", { name: COMMISSION_PERCENTAGE_NAME }).fill("9.5");
      const conflictResponsePromise = page.waitForResponse((response) =>
        response.request().method() === "PATCH"
        && new URL(response.url()).pathname === "/api/finoo_affiliates/affiliates",
      );
      await page.getByRole("button", { name: /Save|Zapisz/ }).click();
      expect((await conflictResponsePromise).status()).toBe(409);
      await expect(
        page.getByRole("heading", { name: COMMISSION_DIALOG_NAME }),
      ).toBeVisible();
      await page.keyboard.press("Escape");

      await page.reload();
      await page.setViewportSize({ width: 768, height: 800 });
      await openCommissionDialog(page, affiliate.code);
      const dialog = await page.getByRole("dialog").boundingBox();
      expect(dialog).not.toBeNull();
      expect(dialog!.x).toBeGreaterThanOrEqual(0);
      expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(768);
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("heading", { name: COMMISSION_DIALOG_NAME }),
      ).not.toBeVisible();
    } finally {
      await cleanupAffiliateFixture(request, client, token, affiliate);
      if (affiliateRole?.created) {
        await deleteCustomerRoleFixture(request, token, affiliateRole.id);
      }
      await client.end();
    }
  });
});
