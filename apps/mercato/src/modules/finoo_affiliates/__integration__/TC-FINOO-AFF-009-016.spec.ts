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
  deleteCustomerUserFixture,
  portalCookieHeaders,
  portalLogin,
  type CustomerUserFixture,
  type PortalSession,
} from "@open-mercato/core/helpers/integration/customerAccountsFixtures";
import { seedSystemEmailChannel } from "@open-mercato/core/helpers/integration/communicationChannelsFixtures";
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
import { drainIntegrationQueue } from "@open-mercato/core/helpers/integration/queue";

const LOCK_HEADER = "x-om-ext-optimistic-lock-expected-updated-at";
const PAYOUT_QUEUE = "finoo-affiliates-payout-create";

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
  affiliateId: string;
  code: string;
  invitationId: string;
  session: PortalSession;
  user: CustomerUserFixture;
};
type TransactionRow = {
  id: string;
  acceptedAt: string;
  commissionAmount: number;
  commissionStatus: "processing" | "approved" | "rejected" | "paid_out";
  createdEventPublishedAt: string | null;
  payoutId: string | null;
  updatedAt: string;
};

function resolveUrl(path: string): string {
  const baseUrl = process.env.BASE_URL?.trim();
  return baseUrl ? `${baseUrl}${path}` : path;
}

function requireDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString)
    throw new Error("DATABASE_URL is required for Finoo integration fixtures");
  return connectionString;
}

async function ensureAffiliateRole(request: APIRequestContext, token: string) {
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

async function createAffiliateFixture(
  request: APIRequestContext,
  client: DbClient,
  token: string,
  scope: Scope,
  roleId: string,
  label: string,
): Promise<AffiliateFixture> {
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const email = `qa-finoo-${label}-${stamp}@test.local`;
  await seedSystemEmailChannel(request, token, {
    displayName: `QA Finoo ${label} system email`,
    externalIdentifier: `system-${stamp}@test-seed.local`,
  });
  const invite = await apiRequest(
    request,
    "POST",
    "/api/customer_accounts/admin/users-invite",
    {
      token,
      data: {
        email,
        roleIds: [roleId],
        displayName: `QA Finoo ${label} ${stamp}`,
      },
    },
  );
  expect(invite.status()).toBe(201);
  const invitation = await readJsonSafe<{ invitation?: { id: string } }>(
    invite,
  );
  expect(invitation?.invitation?.id).toBeTruthy();
  const invitationId = String(invitation?.invitation?.id);

  const firstEnsure = await apiRequest(
    request,
    "POST",
    "/api/finoo_affiliates/affiliates/ensure-invitation",
    {
      token,
      data: { invitationId },
    },
  );
  const first = await readJsonSafe<{
    affiliate?: { id: string; code: string; isActive: boolean };
    error?: string;
    code?: string;
  }>(firstEnsure);
  expect(
    [200, 201],
    `ensure invitation failed: ${JSON.stringify(first)}`,
  ).toContain(firstEnsure.status());
  expect(first?.affiliate?.id).toBeTruthy();
  expect(first?.affiliate?.code).toMatch(/^[A-Z0-9]{24}$/);
  expect(first?.affiliate?.isActive).toBe(false);

  const repeatedEnsure = await apiRequest(
    request,
    "POST",
    "/api/finoo_affiliates/affiliates/ensure-invitation",
    {
      token,
      data: { invitationId },
    },
  );
  expect(repeatedEnsure.status()).toBe(200);
  const repeated = await readJsonSafe<{
    affiliate?: { id: string; code: string };
  }>(repeatedEnsure);
  expect(repeated?.affiliate).toMatchObject({
    id: first?.affiliate?.id,
    code: first?.affiliate?.code,
  });

  const user = await createCustomerUserFixture(request, token, {
    email,
    displayName: `QA Finoo ${label} ${stamp}`,
    roleIds: [roleId],
  });
  await client.query(
    `update customer_user_invitations
        set accepted_at = coalesce(accepted_at, now())
      where id = $1 and tenant_id = $2 and organization_id = $3`,
    [invitationId, scope.tenantId, scope.organizationId],
  );

  const session = await portalLogin(request, {
    email: user.email,
    password: user.password,
    tenantId: scope.tenantId,
  });
  const repair = await request.get(
    resolveUrl("/api/finoo_affiliates/portal/dashboard"),
    {
      headers: portalCookieHeaders(session),
    },
  );
  expect(repair.status()).toBe(200);
  const repairBody = await readJsonSafe<{
    generatedLink?: { code: string; trackedUrl: string } | null;
  }>(repair);
  expect(repairBody?.generatedLink?.code).toBe(first?.affiliate?.code);
  expect(repairBody?.generatedLink?.trackedUrl).toContain(
    `/api/finoo_affiliates/r/${first?.affiliate?.code}`,
  );

  const repaired = await client.query<{
    customer_user_id: string;
    is_active: boolean;
    primary_link_id: string | null;
  }>(
    `select customer_user_id, is_active, primary_link_id
       from finoo_affiliates
      where id = $1`,
    [first?.affiliate?.id],
  );
  expect(repaired.rows[0]).toMatchObject({
    customer_user_id: user.id,
    is_active: true,
  });
  expect(repaired.rows[0]?.primary_link_id).toBeTruthy();

  return {
    affiliateId: String(first?.affiliate?.id),
    code: String(first?.affiliate?.code),
    invitationId,
    session,
    user,
  };
}

async function cleanupAffiliateFixture(
  request: APIRequestContext,
  client: DbClient,
  token: string,
  fixture: AffiliateFixture | null,
): Promise<void> {
  if (!fixture) return;
  await client.query(
    "delete from finoo_payout_previews where affiliate_id = $1",
    [fixture.affiliateId],
  );
  await client.query(
    "delete from finoo_affiliate_transactions where affiliate_id = $1",
    [fixture.affiliateId],
  );
  await client.query(
    "delete from finoo_affiliate_payouts where affiliate_id = $1",
    [fixture.affiliateId],
  );
  await client.query(
    "delete from finoo_deal_attributions where affiliate_id = $1",
    [fixture.affiliateId],
  );
  await client.query(
    "update finoo_affiliates set primary_link_id = null where id = $1",
    [fixture.affiliateId],
  );
  await client.query(
    "delete from finoo_affiliate_visits where affiliate_link_id in (select id from finoo_affiliate_links where affiliate_id = $1)",
    [fixture.affiliateId],
  );
  await client.query(
    "delete from finoo_affiliate_links where affiliate_id = $1",
    [fixture.affiliateId],
  );
  await client.query("delete from finoo_affiliates where id = $1", [
    fixture.affiliateId,
  ]);
  await deleteCustomerUserFixture(request, token, fixture.user.id);
  await client.query("delete from customer_user_invitations where id = $1", [
    fixture.invitationId,
  ]);
}

async function readDealUpdatedAt(
  request: APIRequestContext,
  token: string,
  dealId: string,
): Promise<string> {
  const response = await apiRequest(
    request,
    "GET",
    `/api/customers/deals?id=${encodeURIComponent(dealId)}`,
    { token },
  );
  const body = await readJsonSafe<{
    items?: Array<{ updatedAt?: string; updated_at?: string }>;
  }>(response);
  const updatedAt = body?.items?.[0]?.updatedAt ?? body?.items?.[0]?.updated_at;
  expect(updatedAt).toBeTruthy();
  return String(updatedAt);
}

async function updateDealStage(
  request: APIRequestContext,
  token: string,
  dealId: string,
  pipelineId: string,
  pipelineStageId: string,
): Promise<void> {
  const updatedAt = await readDealUpdatedAt(request, token, dealId);
  const response = await request.put(resolveUrl("/api/customers/deals"), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      [LOCK_HEADER]: updatedAt,
    },
    data: { id: dealId, pipelineId, pipelineStageId },
  });
  expect(response.status()).toBeLessThan(300);
}

