import { z } from "zod";
import { NextResponse } from "next/server";
import { createRequestContainer } from "@open-mercato/shared/lib/di/container";
import type { OpenApiRouteDoc } from "@open-mercato/shared/lib/openapi";
import {
  getCustomerAuthFromRequest,
  requireCustomerFeature,
} from "@open-mercato/core/modules/customer_accounts/lib/customerAuth";
import type { CustomerRbacService } from "@open-mercato/core/modules/customer_accounts/services/customerRbacService";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { CommandBus } from "@open-mercato/shared/lib/commands";
import { FinooAffiliateLink, type FinooAffiliate } from "../../../data/entities";
import { findOneWithDecryption } from "@open-mercato/shared/lib/encryption/find";
import { finooDashboardRangeSchema } from "../../../data/validators";
import {
  loadFinooDashboard,
  resolveFinooAnalyticsRange,
} from "../../../lib/analytics";
import { reconcileAffiliateForUser } from "../../../lib/membership";
import { toAbsoluteUrl } from "@open-mercato/shared/lib/url";

export const metadata = { GET: { requireAuth: false } };

export async function GET(request: Request): Promise<Response> {
  const auth = await getCustomerAuthFromRequest(request);
  if (!auth)
    return NextResponse.json(
      { ok: false, error: "Authentication required" },
      { status: 401 },
    );
  const container = await createRequestContainer();
  const rbac = container.resolve("customerRbacService") as CustomerRbacService;
  try {
    await requireCustomerFeature(auth, ["portal.finoo_affiliates.view"], rbac);
  } catch (response) {
    return response as Response;
  }
  const parsed = finooDashboardRangeSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, error: "Invalid date range" },
      { status: 400 },
    );
  let range;
  try {
    range = resolveFinooAnalyticsRange(parsed.data);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid date range" },
      { status: 400 },
    );
  }
  const em = container.resolve("em") as EntityManager;
  const commandBus = container.resolve("commandBus") as CommandBus;
  const membership = await reconcileAffiliateForUser(
    em,
    auth.sub,
    { tenantId: auth.tenantId, organizationId: auth.orgId },
    async (invitationId, userId, scope) => {
      const { result } = await commandBus.execute<Record<string, unknown>, FinooAffiliate>(
        "finoo_affiliates.affiliate.activate",
        {
          input: { invitationId, userId, ...scope },
          ctx: {
            container,
            auth: null,
            organizationScope: null,
            selectedOrganizationId: scope.organizationId,
            organizationIds: [scope.organizationId],
            systemActor: true,
          },
        },
      );
      return result;
    },
  );
  if (!membership)
    return NextResponse.json(
      { ok: false, error: "Affiliate membership is not active" },
      { status: 403 },
    );
  const series = await loadFinooDashboard(
    em,
    auth.sub,
    { tenantId: auth.tenantId, organizationId: auth.orgId },
    range,
  );
  const scope = { tenantId: auth.tenantId, organizationId: auth.orgId };
  const primaryLink = membership.primaryLinkId ? await findOneWithDecryption(
    em,
    FinooAffiliateLink,
    { ...scope, id: membership.primaryLinkId, affiliateId: membership.id, isActive: true, deletedAt: null },
    undefined,
    scope,
  ) : null;
  return NextResponse.json({
    ok: true,
    range: { from: range.from, to: range.to, timezone: range.timezone },
    ...series,
    generatedLink: primaryLink ? {
      code: primaryLink.code,
      trackedUrl: toAbsoluteUrl(request, `/api/finoo_affiliates/r/${primaryLink.code}`),
    } : null,
  });
}

const weeklyCountSchema = z.object({
  weekStart: z.string().date(),
  count: z.number().int().min(0),
});

export const openApi: OpenApiRouteDoc = {
  tag: "Finoo Affiliate Portal",
  methods: {
    GET: {
      summary: "Get the signed-in affiliate dashboard series",
      query: finooDashboardRangeSchema,
      responses: [
        {
          status: 200,
          description: "Weekly affiliate metrics",
          schema: z.object({
            ok: z.literal(true),
            range: z.object({
              from: z.string().date(),
              to: z.string().date(),
              timezone: z.string(),
            }),
            leads: z.array(weeklyCountSchema),
            clicks: z.array(weeklyCountSchema),
            transactions: z.array(weeklyCountSchema),
            affiliateTransactions: z.array(weeklyCountSchema),
            totalPaidOut: z.string().regex(/^\d+$/),
            pendingPayout: z.string().regex(/^\d+$/),
            currency: z.literal("PLN"),
            generatedLink: z.object({ code: z.string(), trackedUrl: z.string().url() }).nullable(),
          }),
        },
      ],
    },
  },
};
