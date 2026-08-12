import { z } from "zod";
import { NextResponse } from "next/server";
import { getAuthFromRequest } from "@open-mercato/shared/lib/auth/server";
import { createRequestContainer } from "@open-mercato/shared/lib/di/container";
import type { OpenApiRouteDoc } from "@open-mercato/shared/lib/openapi";
import { resolveOrganizationScopeForRequest } from "@open-mercato/core/modules/directory/utils/organizationScope";
import type { FinooAffiliateService } from "../../lib/service";

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ["finoo_affiliates.view"] },
};

export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request);
  if (!auth?.tenantId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const container = await createRequestContainer();
  const organizationScope = await resolveOrganizationScopeForRequest({
    container,
    auth,
    request,
  });
  const organizationId = organizationScope.selectedId ?? auth.orgId;
  if (!organizationId)
    return NextResponse.json(
      { error: "Organization is required" },
      { status: 400 },
    );
  const service = container.resolve(
    "finooAffiliateService",
  ) as FinooAffiliateService;
  const users = await service.listAffiliateUsers({
    tenantId: auth.tenantId,
    organizationId,
  });
  return NextResponse.json({
    items: users.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
    })),
  });
}

export const openApi: OpenApiRouteDoc = {
  tag: "Finoo Affiliates",
  methods: {
    GET: {
      summary: "List portal users assigned to the affiliate role",
      responses: [
        {
          status: 200,
          description: "Affiliate portal users",
          schema: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                displayName: z.string(),
                email: z.string().email(),
              }),
            ),
          }),
        },
      ],
    },
  },
};