async function readTransactionByDeal(
  client: DbClient,
  dealId: string,
): Promise<TransactionRow | null> {
  const result = await client.query<{
    id: string;
    accepted_at: Date;
    commission_amount: number;
    commission_status: TransactionRow["commissionStatus"];
    created_event_published_at: Date | null;
    payout_id: string | null;
    updated_at: Date;
  }>(
    `select id, accepted_at, commission_amount, commission_status,
            created_event_published_at, payout_id, updated_at
       from finoo_affiliate_transactions
      where deal_id = $1`,
    [dealId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        acceptedAt: row.accepted_at.toISOString(),
        commissionAmount: row.commission_amount,
        commissionStatus: row.commission_status,
        createdEventPublishedAt: row.created_event_published_at?.toISOString() ?? null,
        payoutId: row.payout_id,
        updatedAt: row.updated_at.toISOString(),
      }
    : null;
}

async function transitionTransaction(
  request: APIRequestContext,
  token: string,
  transactionId: string,
  action: "accept" | "reject" | "reprocess",
  updatedAt: string,
) {
  return apiRequest(
    request,
    "POST",
    `/api/finoo_affiliates/transactions/${transactionId}/transition`,
    {
      token,
      data: { action, updatedAt },
    },
  );
}

async function readStatusEntry(
  client: DbClient,
  scope: Scope,
  status: TransactionRow["commissionStatus"],
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `select entry.id
       from dictionary_entries entry
       join dictionaries dictionary on dictionary.id = entry.dictionary_id
      where dictionary.tenant_id = $1
        and dictionary.organization_id = $2
        and dictionary.key = 'finoo_affiliate_transaction_status'
        and entry.normalized_value = $3`,
    [scope.tenantId, scope.organizationId, status],
  );
  expect(result.rows[0]?.id).toBeTruthy();
  return result.rows[0].id;
}

async function insertTransaction(
  client: DbClient,
  scope: Scope,
  affiliate: AffiliateFixture,
  statusEntryId: string,
  status: TransactionRow["commissionStatus"],
  amount: number,
  organizationId = scope.organizationId,
): Promise<TransactionRow> {
  const id = randomUUID();
  const dealId = randomUUID();
  const result = await client.query<{
    accepted_at: Date;
    updated_at: Date;
  }>(
    `insert into finoo_affiliate_transactions
       (id, organization_id, tenant_id, affiliate_id, affiliate_user_id, deal_id,
        commission_amount, currency, commission_status_entry_id, commission_status,
        accepted_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'PLN', $8, $9, now(), now(), now())
     returning accepted_at, updated_at`,
    [
      id,
      organizationId,
      scope.tenantId,
      affiliate.affiliateId,
      affiliate.user.id,
      dealId,
      amount,
      statusEntryId,
      status,
    ],
  );
  return {
    id,
    acceptedAt: result.rows[0].accepted_at.toISOString(),
    commissionAmount: amount,
    commissionStatus: status,
    createdEventPublishedAt: null,
    payoutId: null,
    updatedAt: result.rows[0].updated_at.toISOString(),
  };
}

async function updateOwnProfile(
  request: APIRequestContext,
  session: PortalSession,
  data: { accountHolderName: string; accountNumber: string; updatedAt: string },
) {
  return request.put(resolveUrl("/api/finoo_affiliates/portal/profile"), {
    headers: portalCookieHeaders(session, {
      "Content-Type": "application/json",
    }),
    data,
  });
}

