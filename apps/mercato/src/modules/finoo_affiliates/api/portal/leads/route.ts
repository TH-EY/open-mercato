import { z } from "zod";
import { NextResponse } from "next/server";
import type { EntityManager, QueryOrderMap } from "@mikro-orm/postgresql";
import { createRequestContainer } from "@open-mercato/shared/lib/di/container";
import type { OpenApiRouteDoc } from "@open-mercato/shared/lib/openapi";
import { findWithDecryption } from "@open-mercato/shared/lib/encryption/find";
import {
  getCustomerAuthFromRequest,
  requireCustomerFeature,
} from "@open-mercato/core/modules/customer_accounts/lib/customerAuth";
import type { CustomerRbacService } from "@open-mercato/core/modules/customer_accounts/services/customerRbacService";
import { FinooDealAttribution } from "../../../data/entities";
import { finooPortalLeadsQuerySchema } from "../../../data/validators";

export const metadata = { GET: { requireAuth: false } };

function resolveOrderBy(
  input: z.infer<typeof finooPortalLeadsQuerySchema>,
): QueryOrderMap<FinooDealAttribution> {
  const direction = input.sortDir === "asc" ? "ASC" : "DESC";
  if (input.sortField === "commissionAmount")
    return { commissionAmount: direction };
  if (input.sortField === "commissionStatus")
    return { commissionStatus: direction };
  return { leadAt: direction };
}

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
  const parsed = finooPortalLeadsQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, error: "Invalid query" },
      { status: 400 },
    );
  const em = container.resolve("em") as EntityManager;
  const where = {
    tenantId: auth.tenantId,
    organizationId: auth.orgId,
    affiliateUserId: auth.sub,
    deletedAt: null,
  };
  const [items, total] = await Promise.all([
    findWithDecryption(
      em,
      FinooDealAttribution,
      where,
      {
        orderBy: resolveOrderBy(parsed.data),
        limit: parsed.data.pageSize,
        offset: (parsed.data.page - 1) * parsed.data.pageSize,
      },
      { tenantId: auth.tenantId, organizationId: auth.orgId },
    ),
    em.count(FinooDealAttribution, where),
  ]);
  return NextResponse.json({
    ok: true,
    items: items.map((item) => ({
      id: item.id,
      dealId: item.dealId,
      companyName: item.companyName ?? null,
      landingPage: item.landingPage ?? null,
      initialReferrer: item.initialReferrer ?? null,
      commissionStatus: item.commissionStatus,
      commissionAmount: item.commissionAmount,
      leadAt: item.leadAt.toISOString(),
    })),
    total,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  });
}

const leadSchema = z.object({
  id: z.string().uuid(),
  dealId: z.string().uuid(),
  companyName: z.string().nullable(),
  landingPage: z.string().nullable(),
  initialReferrer: z.string().nullable(),
  commissionStatus: z.enum(["approved", "waiting", "rejected"]),
  commissionAmount: z.number().int(),
  leadAt: z.string().datetime(),
});

export const openApi: OpenApiRouteDoc = {
  tag: "Finoo Affiliate Portal",
  methods: {
    GET: {
      summary: "List Deals attributed to the signed-in affiliate",
      query: finooPortalLeadsQuerySchema,
      responses: [
        {
          status: 200,
          description: "Affiliate leads",
          schema: z.object({
            ok: z.literal(true),
            items: z.array(leadSchema),
            total: z.number(),
            page: z.number(),
            pageSize: z.number(),
          }),
        },
      ],
    },
  },
};
