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
import { finooDashboardRangeSchema } from "../../../data/validators";
import {
  loadFinooDashboard,
  resolveFinooAnalyticsRange,
} from "../../../lib/analytics";

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
  const series = await loadFinooDashboard(
    em,
    auth.sub,
    { tenantId: auth.tenantId, organizationId: auth.orgId },
    range,
  );
  return NextResponse.json({
    ok: true,
    range: { from: range.from, to: range.to, timezone: range.timezone },
    ...series,
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
          }),
        },
      ],
    },
  },
};