test.describe("TC-FINOO-AFF-009..023: membership, ledger, privacy, and payout integration", () => {
  test("TC-009..012: repairs membership, snapshots first Accepted once, enforces transitions, and preserves legacy lead fields", async ({
    request,
  }) => {
    const token = await getAuthToken(request, "admin");
    const tokenContext = getTokenContext(token);
    const scope = {
      tenantId: tokenContext.tenantId,
      organizationId: tokenContext.organizationId,
    };
    const client: DbClient = new Client({
      connectionString: requireDatabaseUrl(),
    });
    await client.connect();
    const role = await ensureAffiliateRole(request, token);
    let affiliate: AffiliateFixture | null = null;
    let companyId: string | null = null;
    let pipelineId: string | null = null;
    let openStageId: string | null = null;
    let acceptedStageId: string | null = null;
    let dealId: string | null = null;

    try {
      affiliate = await createAffiliateFixture(
        request,
        client,
        token,
        scope,
        role.id,
        "accepted",
      );

      const affiliatesResponse = await apiRequest(
        request,
        "GET",
        `/api/finoo_affiliates/affiliates?search=${encodeURIComponent(affiliate.user.email)}`,
        { token },
      );
      const affiliates = await readJsonSafe<{
        items?: Array<{
          id: string;
          email: string;
          firstName: string;
          lastName: string;
          code: string;
          state: string;
          relatedDeals: number;
        }>;
      }>(affiliatesResponse);
      expect(affiliatesResponse.status()).toBe(200);
      expect(
        `${affiliates?.items?.[0]?.firstName ?? ""}${affiliates?.items?.[0]?.lastName ?? ""}`,
      ).not.toBe("");
      expect(affiliates?.items).toEqual([
        expect.objectContaining({
          id: affiliate.affiliateId,
          email: affiliate.user.email,
          code: affiliate.code,
          state: "active",
          relatedDeals: 0,
        }),
      ]);

      const crossOrganizationId = randomUUID();
      const hiddenCode = randomUUID()
        .replaceAll("-", "")
        .slice(0, 24)
        .toUpperCase();
      await client.query(
        `insert into finoo_affiliates
           (id, organization_id, tenant_id, email, email_hash, code, is_active, created_at, updated_at)
         select $1, $2, tenant_id, email, email_hash || '-other', $3, true, now(), now()
           from finoo_affiliates where id = $4`,
        [randomUUID(), crossOrganizationId, hiddenCode, affiliate.affiliateId],
      );
      const isolatedList = await apiRequest(
        request,
        "GET",
        `/api/finoo_affiliates/affiliates?search=${hiddenCode}`,
        { token },
      );
      const isolatedBody = await readJsonSafe<{ total?: number }>(isolatedList);
      expect(isolatedBody?.total).toBe(0);
      await client.query(
        "delete from finoo_affiliates where organization_id = $1 and code = $2",
        [crossOrganizationId, hiddenCode],
      );

      companyId = await createCompanyFixture(
        request,
        token,
        `QA Finoo Accepted ${Date.now()}`,
      );
      pipelineId = await createPipelineFixture(request, token, {
        name: `QA Finoo Accepted ${Date.now()}`,
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
      dealId = await createDealFixture(request, token, {
        title: `QA Finoo accepted Deal ${Date.now()}`,
        companyIds: [companyId],
        pipelineId,
        pipelineStageId: openStageId,
      });

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
      const attribution = await apiRequest(
        request,
        "PUT",
        "/api/finoo_affiliates/deal-attributions",
        {
          token,
          data: {
            dealId,
            affiliateUserId: affiliate.user.id,
            commissionStatusEntryId: waitingStatusId,
            commissionAmount: 123,
          },
        },
      );
      expect(attribution.status()).toBe(200);
      const countedAffiliateResponse = await apiRequest(
        request,
        "GET",
        `/api/finoo_affiliates/affiliates?search=${encodeURIComponent(affiliate.code)}`,
        { token },
      );
      const countedAffiliate = await readJsonSafe<{
        items?: Array<{ id: string; relatedDeals: number }>;
      }>(countedAffiliateResponse);
      expect(countedAffiliate?.items).toEqual([
        expect.objectContaining({ id: affiliate.affiliateId, relatedDeals: 1 }),
      ]);

      await updateDealStage(
        request,
        token,
        dealId,
        pipelineId,
        acceptedStageId,
      );
      await expect
        .poll(async () => await readTransactionByDeal(client, String(dealId)))
        .not.toBeNull();
      const first = await readTransactionByDeal(client, dealId);
      expect(first).toMatchObject({
        commissionAmount: 123,
        commissionStatus: "processing",
      });
      expect(first?.createdEventPublishedAt).not.toBeNull();

      await updateDealStage(request, token, dealId, pipelineId, openStageId);
      await updateDealStage(
        request,
        token,
        dealId,
        pipelineId,
        acceptedStageId,
      );
      await expect
        .poll(async () => {
          const count = await client.query<{ count: string }>(
            "select count(*)::text as count from finoo_affiliate_transactions where deal_id = $1",
            [dealId],
          );
          return count.rows[0]?.count;
        })
        .toBe("1");
      const repeated = await readTransactionByDeal(client, dealId);
      expect(repeated?.acceptedAt).toBe(first?.acceptedAt);

      const rejection = await transitionTransaction(
        request,
        token,
        first!.id,
        "reject",
        first!.updatedAt,
      );
      expect(rejection.status()).toBe(200);
      const rejected = await readJsonSafe<{
        commissionStatus: string;
        updatedAt: string;
      }>(rejection);
      expect(rejected?.commissionStatus).toBe("rejected");
      const stale = await transitionTransaction(
        request,
        token,
        first!.id,
        "reprocess",
        first!.updatedAt,
      );
      expect(stale.status()).toBe(409);
      const illegal = await transitionTransaction(
        request,
        token,
        first!.id,
        "accept",
        String(rejected?.updatedAt),
      );
      expect(illegal.status()).toBe(409);
      const reprocessedResponse = await transitionTransaction(
        request,
        token,
        first!.id,
        "reprocess",
        String(rejected?.updatedAt),
      );
      expect(reprocessedResponse.status()).toBe(200);
      const reprocessed = await readJsonSafe<{ updatedAt: string }>(
        reprocessedResponse,
      );
      const approvedResponse = await transitionTransaction(
        request,
        token,
        first!.id,
        "accept",
        String(reprocessed?.updatedAt),
      );
      expect(approvedResponse.status()).toBe(200);
      const approved = await readJsonSafe<{ updatedAt: string }>(
        approvedResponse,
      );
      const terminalByReview = await transitionTransaction(
        request,
        token,
        first!.id,
        "reject",
        String(approved?.updatedAt),
      );
      expect(terminalByReview.status()).toBe(409);

      const refreshedEditor = await apiRequest(
        request,
        "GET",
        `/api/finoo_affiliates/deal-attributions?dealId=${dealId}`,
        { token },
      );
      const refreshed = await readJsonSafe<{
        attribution?: { updatedAt: string };
      }>(refreshedEditor);
      const changedLegacyAttribution = await request.put(
        resolveUrl("/api/finoo_affiliates/deal-attributions"),
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            [LOCK_HEADER]: String(refreshed?.attribution?.updatedAt),
          },
          data: {
            dealId,
            affiliateUserId: affiliate.user.id,
            commissionStatusEntryId: waitingStatusId,
            commissionAmount: 999,
          },
        },
      );
      expect(changedLegacyAttribution.status()).toBe(200);
      expect(
        (await readTransactionByDeal(client, dealId))?.commissionAmount,
      ).toBe(123);

      const leadsResponse = await request.get(
        resolveUrl("/api/finoo_affiliates/portal/leads?page=1&pageSize=25"),
        {
          headers: portalCookieHeaders(affiliate.session),
        },
      );
      const leads = await readJsonSafe<{
        items?: Array<{
          dealId: string;
          commissionAmount: number;
          commissionStatus: string;
          affiliateProgramStatus: string;
          affiliateTransactionId: string | null;
          affiliateTransactionAmount: number | null;
          affiliateTransactionAcceptedAt: string | null;
        }>;
      }>(leadsResponse);
      expect(leadsResponse.status()).toBe(200);
      expect(
        leads?.items?.find((item) => item.dealId === dealId),
      ).toMatchObject({
        commissionAmount: 999,
        commissionStatus: "waiting",
        affiliateProgramStatus: "approved",
        affiliateTransactionId: first?.id,
        affiliateTransactionAmount: 123,
        affiliateTransactionAcceptedAt: first?.acceptedAt,
      });
    } finally {
      if (dealId)
        await client
          .query("delete from finoo_deal_acceptances where deal_id = $1", [
            dealId,
          ])
          .catch(() => undefined);
      await deleteEntityByBody(request, token, "/api/customers/deals", dealId);
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
      await client.end();
    }
  });

  test("TC-013..014: keeps bank profiles private and optimistic while enforcing exact payout eligibility and scope", async ({
    request,
  }) => {
    const token = await getAuthToken(request, "admin");
    const tokenContext = getTokenContext(token);
    const scope = {
      tenantId: tokenContext.tenantId,
      organizationId: tokenContext.organizationId,
    };
    const client: DbClient = new Client({
      connectionString: requireDatabaseUrl(),
    });
    await client.connect();
    const role = await ensureAffiliateRole(request, token);
    let firstAffiliate: AffiliateFixture | null = null;
    let secondAffiliate: AffiliateFixture | null = null;

    try {
      firstAffiliate = await createAffiliateFixture(
        request,
        client,
        token,
        scope,
        role.id,
        "profile-a",
      );
      secondAffiliate = await createAffiliateFixture(
        request,
        client,
        token,
        scope,
        role.id,
        "profile-b",
      );
      const processingEntry = await readStatusEntry(
        client,
        scope,
        "processing",
      );
      const approvedEntry = await readStatusEntry(client, scope, "approved");
      const approved = await insertTransaction(
        client,
        scope,
        firstAffiliate,
        approvedEntry,
        "approved",
        40,
      );
      const processing = await insertTransaction(
        client,
        scope,
        firstAffiliate,
        processingEntry,
        "processing",
        15,
      );
      const secondApproved = await insertTransaction(
        client,
        scope,
        secondAffiliate,
        approvedEntry,
        "approved",
        25,
      );
      const crossScope = await insertTransaction(
        client,
        scope,
        firstAffiliate,
        approvedEntry,
        "approved",
        10,
        randomUUID(),
      );

      const firstProfileResponse = await request.get(
        resolveUrl("/api/finoo_affiliates/portal/profile"),
        {
          headers: portalCookieHeaders(firstAffiliate.session),
        },
      );
      const firstProfile = await readJsonSafe<{
        accountHolderName: string;
        accountNumber: string;
        updatedAt: string;
      }>(firstProfileResponse);
      expect(firstProfile).toMatchObject({
        accountHolderName: "",
        accountNumber: "",
      });
      expect(firstProfile).not.toHaveProperty("affiliateId");

      const incompletePreview = await apiRequest(
        request,
        "POST",
        "/api/finoo_affiliates/payouts/preview",
        {
          token,
          data: {
            transactions: [{ id: approved.id, updatedAt: approved.updatedAt }],
          },
        },
      );
      expect(incompletePreview.status()).toBe(409);
      expect(await readJsonSafe(incompletePreview)).toMatchObject({
        error: "PAYOUT_PROFILES_INCOMPLETE",
        affiliates: [{
          affiliateId: firstAffiliate.affiliateId,
          missingFields: ["accountHolderName", "accountNumber"],
        }],
      });

      const saved = await updateOwnProfile(request, firstAffiliate.session, {
        accountHolderName: "QA Affiliate A",
        accountNumber: "PL61109010140000071219812874",
        updatedAt: String(firstProfile?.updatedAt),
      });
      expect(saved.status()).toBe(200);
      const savedProfile = await readJsonSafe<{ updatedAt: string }>(saved);
      const encryptedProfile = await client.query<{
        account_holder_name: string;
        account_number: string;
      }>(
        "select account_holder_name, account_number from finoo_affiliates where id = $1",
        [firstAffiliate.affiliateId],
      );
      expect(encryptedProfile.rows[0]?.account_holder_name).not.toBe(
        "QA Affiliate A",
      );
      expect(encryptedProfile.rows[0]?.account_number).not.toBe(
        "PL61109010140000071219812874",
      );
      const staleSave = await updateOwnProfile(
        request,
        firstAffiliate.session,
        {
          accountHolderName: "Stale overwrite",
          accountNumber: "PL001234",
          updatedAt: String(firstProfile?.updatedAt),
        },
      );
      expect(staleSave.status()).toBe(409);

      const secondProfileResponse = await request.get(
        resolveUrl("/api/finoo_affiliates/portal/profile"),
        {
          headers: portalCookieHeaders(secondAffiliate.session),
        },
      );
      const secondProfile = await readJsonSafe<{
        accountHolderName: string;
        accountNumber: string;
        updatedAt: string;
      }>(secondProfileResponse);
      expect(secondProfile).toMatchObject({
        accountHolderName: "",
        accountNumber: "",
      });
      const secondSave = await updateOwnProfile(
        request,
        secondAffiliate.session,
        {
          accountHolderName: "QA Affiliate B",
          accountNumber: "PL52114020040000300201355387",
          updatedAt: String(secondProfile?.updatedAt),
        },
      );
      expect(secondSave.status()).toBe(200);
      const firstReload = await request.get(
        resolveUrl("/api/finoo_affiliates/portal/profile"),
        {
          headers: portalCookieHeaders(firstAffiliate.session),
        },
      );
      expect(await readJsonSafe(firstReload)).toMatchObject({
        accountHolderName: "QA Affiliate A",
        accountNumber: "PL61109010140000071219812874",
        updatedAt: savedProfile?.updatedAt,
      });

      const nonApproved = await apiRequest(
        request,
        "POST",
        "/api/finoo_affiliates/payouts/preview",
        {
          token,
          data: {
            transactions: [
              { id: processing.id, updatedAt: processing.updatedAt },
            ],
          },
        },
      );
      expect(nonApproved.status()).toBe(409);
      expect(await readJsonSafe(nonApproved)).toMatchObject({
        error: "TRANSACTION_NOT_APPROVED",
      });
      const mixed = await apiRequest(
        request,
        "POST",
        "/api/finoo_affiliates/payouts/preview",
        {
          token,
          data: {
            transactions: [
              { id: approved.id, updatedAt: approved.updatedAt },
              { id: secondApproved.id, updatedAt: secondApproved.updatedAt },
            ],
          },
        },
      );
      expect(mixed.status()).toBe(200);
      expect(await readJsonSafe(mixed)).toMatchObject({
        selectedCount: 2,
        affiliateCount: 2,
        totalAmount: "65",
        currency: "PLN",
        groups: [
          { selectedCount: 1, currency: "PLN" },
          { selectedCount: 1, currency: "PLN" },
        ],
      });
      const outsideScope = await apiRequest(
        request,
        "POST",
        "/api/finoo_affiliates/payouts/preview",
        {
          token,
          data: {
            transactions: [
              { id: crossScope.id, updatedAt: crossScope.updatedAt },
            ],
          },
        },
      );
      expect(outsideScope.status()).toBe(404);
      expect(await readJsonSafe(outsideScope)).toMatchObject({
        error: "TRANSACTION_NOT_FOUND",
      });

      const valid = await apiRequest(
        request,
        "POST",
        "/api/finoo_affiliates/payouts/preview",
        {
          token,
          data: {
            transactions: [{ id: approved.id, updatedAt: approved.updatedAt }],
          },
        },
      );
      const preview = await readJsonSafe<{
        paymentReference: string;
        affiliateId: string;
        affiliateUpdatedAt: string;
        accountHolderName: string;
        accountNumber: string;
        amount: string;
        currency: string;
        selectedCount: number;
        transactions: Array<{ id: string; updatedAt: string }>;
      }>(valid);
      expect(valid.status()).toBe(200);
      expect(preview).toMatchObject({
        affiliateId: firstAffiliate.affiliateId,
        accountHolderName: "QA Affiliate A",
        accountNumber: "PL61109010140000071219812874",
        amount: "40",
        currency: "PLN",
        selectedCount: 1,
        transactions: [{ id: approved.id, updatedAt: approved.updatedAt }],
      });
      expect(preview?.paymentReference).toMatch(/^FINOO-/);
    } finally {
      await cleanupAffiliateFixture(request, client, token, secondAffiliate);
      await cleanupAffiliateFixture(request, client, token, firstAffiliate);
      await client.end();
    }
  });

  test("TC-015..016: converges overlapping confirms atomically and keeps payout/dashboard contracts affiliate-owned", async ({
    request,
  }) => {
    const token = await getAuthToken(request, "admin");
    const tokenContext = getTokenContext(token);
    const scope = {
      tenantId: tokenContext.tenantId,
      organizationId: tokenContext.organizationId,
    };
    const client: DbClient = new Client({
      connectionString: requireDatabaseUrl(),
    });
    await client.connect();
    const role = await ensureAffiliateRole(request, token);
    let paidAffiliate: AffiliateFixture | null = null;
    let otherAffiliate: AffiliateFixture | null = null;

    try {
      paidAffiliate = await createAffiliateFixture(
        request,
        client,
        token,
        scope,
        role.id,
        "payout-a",
      );
      otherAffiliate = await createAffiliateFixture(
        request,
        client,
        token,
        scope,
        role.id,
        "payout-b",
      );
      const approvedEntry = await readStatusEntry(client, scope, "approved");
      const first = await insertTransaction(
        client,
        scope,
        paidAffiliate,
        approvedEntry,
        "approved",
        60,
      );
      const second = await insertTransaction(
        client,
        scope,
        paidAffiliate,
        approvedEntry,
        "approved",
        90,
      );

      const profileResponse = await request.get(
        resolveUrl("/api/finoo_affiliates/portal/profile"),
        {
          headers: portalCookieHeaders(paidAffiliate.session),
        },
      );
      const profile = await readJsonSafe<{ updatedAt: string }>(
        profileResponse,
      );
      const profileUpdate = await updateOwnProfile(
        request,
        paidAffiliate.session,
        {
          accountHolderName: "QA Paid Affiliate",
          accountNumber: "PL10105000997603123456789123",
          updatedAt: String(profile?.updatedAt),
        },
      );
      expect(profileUpdate.status()).toBe(200);

      const previewResponse = await apiRequest(
        request,
        "POST",
        "/api/finoo_affiliates/payouts/preview",
        {
          token,
          data: {
            transactions: [
              { id: second.id, updatedAt: second.updatedAt },
              { id: first.id, updatedAt: first.updatedAt },
            ],
          },
        },
      );
      const preview = await readJsonSafe<{
        paymentReference: string;
        affiliateUpdatedAt: string;
        amount: string;
        transactions: Array<{ id: string; updatedAt: string }>;
      }>(previewResponse);
      expect(previewResponse.status()).toBe(200);
      expect(preview?.amount).toBe("150");
      expect(preview?.transactions.map((item) => item.id)).toEqual(
        [first.id, second.id].sort(),
      );

      const emptySelection = await apiRequest(
        request,
        "POST",
        "/api/finoo_affiliates/payouts/preview",
        { token, data: { transactions: [] } },
      );
      expect(emptySelection.status()).toBe(400);

      const changedSelection = await apiRequest(
        request,
        "POST",
        "/api/finoo_affiliates/payouts/confirm",
        {
          token,
          data: {
            paymentReference: preview?.paymentReference,
            affiliateUpdatedAt: preview?.affiliateUpdatedAt,
            transactions: [preview!.transactions[0]],
          },
        },
      );
      expect(changedSelection.status()).toBe(409);
      expect(await readJsonSafe(changedSelection)).toMatchObject({
        error: "PAYOUT_PREVIEW_STALE",
      });

      const confirmation = {
        paymentReference: preview!.paymentReference,
        affiliateUpdatedAt: preview!.affiliateUpdatedAt,
        transactions: preview!.transactions,
      };
      const [firstConfirm, overlappingConfirm] = await Promise.all([
        apiRequest(request, "POST", "/api/finoo_affiliates/payouts/confirm", {
          token,
          data: confirmation,
        }),
        apiRequest(request, "POST", "/api/finoo_affiliates/payouts/confirm", {
          token,
          data: confirmation,
        }),
      ]);
      expect(firstConfirm.status()).toBe(202);
      expect(overlappingConfirm.status()).toBe(202);
      await drainIntegrationQueue(PAYOUT_QUEUE);

      await expect
        .poll(async () => {
          const payout = await client.query<{ count: string }>(
            "select count(*)::text as count from finoo_affiliate_payouts where payment_reference = $1",
            [confirmation.paymentReference],
          );
          return payout.rows[0]?.count;
        })
        .toBe("1");
      const payoutRows = await client.query<{
        id: string;
        amount: string;
        created_event_published_at: Date | null;
      }>(
        "select id, amount::text, created_event_published_at from finoo_affiliate_payouts where payment_reference = $1",
        [confirmation.paymentReference],
      );
      expect(payoutRows.rows[0]?.amount).toBe("150");
      expect(payoutRows.rows[0]?.created_event_published_at).not.toBeNull();
      const paidTransactions = await client.query<{
        id: string;
        commission_status: string;
        payout_id: string | null;
      }>(
        "select id, commission_status, payout_id from finoo_affiliate_transactions where id = any($1::uuid[]) order by id",
        [[first.id, second.id]],
      );
      expect(paidTransactions.rows).toHaveLength(2);
      expect(
        paidTransactions.rows.every(
          (row) =>
            row.commission_status === "paid_out" &&
            row.payout_id === payoutRows.rows[0]?.id,
        ),
      ).toBe(true);

      const retryAfterCommit = await apiRequest(
        request,
        "POST",
        "/api/finoo_affiliates/payouts/confirm",
        { token, data: confirmation },
      );
      expect(retryAfterCommit.status()).toBe(200);
      expect(await readJsonSafe(retryAfterCommit)).toMatchObject({
        payoutId: payoutRows.rows[0]?.id,
        paymentReference: confirmation.paymentReference,
      });

      const changedSelectionAfterCommit = await apiRequest(
        request,
        "POST",
        "/api/finoo_affiliates/payouts/confirm",
        {
          token,
          data: { ...confirmation, transactions: [confirmation.transactions[0]] },
        },
      );
      expect(changedSelectionAfterCommit.status()).toBe(409);
      expect(await readJsonSafe(changedSelectionAfterCommit)).toMatchObject({
        error: "PAYOUT_PREVIEW_STALE",
      });

      const changedVersionAfterCommit = await apiRequest(
        request,
        "POST",
        "/api/finoo_affiliates/payouts/confirm",
        {
          token,
          data: {
            ...confirmation,
            affiliateUpdatedAt: new Date(
              Date.parse(confirmation.affiliateUpdatedAt) + 1,
            ).toISOString(),
          },
        },
      );
      expect(changedVersionAfterCommit.status()).toBe(409);
      expect(await readJsonSafe(changedVersionAfterCommit)).toMatchObject({
        error: "PAYOUT_PREVIEW_STALE",
      });

      const ownPayouts = await request.get(
        resolveUrl("/api/finoo_affiliates/portal/payouts?page=1&pageSize=25"),
        {
          headers: portalCookieHeaders(paidAffiliate.session),
        },
      );
      const ownPayoutBody = await readJsonSafe<{
        total: number;
        items: Array<Record<string, unknown>>;
      }>(ownPayouts);
      expect(ownPayoutBody?.total).toBe(1);
      expect(ownPayoutBody?.items?.[0]).toMatchObject({
        paymentReference: confirmation.paymentReference,
        amount: "150",
        currency: "PLN",
      });
      expect(ownPayoutBody?.items?.[0]).not.toHaveProperty("accountNumber");
      expect(ownPayoutBody?.items?.[0]).not.toHaveProperty("accountHolderName");
      const otherPayouts = await request.get(
        resolveUrl("/api/finoo_affiliates/portal/payouts?page=1&pageSize=25"),
        {
          headers: portalCookieHeaders(otherAffiliate.session),
        },
      );
      expect(await readJsonSafe(otherPayouts)).toMatchObject({
        total: 0,
        items: [],
      });

      const dashboard = await request.get(
        resolveUrl("/api/finoo_affiliates/portal/dashboard"),
        {
          headers: portalCookieHeaders(paidAffiliate.session),
        },
      );
      const dashboardBody = await readJsonSafe<{
        transactions: Array<{ count: number }>;
        affiliateTransactions: Array<{ count: number }>;
        totalPaidOut: string;
        pendingPayout: string;
        currency: string;
        generatedLink: { code: string; trackedUrl: string } | null;
      }>(dashboard);
      expect(dashboard.status()).toBe(200);
      expect(
        dashboardBody?.transactions.reduce(
          (sum, point) => sum + point.count,
          0,
        ),
      ).toBe(0);
      expect(
        dashboardBody?.affiliateTransactions.reduce(
          (sum, point) => sum + point.count,
          0,
        ),
      ).toBe(2);
      expect(dashboardBody).toMatchObject({
        totalPaidOut: "150",
        pendingPayout: "0",
        currency: "PLN",
        generatedLink: { code: paidAffiliate.code },
      });
      const rangeFrom = new Date(Date.now() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      const rangeTo = new Date(Date.now() + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const rangedDashboard = await request.get(
        resolveUrl(
          `/api/finoo_affiliates/portal/dashboard?from=${rangeFrom}&to=${rangeTo}`,
        ),
        { headers: portalCookieHeaders(paidAffiliate.session) },
      );
      const rangedBody = await readJsonSafe<{
        affiliateTransactions: Array<{ count: number }>;
        totalPaidOut: string;
        pendingPayout: string;
      }>(rangedDashboard);
      expect(rangedDashboard.status()).toBe(200);
      expect(
        rangedBody?.affiliateTransactions.reduce(
          (sum, point) => sum + point.count,
          0,
        ),
      ).toBe(2);
      expect(rangedBody).toMatchObject({
        totalPaidOut: "150",
        pendingPayout: "0",
      });
    } finally {
      await cleanupAffiliateFixture(request, client, token, otherAffiliate);
      await cleanupAffiliateFixture(request, client, token, paidAffiliate);
      await client.end();
    }
  });

  test("TC-019..023: groups affiliates, blocks incomplete profiles, confirms atomically, and projects readiness", async ({
    request,
  }) => {
    const token = await getAuthToken(request, "admin");
    const tokenContext = getTokenContext(token);
    const scope = {
      tenantId: tokenContext.tenantId,
      organizationId: tokenContext.organizationId,
    };
    const client: DbClient = new Client({ connectionString: requireDatabaseUrl() });
    await client.connect();
    const role = await ensureAffiliateRole(request, token);
    let firstAffiliate: AffiliateFixture | null = null;
    let secondAffiliate: AffiliateFixture | null = null;
    let incompleteAffiliate: AffiliateFixture | null = null;

    try {
      firstAffiliate = await createAffiliateFixture(request, client, token, scope, role.id, "batch-a");
      secondAffiliate = await createAffiliateFixture(request, client, token, scope, role.id, "batch-b");
      incompleteAffiliate = await createAffiliateFixture(request, client, token, scope, role.id, "batch-incomplete");

      const loadProfile = async (affiliate: AffiliateFixture) => {
        const response = await request.get(resolveUrl("/api/finoo_affiliates/portal/profile"), {
          headers: portalCookieHeaders(affiliate.session),
        });
        return (await readJsonSafe<{ updatedAt: string }>(response))!;
      };
      const firstProfile = await loadProfile(firstAffiliate);
      const firstSaved = await updateOwnProfile(request, firstAffiliate.session, {
        accountHolderName: "QA Batch Affiliate A",
        accountNumber: "PL61109010140000071219812874",
        updatedAt: firstProfile.updatedAt,
      });
      expect(firstSaved.status()).toBe(200);
      const secondProfile = await loadProfile(secondAffiliate);
      const secondSaved = await updateOwnProfile(request, secondAffiliate.session, {
        accountHolderName: "QA Batch Affiliate B",
        accountNumber: "PL52114020040000300201355387",
        updatedAt: secondProfile.updatedAt,
      });
      expect(secondSaved.status()).toBe(200);

      const approvedEntry = await readStatusEntry(client, scope, "approved");
      const firstTransaction = await insertTransaction(client, scope, firstAffiliate, approvedEntry, "approved", 75);
      const secondTransaction = await insertTransaction(client, scope, secondAffiliate, approvedEntry, "approved", 125);
      const incompleteTransaction = await insertTransaction(client, scope, incompleteAffiliate, approvedEntry, "approved", 30);

      const incompleteResponse = await apiRequest(request, "POST", "/api/finoo_affiliates/payouts/preview", {
        token,
        data: {
          transactions: [
            { id: firstTransaction.id, updatedAt: firstTransaction.updatedAt },
            { id: incompleteTransaction.id, updatedAt: incompleteTransaction.updatedAt },
          ],
        },
      });
      expect(incompleteResponse.status()).toBe(409);
      expect(await readJsonSafe(incompleteResponse)).toMatchObject({
        error: "PAYOUT_PROFILES_INCOMPLETE",
        affiliates: [{
          affiliateId: incompleteAffiliate.affiliateId,
          missingFields: ["accountHolderName", "accountNumber"],
        }],
      });
      const preflightWrites = await client.query<{ count: string }>(
        "select count(*)::text as count from finoo_payout_previews where affiliate_id = any($1::uuid[])",
        [[firstAffiliate.affiliateId, incompleteAffiliate.affiliateId]],
      );
      expect(preflightWrites.rows[0]?.count).toBe("0");

      const readinessResponse = await apiRequest(
        request,
        "GET",
        "/api/finoo_affiliates/affiliates?page=1&pageSize=100",
        { token },
      );
      expect(readinessResponse.status()).toBe(200);
      const readiness = await readJsonSafe<{
        items: Array<{ id: string; payoutProfileComplete: boolean; accountNumber?: unknown }>;
      }>(readinessResponse);
      expect(readiness?.items.find((item) => item.id === firstAffiliate?.affiliateId)).toMatchObject({ payoutProfileComplete: true });
      expect(readiness?.items.find((item) => item.id === secondAffiliate?.affiliateId)).toMatchObject({ payoutProfileComplete: true });
      expect(readiness?.items.find((item) => item.id === incompleteAffiliate?.affiliateId)).toMatchObject({ payoutProfileComplete: false });
      expect(readiness?.items.some((item) => Object.hasOwn(item, "accountNumber"))).toBe(false);

      const makePreview = async () => {
        const response = await apiRequest(request, "POST", "/api/finoo_affiliates/payouts/preview", {
          token,
          data: {
            transactions: [
              { id: secondTransaction.id, updatedAt: secondTransaction.updatedAt },
              { id: firstTransaction.id, updatedAt: firstTransaction.updatedAt },
            ],
          },
        });
        expect(response.status()).toBe(200);
        return (await readJsonSafe<{
          batchId: string;
          affiliateCount: number;
          selectedCount: number;
          totalAmount: string;
          groups: Array<{
            affiliateId: string;
            paymentReference: string;
            affiliateUpdatedAt: string;
            amount: string;
            transactions: Array<{ id: string; updatedAt: string }>;
          }>;
        }>(response))!;
      };

      const stalePreview = await makePreview();
      expect(stalePreview).toMatchObject({ affiliateCount: 2, selectedCount: 2, totalAmount: "200" });
      expect(stalePreview.groups.map((group) => group.affiliateId)).toEqual(
        [firstAffiliate.affiliateId, secondAffiliate.affiliateId].sort(),
      );
      expect(stalePreview.groups.map((group) => group.amount).sort()).toEqual(["125", "75"]);

      const omittedGroup = await apiRequest(request, "POST", "/api/finoo_affiliates/payouts/confirm", {
        token,
        data: {
          batchId: stalePreview.batchId,
          groups: [stalePreview.groups[0]].map(({ paymentReference, affiliateUpdatedAt, transactions }) => ({ paymentReference, affiliateUpdatedAt, transactions })),
        },
      });
      expect(omittedGroup.status()).toBe(409);
      expect(await readJsonSafe(omittedGroup)).toMatchObject({ error: "PAYOUT_PREVIEW_STALE" });

      const secondGroup = stalePreview.groups.find((group) => group.affiliateId === secondAffiliate?.affiliateId)!;
      const changedProfile = await updateOwnProfile(request, secondAffiliate.session, {
        accountHolderName: "QA Batch Affiliate B Changed",
        accountNumber: "PL52114020040000300201355387",
        updatedAt: secondGroup.affiliateUpdatedAt,
      });
      expect(changedProfile.status()).toBe(200);
      const staleConfirmation = await apiRequest(request, "POST", "/api/finoo_affiliates/payouts/confirm", {
        token,
        data: { batchId: stalePreview.batchId, groups: stalePreview.groups.map(({ paymentReference, affiliateUpdatedAt, transactions }) => ({ paymentReference, affiliateUpdatedAt, transactions })) },
      });
      expect(staleConfirmation.status()).toBe(409);
      expect(await readJsonSafe(staleConfirmation)).toMatchObject({ error: "PAYOUT_PREVIEW_STALE" });
      const afterStale = await client.query<{ payout_count: string; paid_count: string }>(
        `select
          (select count(*) from finoo_affiliate_payouts where affiliate_id = any($1::uuid[]))::text as payout_count,
          (select count(*) from finoo_affiliate_transactions where id = any($2::uuid[]) and commission_status = 'paid_out')::text as paid_count`,
        [[firstAffiliate.affiliateId, secondAffiliate.affiliateId], [firstTransaction.id, secondTransaction.id]],
      );
      expect(afterStale.rows[0]).toEqual({ payout_count: "0", paid_count: "0" });

      const freshPreview = await makePreview();
      const otherPreview = await makePreview();
      const recombined = await apiRequest(request, "POST", "/api/finoo_affiliates/payouts/confirm", {
        token,
        data: {
          batchId: freshPreview.batchId,
          groups: [freshPreview.groups[0], otherPreview.groups[1]].map(({ paymentReference, affiliateUpdatedAt, transactions }) => ({ paymentReference, affiliateUpdatedAt, transactions })),
        },
      });
      expect(recombined.status()).toBe(409);
      expect(await readJsonSafe(recombined)).toMatchObject({ error: "PAYOUT_PREVIEW_STALE" });
      const confirmation = {
        batchId: freshPreview.batchId,
        groups: freshPreview.groups.map(({ paymentReference, affiliateUpdatedAt, transactions }) => ({
          paymentReference,
          affiliateUpdatedAt,
          transactions,
        })),
      };
      const confirmResponse = await apiRequest(request, "POST", "/api/finoo_affiliates/payouts/confirm", {
        token,
        data: confirmation,
      });
      expect(confirmResponse.status()).toBe(202);
      await drainIntegrationQueue(PAYOUT_QUEUE);

      const payoutRows = await client.query<{ id: string; affiliate_id: string; payment_reference: string }>(
        `select id, affiliate_id, payment_reference
         from finoo_affiliate_payouts
         where affiliate_id = any($1::uuid[])
         order by affiliate_id`,
        [[firstAffiliate.affiliateId, secondAffiliate.affiliateId]],
      );
      expect(payoutRows.rows).toHaveLength(2);
      const paidRows = await client.query<{ id: string; payout_id: string | null; commission_status: string }>(
        "select id, payout_id, commission_status from finoo_affiliate_transactions where id = any($1::uuid[]) order by id",
        [[firstTransaction.id, secondTransaction.id]],
      );
      expect(paidRows.rows.every((row) => row.commission_status === "paid_out" && row.payout_id !== null)).toBe(true);

      const exactRetry = await apiRequest(request, "POST", "/api/finoo_affiliates/payouts/confirm", {
        token,
        data: confirmation,
      });
      expect(exactRetry.status()).toBe(200);
      const exactRetryBody = await readJsonSafe<{ payoutIds: string[]; paymentReferences: string[] }>(exactRetry);
      expect(new Set(exactRetryBody?.payoutIds)).toEqual(new Set(payoutRows.rows.map((row) => row.id)));
      expect(new Set(exactRetryBody?.paymentReferences)).toEqual(new Set(payoutRows.rows.map((row) => row.payment_reference)));
    } finally {
      await cleanupAffiliateFixture(request, client, token, incompleteAffiliate);
      await cleanupAffiliateFixture(request, client, token, secondAffiliate);
      await cleanupAffiliateFixture(request, client, token, firstAffiliate);
      await client.end();
    }
  });
});
