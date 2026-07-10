import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import {
  apiRequest,
  getAuthToken,
} from "@open-mercato/core/helpers/integration/api";
import {
  createRoleFixture,
  createUserFixture,
} from "@open-mercato/core/helpers/integration/authFixtures";
import {
  createCompanyFixture,
  createDealFixture,
  createPipelineFixture,
  createPipelineStageFixture,
} from "@open-mercato/core/helpers/integration/crmFixtures";
import {
  createCustomerRoleFixture,
  createCustomerUserFixture,
  portalCookieHeaders,
  portalLogin,
  uniqueSuffix,
  type PortalSession,
} from "@open-mercato/core/helpers/integration/customerAccountsFixtures";
import {
  createAvailabilityRuleFixture,
  createAvailabilityRuleSetFixture,
} from "@open-mercato/core/helpers/integration/plannerFixtures";
import { assertScalarFieldsPersisted } from "@open-mercato/core/helpers/integration/crudFormPersistence";
import {
  expectId,
  getTokenContext,
  readJsonSafe,
} from "@open-mercato/core/helpers/integration/generalFixtures";

const SURVEY_BOOKING_PATH = "/api/epc/portal/survey-booking";
const JSON_HEADERS = { "Content-Type": "application/json" };
const SURVEY_SOURCE = "epc_demo:survey_booking";
const OPTIMISTIC_LOCK_HEADER = "x-om-ext-optimistic-lock-expected-updated-at";

type BookingSlot = {
  id: string;
  startsAt: string;
  endsAt: string;
  label: string;
};

type BookingRecord = {
  id: string;
  dealId: string;
  scheduledAt: string;
  endsAt: string;
  durationMinutes: number;
  status: string;
  updatedAt: string;
};

type BookingState = {
  ok: true;
  canBook: boolean;
  reason: string;
  durationMinutes: number;
  deals: Array<{
    id: string;
    title: string;
    stageName: string;
    bookedSurvey: BookingRecord | null;
  }>;
  slots: BookingSlot[];
};

type BookingPostResponse = {
  ok: true;
  booking: BookingRecord;
  state: BookingState;
};

type InteractionRecord = Record<string, unknown> & {
  id: string;
  source?: string | null;
  status?: string | null;
  participants?: Array<Record<string, unknown>> | null;
  linkedEntities?: Array<Record<string, unknown>> | null;
  guestPermissions?: Record<string, unknown> | null;
  updatedAt?: string | null;
};

type TimeWindow = {
  start: Date;
  end: Date;
};

type CleanupDelete = {
  label: string;
  path: string;
  data?: { id: string };
};

type Fixtures = {
  interactionId: string | null;
  concurrencyInteractionIds: string[];
  busyInteractionId: string | null;
  participantBusyInteractionId: string | null;
  allDayBusyInteractionId: string | null;
  dealAId: string | null;
  dealBId: string | null;
  nonSurveyDealId: string | null;
  customerAUserId: string | null;
  customerBUserId: string | null;
  noFeatureCustomerUserId: string | null;
  unlinkedCustomerUserId: string | null;
  bookingCustomerRoleId: string | null;
  noFeatureCustomerRoleId: string | null;
  primaryAvailabilityRuleId: string | null;
  additionalAvailabilityRuleId: string | null;
  secondaryAvailabilityRuleId: string | null;
  nonSurveyorAvailabilityRuleId: string | null;
  primaryAvailabilityRuleSetId: string | null;
  additionalAvailabilityRuleSetId: string | null;
  secondaryAvailabilityRuleSetId: string | null;
  nonSurveyorAvailabilityRuleSetId: string | null;
  primaryStaffMemberId: string | null;
  additionalStaffMemberId: string | null;
  secondaryStaffMemberId: string | null;
  noAvailabilityStaffMemberId: string | null;
  nonSurveyorStaffMemberId: string | null;
  primarySurveyorUserId: string | null;
  secondarySurveyorUserId: string | null;
  noAvailabilitySurveyorUserId: string | null;
  nonSurveyorUserId: string | null;
  surveyorRoleId: string | null;
  companyAId: string | null;
  companyBId: string | null;
  surveyStageId: string | null;
  nonSurveyStageId: string | null;
  pipelineId: string | null;
};

function emptyFixtures(): Fixtures {
  return {
    interactionId: null,
    concurrencyInteractionIds: [],
    busyInteractionId: null,
    participantBusyInteractionId: null,
    allDayBusyInteractionId: null,
    dealAId: null,
    dealBId: null,
    nonSurveyDealId: null,
    customerAUserId: null,
    customerBUserId: null,
    noFeatureCustomerUserId: null,
    unlinkedCustomerUserId: null,
    bookingCustomerRoleId: null,
    noFeatureCustomerRoleId: null,
    primaryAvailabilityRuleId: null,
    additionalAvailabilityRuleId: null,
    secondaryAvailabilityRuleId: null,
    nonSurveyorAvailabilityRuleId: null,
    primaryAvailabilityRuleSetId: null,
    additionalAvailabilityRuleSetId: null,
    secondaryAvailabilityRuleSetId: null,
    nonSurveyorAvailabilityRuleSetId: null,
    primaryStaffMemberId: null,
    additionalStaffMemberId: null,
    secondaryStaffMemberId: null,
    noAvailabilityStaffMemberId: null,
    nonSurveyorStaffMemberId: null,
    primarySurveyorUserId: null,
    secondarySurveyorUserId: null,
    noAvailabilitySurveyorUserId: null,
    nonSurveyorUserId: null,
    surveyorRoleId: null,
    companyAId: null,
    companyBId: null,
    surveyStageId: null,
    nonSurveyStageId: null,
    pipelineId: null,
  };
}

async function createStaffMember(
  request: APIRequestContext,
  token: string,
  input: {
    displayName: string;
    userId: string;
    availabilityRuleSetId?: string | null;
  },
): Promise<string> {
  const response = await apiRequest(
    request,
    "POST",
    "/api/staff/team-members",
    {
      token,
      data: { ...input, isActive: true },
    },
  );
  const body = await readJsonSafe<{ id?: string }>(response);
  expect(
    response.status(),
    "POST /api/staff/team-members should return 201",
  ).toBe(201);
  return expectId(body?.id, "Staff member creation response should include id");
}

async function assignAvailabilityRuleSet(
  request: APIRequestContext,
  token: string,
  staffMemberId: string,
  availabilityRuleSetId: string,
): Promise<void> {
  const response = await apiRequest(request, "PUT", "/api/staff/team-members", {
    token,
    data: { id: staffMemberId, availabilityRuleSetId },
  });
  expect(
    response.status(),
    "PUT /api/staff/team-members should return 200",
  ).toBe(200);
}

async function createBusyInteraction(
  request: APIRequestContext,
  token: string,
  input: {
    companyId: string;
    ownerUserId: string;
    participant?: {
      userId: string;
      name: string;
    };
    scheduledAt: string;
    durationMinutes?: number;
    allDay?: boolean;
    recurrenceRule?: string;
    recurrenceEnd?: string;
    suffix: string;
    label: string;
  },
): Promise<string> {
  const response = await apiRequest(
    request,
    "POST",
    "/api/customers/interactions",
    {
      token,
      data: {
        entityId: input.companyId,
        interactionType: "event",
        title: `EPC ${input.label} ${input.suffix}`,
        status: "planned",
        scheduledAt: input.scheduledAt,
        durationMinutes: input.durationMinutes ?? 60,
        ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
        ...(input.recurrenceRule
          ? { recurrenceRule: input.recurrenceRule }
          : {}),
        ...(input.recurrenceEnd ? { recurrenceEnd: input.recurrenceEnd } : {}),
        ownerUserId: input.ownerUserId,
        ...(input.participant
          ? {
              participants: [
                {
                  userId: input.participant.userId,
                  name: input.participant.name,
                  status: "accepted",
                },
              ],
            }
          : {}),
      },
    },
  );
  const body = await readJsonSafe<{ id?: string }>(response);
  expect(
    response.status(),
    `POST /api/customers/interactions ${input.label} fixture should return 201`,
  ).toBe(201);
  return expectId(
    body?.id,
    `${input.label} interaction creation response should include id`,
  );
}

function futureUtcWindow(
  dayOffset: number,
  startHour: number,
  durationMinutes: number,
): TimeWindow {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + dayOffset);
  start.setUTCHours(startHour, 0, 0, 0);
  return {
    start,
    end: new Date(start.getTime() + durationMinutes * 60_000),
  };
}

function plannerRRule(window: TimeWindow): string {
  const stamp = window.start
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const durationMinutes = Math.round(
    (window.end.getTime() - window.start.getTime()) / 60_000,
  );
  return `DTSTART:${stamp}\nDURATION:PT${durationMinutes}M\nRRULE:FREQ=WEEKLY;COUNT=1`;
}

async function getBookingState(
  request: APIRequestContext,
  session: PortalSession,
  label: string,
): Promise<BookingState> {
  const response = await request.get(SURVEY_BOOKING_PATH, {
    headers: portalCookieHeaders(session),
  });
  const body = await readJsonSafe<BookingState>(response);
  expect(response.status(), `${label} should return 200`).toBe(200);
  expect(body, `${label} should return a JSON state`).toBeTruthy();
  return body as BookingState;
}

async function postBooking(
  request: APIRequestContext,
  session: PortalSession,
  data: { dealId: string; slotId: string },
  expectedUpdatedAt?: string,
) {
  return request.post(SURVEY_BOOKING_PATH, {
    headers: portalCookieHeaders(session, {
      ...JSON_HEADERS,
      ...(expectedUpdatedAt
        ? { [OPTIMISTIC_LOCK_HEADER]: expectedUpdatedAt }
        : {}),
    }),
    data,
  });
}

async function deleteInteractionNow(
  request: APIRequestContext,
  token: string,
  interactionId: string,
  label: string,
): Promise<void> {
  const response = await apiRequest(
    request,
    "DELETE",
    `/api/customers/interactions?id=${encodeURIComponent(interactionId)}`,
    { token },
  );
  expect(response.status(), `${label} should delete cleanly`).toBeLessThan(300);
}

async function listDealInteractions(
  request: APIRequestContext,
  token: string,
  dealId: string,
): Promise<InteractionRecord[]> {
  const response = await apiRequest(
    request,
    "GET",
    `/api/customers/interactions?dealId=${encodeURIComponent(dealId)}&pageSize=100`,
    { token },
  );
  const body = await readJsonSafe<{ items?: InteractionRecord[] }>(response);
  expect(
    response.status(),
    "GET /api/customers/interactions should return 200",
  ).toBe(200);
  expect(
    Array.isArray(body?.items),
    "GET /api/customers/interactions should return an items array",
  ).toBe(true);
  if (!Array.isArray(body?.items)) {
    throw new Error(
      "GET /api/customers/interactions returned 200 without an items array",
    );
  }
  return body.items;
}

async function cleanupDelete(
  request: APIRequestContext,
  token: string | null,
  failures: string[],
  cleanup: CleanupDelete,
): Promise<void> {
  if (!token) return;

  try {
    const response = await apiRequest(request, "DELETE", cleanup.path, {
      token,
      ...(cleanup.data ? { data: cleanup.data } : {}),
    });
    const status = response.status();
    if ((status >= 200 && status < 300) || status === 404) return;

    const responseBody = await response
      .text()
      .catch(() => "<response body unavailable>");
    failures.push(
      `${cleanup.label}: DELETE ${cleanup.path} returned ${status}: ${responseBody}`,
    );
  } catch (error) {
    failures.push(
      `${cleanup.label}: DELETE ${cleanup.path} threw ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function cleanupQueryDelete(
  request: APIRequestContext,
  token: string | null,
  failures: string[],
  label: string,
  path: string,
  id: string | null,
): Promise<void> {
  if (!id) return;
  await cleanupDelete(request, token, failures, {
    label,
    path: `${path}?id=${encodeURIComponent(id)}`,
  });
}

async function cleanupPathDelete(
  request: APIRequestContext,
  token: string | null,
  failures: string[],
  label: string,
  path: string,
  id: string | null,
): Promise<void> {
  if (!id) return;
  await cleanupDelete(request, token, failures, {
    label,
    path: `${path}/${encodeURIComponent(id)}`,
  });
}

async function cleanupCustomerUser(
  request: APIRequestContext,
  token: string | null,
  failures: string[],
  label: string,
  id: string | null,
): Promise<void> {
  if (!token || !id) return;
  const path = `/api/customer_accounts/admin/users/${encodeURIComponent(id)}`;

  try {
    const response = await apiRequest(request, "PUT", path, {
      token,
      data: { roleIds: [] },
    });
    const status = response.status();
    if (!((status >= 200 && status < 300) || status === 404)) {
      const responseBody = await response
        .text()
        .catch(() => "<response body unavailable>");
      failures.push(
        `${label} role unassignment: PUT ${path} returned ${status}: ${responseBody}`,
      );
    }
  } catch (error) {
    failures.push(
      `${label} role unassignment: PUT ${path} threw ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await cleanupPathDelete(
    request,
    token,
    failures,
    label,
    "/api/customer_accounts/admin/users",
    id,
  );
}

async function cleanupBodyDelete(
  request: APIRequestContext,
  token: string | null,
  failures: string[],
  label: string,
  path: string,
  id: string | null,
): Promise<void> {
  if (!id) return;
  await cleanupDelete(request, token, failures, {
    label,
    path,
    data: { id },
  });
}

function assertSurveyInteraction(
  interaction: InteractionRecord,
  expected: {
    id: string;
    tenantId: string;
    organizationId: string;
    companyId: string;
    dealId: string;
    dealTitle: string;
    scheduledAt: string;
    surveyorUserId: string;
    surveyorName: string;
    customerDisplayName: string;
    customerEmail: string;
  },
  label: string,
): void {
  assertScalarFieldsPersisted(
    interaction,
    {
      id: expected.id,
      tenantId: expected.tenantId,
      organizationId: expected.organizationId,
      entityId: expected.companyId,
      dealId: expected.dealId,
      interactionType: "event",
      title: `Survey appointment - ${expected.dealTitle}`,
      body: [
        "EPC_SURVEY_BOOKING",
        `Booked from the customer portal by ${expected.customerDisplayName}.`,
        `Customer email: ${expected.customerEmail}`,
      ].join("\n"),
      status: "planned",
      scheduledAt: expected.scheduledAt,
      durationMinutes: 60,
      ownerUserId: expected.surveyorUserId,
      authorUserId: expected.surveyorUserId,
      source: SURVEY_SOURCE,
      appearanceIcon: "lucide:calendar-check",
      appearanceColor: "#2563eb",
      location: "Customer site",
      allDay: false,
      visibility: "team",
      reminderMinutes: 60,
    },
    label,
  );

  expect(
    interaction.participants,
    `${label}.participants should contain only the Surveyor`,
  ).toHaveLength(1);
  expect(interaction.participants).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        userId: expected.surveyorUserId,
        name: expected.surveyorName,
        status: "accepted",
      }),
    ]),
  );
  expect(
    interaction.linkedEntities,
    `${label}.linkedEntities should contain only the deal`,
  ).toHaveLength(1);
  expect(interaction.linkedEntities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: expected.dealId,
        type: "deal",
        label: expected.dealTitle,
      }),
    ]),
  );
  expect(interaction.guestPermissions).toEqual({
    canInviteOthers: false,
    canModify: false,
    canSeeList: false,
  });
  expect(
    typeof interaction.updatedAt,
    `${label}.updatedAt should be returned`,
  ).toBe("string");
}

test.describe("TC-EPC-SURVEY-001: self-contained survey booking round trip", () => {
  test("enforces eligibility and persists one canonical booking through reschedule", async ({
    request,
  }, testInfo) => {
    const adminToken = await getAuthToken(request, "admin");
    const { organizationId, tenantId } = getTokenContext(adminToken);
    const suffix = uniqueSuffix();
    const surveyorName = `EPC Surveyor ${suffix}`;
    const secondarySurveyorName = `EPC Secondary Surveyor ${suffix}`;
    const dealATitle = `EPC Survey Deal A ${suffix}`;
    const fixtures = emptyFixtures();
    let testError: unknown;
    let testFailed = false;

    try {
      const surveyorRoleId = await createRoleFixture(request, adminToken, {
        name: "Surveyor",
        tenantId,
      });
      fixtures.surveyorRoleId = surveyorRoleId;

      const primarySurveyorUserId = await createUserFixture(
        request,
        adminToken,
        {
          email: `epc-surveyor-${suffix}@test.local`,
          password: `Surveyor-Aa1!-${suffix}`,
          organizationId,
          roles: [surveyorRoleId],
          name: surveyorName,
        },
      );
      fixtures.primarySurveyorUserId = primarySurveyorUserId;
      const primaryStaffMemberId = await createStaffMember(
        request,
        adminToken,
        {
          displayName: surveyorName,
          userId: primarySurveyorUserId,
        },
      );
      fixtures.primaryStaffMemberId = primaryStaffMemberId;

      const bookingRole = await createCustomerRoleFixture(request, adminToken, {
        name: `EPC Survey Customer ${suffix}`,
        slug: `epc-survey-customer-${suffix}`,
        features: ["portal.survey.book"],
      });
      fixtures.bookingCustomerRoleId = bookingRole.id;
      const noFeatureRole = await createCustomerRoleFixture(
        request,
        adminToken,
        {
          name: `EPC Survey No Feature ${suffix}`,
          slug: `epc-survey-no-feature-${suffix}`,
          features: [],
        },
      );
      fixtures.noFeatureCustomerRoleId = noFeatureRole.id;

      const companyAId = await createCompanyFixture(
        request,
        adminToken,
        `EPC Customer A ${suffix}`,
      );
      fixtures.companyAId = companyAId;
      const customerA = await createCustomerUserFixture(request, adminToken, {
        displayName: `EPC Customer A ${suffix}`,
        roleIds: [bookingRole.id],
        customerEntityId: companyAId,
      });
      fixtures.customerAUserId = customerA.id;
      const noFeatureCustomer = await createCustomerUserFixture(
        request,
        adminToken,
        {
          displayName: `EPC Customer No Feature ${suffix}`,
          roleIds: [noFeatureRole.id],
          customerEntityId: companyAId,
        },
      );
      fixtures.noFeatureCustomerUserId = noFeatureCustomer.id;
      const unlinkedCustomer = await createCustomerUserFixture(
        request,
        adminToken,
        {
          displayName: `EPC Customer Unlinked ${suffix}`,
          roleIds: [bookingRole.id],
          customerEntityId: null,
        },
      );
      fixtures.unlinkedCustomerUserId = unlinkedCustomer.id;

      const pipelineId = await createPipelineFixture(request, adminToken, {
        name: `EPC Survey Pipeline ${suffix}`,
      });
      fixtures.pipelineId = pipelineId;
      const surveyStageId = await createPipelineStageFixture(
        request,
        adminToken,
        {
          pipelineId,
          label: "Survey",
          order: 0,
        },
      );
      fixtures.surveyStageId = surveyStageId;
      const nonSurveyStageId = await createPipelineStageFixture(
        request,
        adminToken,
        {
          pipelineId,
          label: `Qualification ${suffix}`,
          order: 1,
        },
      );
      fixtures.nonSurveyStageId = nonSurveyStageId;
      const dealAId = await createDealFixture(request, adminToken, {
        title: dealATitle,
        companyIds: [companyAId],
        pipelineId,
        pipelineStageId: surveyStageId,
        status: "open",
      });
      fixtures.dealAId = dealAId;
      const nonSurveyDealId = await createDealFixture(request, adminToken, {
        title: `EPC Non-Survey Deal ${suffix}`,
        companyIds: [companyAId],
        pipelineId,
        pipelineStageId: nonSurveyStageId,
        status: "open",
      });
      fixtures.nonSurveyDealId = nonSurveyDealId;

      const anonymousContext = await playwrightRequest.newContext({
        baseURL: process.env.BASE_URL?.trim() || "http://localhost:3000",
      });
      try {
        const anonymous = await anonymousContext.get(SURVEY_BOOKING_PATH);
        expect(
          anonymous.status(),
          "anonymous survey state should be rejected",
        ).toBe(401);
      } finally {
        await anonymousContext.dispose();
      }

      const customerASession = await portalLogin(request, {
        email: customerA.email,
        password: customerA.password,
        tenantId,
      });
      const noFeatureSession = await portalLogin(request, {
        email: noFeatureCustomer.email,
        password: noFeatureCustomer.password,
        tenantId,
      });
      const unlinkedSession = await portalLogin(request, {
        email: unlinkedCustomer.email,
        password: unlinkedCustomer.password,
        tenantId,
      });

      const noFeature = await request.get(SURVEY_BOOKING_PATH, {
        headers: portalCookieHeaders(noFeatureSession),
      });
      expect(
        noFeature.status(),
        "portal user without portal.survey.book should be rejected",
      ).toBe(403);

      const unlinkedState = await getBookingState(
        request,
        unlinkedSession,
        "unlinked customer survey state",
      );
      expect(unlinkedState.deals).toEqual([]);

      const noAvailabilityState = await getBookingState(
        request,
        customerASession,
        "customer A survey state without Surveyor availability",
      );
      expect(noAvailabilityState.reason).toBe("no_slots");
      expect(noAvailabilityState.slots).toEqual([]);
      expect(noAvailabilityState.deals.map((deal) => deal.id)).toEqual([
        dealAId,
      ]);

      const primaryWindow = futureUtcWindow(2, 10, 360);
      const primaryAvailabilityRuleSetId =
        await createAvailabilityRuleSetFixture(request, adminToken, {
          name: `EPC Surveyor Schedule ${suffix}`,
          timezone: "UTC",
        });
      fixtures.primaryAvailabilityRuleSetId = primaryAvailabilityRuleSetId;
      await assignAvailabilityRuleSet(
        request,
        adminToken,
        primaryStaffMemberId,
        primaryAvailabilityRuleSetId,
      );
      fixtures.primaryAvailabilityRuleId = await createAvailabilityRuleFixture(
        request,
        adminToken,
        {
          subjectType: "ruleset",
          subjectId: primaryAvailabilityRuleSetId,
          timezone: "UTC",
          rrule: plannerRRule(primaryWindow),
          kind: "availability",
          note: `EPC primary Surveyor window ${suffix}`,
        },
      );

      const additionalWindow = futureUtcWindow(3, 8, 120);
      const additionalAvailabilityRuleSetId =
        await createAvailabilityRuleSetFixture(request, adminToken, {
          name: `EPC Surveyor Additional Schedule ${suffix}`,
          timezone: "UTC",
        });
      fixtures.additionalAvailabilityRuleSetId =
        additionalAvailabilityRuleSetId;
      fixtures.additionalStaffMemberId = await createStaffMember(
        request,
        adminToken,
        {
          displayName: `${surveyorName} Additional Ref`,
          userId: primarySurveyorUserId,
          availabilityRuleSetId: additionalAvailabilityRuleSetId,
        },
      );
      fixtures.additionalAvailabilityRuleId =
        await createAvailabilityRuleFixture(request, adminToken, {
          subjectType: "ruleset",
          subjectId: additionalAvailabilityRuleSetId,
          timezone: "UTC",
          rrule: plannerRRule(additionalWindow),
          kind: "availability",
          note: `EPC primary Surveyor additional ref window ${suffix}`,
        });

      const noAvailabilitySurveyorUserId = await createUserFixture(
        request,
        adminToken,
        {
          email: `epc-surveyor-no-availability-${suffix}@test.local`,
          password: `NoAvailability-Aa1!-${suffix}`,
          organizationId,
          roles: [surveyorRoleId],
          name: `EPC Surveyor No Availability ${suffix}`,
        },
      );
      fixtures.noAvailabilitySurveyorUserId = noAvailabilitySurveyorUserId;
      fixtures.noAvailabilityStaffMemberId = await createStaffMember(
        request,
        adminToken,
        {
          displayName: `EPC Surveyor No Availability ${suffix}`,
          userId: noAvailabilitySurveyorUserId,
        },
      );

      const nonSurveyorWindow = futureUtcWindow(3, 15, 60);
      const nonSurveyorAvailabilityRuleSetId =
        await createAvailabilityRuleSetFixture(request, adminToken, {
          name: `EPC Non-Surveyor Schedule ${suffix}`,
          timezone: "UTC",
        });
      fixtures.nonSurveyorAvailabilityRuleSetId =
        nonSurveyorAvailabilityRuleSetId;
      const nonSurveyorUserId = await createUserFixture(request, adminToken, {
        email: `epc-non-surveyor-${suffix}@test.local`,
        password: `NonSurveyor-Aa1!-${suffix}`,
        organizationId,
        roles: [],
        name: `EPC Non-Surveyor ${suffix}`,
      });
      fixtures.nonSurveyorUserId = nonSurveyorUserId;
      fixtures.nonSurveyorStaffMemberId = await createStaffMember(
        request,
        adminToken,
        {
          displayName: `EPC Non-Surveyor ${suffix}`,
          userId: nonSurveyorUserId,
          availabilityRuleSetId: nonSurveyorAvailabilityRuleSetId,
        },
      );
      fixtures.nonSurveyorAvailabilityRuleId =
        await createAvailabilityRuleFixture(request, adminToken, {
          subjectType: "ruleset",
          subjectId: nonSurveyorAvailabilityRuleSetId,
          timezone: "UTC",
          rrule: plannerRRule(nonSurveyorWindow),
          kind: "availability",
          note: `EPC non-Surveyor window ${suffix}`,
        });

      const companyBId = await createCompanyFixture(
        request,
        adminToken,
        `EPC Customer B ${suffix}`,
      );
      fixtures.companyBId = companyBId;
      const dealBId = await createDealFixture(request, adminToken, {
        title: `EPC Survey Deal B ${suffix}`,
        companyIds: [companyBId],
        pipelineId,
        pipelineStageId: surveyStageId,
        status: "open",
      });
      fixtures.dealBId = dealBId;
      const customerB = await createCustomerUserFixture(request, adminToken, {
        displayName: `EPC Customer B ${suffix}`,
        roleIds: [bookingRole.id],
        customerEntityId: companyBId,
      });
      fixtures.customerBUserId = customerB.id;
      const customerBSession = await portalLogin(request, {
        email: customerB.email,
        password: customerB.password,
        tenantId,
      });

      const customerAState = await getBookingState(
        request,
        customerASession,
        "customer A ready survey state",
      );
      expect(customerAState.reason).toBe("ready");
      expect(customerAState.durationMinutes).toBe(60);
      expect(customerAState.deals.map((deal) => deal.id)).toEqual([dealAId]);
      expect(customerAState.deals.some((deal) => deal.id === dealBId)).toBe(
        false,
      );
      expect(
        customerAState.deals.some((deal) => deal.id === nonSurveyDealId),
      ).toBe(false);
      expect(
        customerAState.slots.length,
        "primary Surveyor window should expose reschedule choices",
      ).toBeGreaterThan(1);
      expect(
        customerAState.slots.every((slot) => {
          const startsAt = new Date(slot.startsAt).getTime();
          const endsAt = new Date(slot.endsAt).getTime();
          const inPrimaryWindow =
            startsAt >= primaryWindow.start.getTime() &&
            endsAt <= primaryWindow.end.getTime();
          const inAdditionalWindow =
            startsAt >= additionalWindow.start.getTime() &&
            endsAt <= additionalWindow.end.getTime();
          return inPrimaryWindow || inAdditionalWindow;
        }),
        "every exposed slot should stay inside availability from either active staff reference",
      ).toBe(true);
      expect(
        customerAState.slots.some((slot) => {
          const startsAt = new Date(slot.startsAt).getTime();
          const endsAt = new Date(slot.endsAt).getTime();
          return (
            startsAt >= additionalWindow.start.getTime() &&
            endsAt <= additionalWindow.end.getTime()
          );
        }),
        "the same Surveyor should receive availability from the additional staff reference",
      ).toBe(true);
      expect(
        new Set(customerAState.slots.map((slot) => slot.startsAt)).size,
      ).toBe(customerAState.slots.length);
      expect(
        customerAState.slots.some((slot) => {
          const startsAt = new Date(slot.startsAt).getTime();
          return (
            startsAt >= nonSurveyorWindow.start.getTime() &&
            startsAt < nonSurveyorWindow.end.getTime()
          );
        }),
        "the non-Surveyor unique availability window should not contribute slots",
      ).toBe(false);

      const busySlot = customerAState.slots[0];
      const recurringBase = new Date(busySlot.startsAt);
      recurringBase.setUTCDate(recurringBase.getUTCDate() - 7);
      fixtures.busyInteractionId = await createBusyInteraction(
        request,
        adminToken,
        {
          companyId: companyAId,
          ownerUserId: primarySurveyorUserId,
          scheduledAt: recurringBase.toISOString(),
          recurrenceRule: "FREQ=WEEKLY;COUNT=2",
          recurrenceEnd: busySlot.startsAt,
          suffix,
          label: "Surveyor Recurring Owner Busy Event",
        },
      );

      const stateAfterBusyEvent = await getBookingState(
        request,
        customerASession,
        "customer A survey state after Surveyor busy event",
      );
      expect(
        stateAfterBusyEvent.slots.some(
          (slot) => slot.startsAt === busySlot.startsAt,
        ),
        "a recurring event based before the booking range should remove its in-range Surveyor occurrence",
      ).toBe(false);
      expect(
        stateAfterBusyEvent.slots.length,
        "the explicit window should retain slots outside the busy event",
      ).toBeGreaterThan(1);

      const participantBusySlot = stateAfterBusyEvent.slots[0];
      fixtures.participantBusyInteractionId = await createBusyInteraction(
        request,
        adminToken,
        {
          companyId: companyAId,
          ownerUserId: nonSurveyorUserId,
          participant: {
            userId: primarySurveyorUserId,
            name: surveyorName,
          },
          scheduledAt: participantBusySlot.startsAt,
          suffix,
          label: "Surveyor Participant Busy Event",
        },
      );

      const stateAfterParticipantBusyEvent = await getBookingState(
        request,
        customerASession,
        "customer A survey state after Surveyor participant busy event",
      );
      expect(
        stateAfterParticipantBusyEvent.slots.some(
          (slot) => slot.startsAt === participantBusySlot.startsAt,
        ),
        "an event owned by another user should block its accepted Surveyor participant",
      ).toBe(false);
      expect(
        stateAfterParticipantBusyEvent.slots.length,
        "the primary explicit window should retain a slot after both busy events",
      ).toBeGreaterThan(0);

      fixtures.allDayBusyInteractionId = await createBusyInteraction(
        request,
        adminToken,
        {
          companyId: companyAId,
          ownerUserId: primarySurveyorUserId,
          scheduledAt: primaryWindow.start.toISOString(),
          allDay: true,
          suffix,
          label: "Surveyor All-Day Busy Event",
        },
      );
      const stateAfterAllDayBusyEvent = await getBookingState(
        request,
        customerASession,
        "customer A survey state after Surveyor all-day event",
      );
      expect(
        stateAfterAllDayBusyEvent.slots.some((slot) => {
          const startsAt = new Date(slot.startsAt).getTime();
          return (
            startsAt >= primaryWindow.start.getTime() &&
            startsAt < primaryWindow.end.getTime()
          );
        }),
        "an all-day Surveyor event should remove every overlapping slot on that calendar day",
      ).toBe(false);

      await deleteInteractionNow(
        request,
        adminToken,
        fixtures.allDayBusyInteractionId,
        "all-day busy fixture",
      );
      fixtures.allDayBusyInteractionId = null;
      await deleteInteractionNow(
        request,
        adminToken,
        fixtures.participantBusyInteractionId,
        "participant busy fixture",
      );
      fixtures.participantBusyInteractionId = null;
      await deleteInteractionNow(
        request,
        adminToken,
        fixtures.busyInteractionId,
        "recurring busy fixture",
      );
      fixtures.busyInteractionId = null;

      const secondaryWindow = futureUtcWindow(4, 13, 180);
      const secondaryAvailabilityRuleSetId =
        await createAvailabilityRuleSetFixture(request, adminToken, {
          name: `EPC Secondary Surveyor Schedule ${suffix}`,
          timezone: "UTC",
        });
      fixtures.secondaryAvailabilityRuleSetId = secondaryAvailabilityRuleSetId;
      const secondarySurveyorUserId = await createUserFixture(
        request,
        adminToken,
        {
          email: `epc-secondary-surveyor-${suffix}@test.local`,
          password: `SecondarySurveyor-Aa1!-${suffix}`,
          organizationId,
          roles: [surveyorRoleId],
          name: secondarySurveyorName,
        },
      );
      fixtures.secondarySurveyorUserId = secondarySurveyorUserId;
      fixtures.secondaryStaffMemberId = await createStaffMember(
        request,
        adminToken,
        {
          displayName: secondarySurveyorName,
          userId: secondarySurveyorUserId,
          availabilityRuleSetId: secondaryAvailabilityRuleSetId,
        },
      );
      fixtures.secondaryAvailabilityRuleId =
        await createAvailabilityRuleFixture(request, adminToken, {
          subjectType: "ruleset",
          subjectId: secondaryAvailabilityRuleSetId,
          timezone: "UTC",
          rrule: plannerRRule(secondaryWindow),
          kind: "availability",
          note: `EPC secondary Surveyor window ${suffix}`,
        });

      const stateWithSecondarySurveyor = await getBookingState(
        request,
        customerASession,
        "customer A survey state with a secondary Surveyor",
      );
      expect(
        stateWithSecondarySurveyor.slots.some((slot) => {
          const startsAt = new Date(slot.startsAt).getTime();
          const endsAt = new Date(slot.endsAt).getTime();
          return (
            startsAt >= secondaryWindow.start.getTime() &&
            endsAt <= secondaryWindow.end.getTime()
          );
        }),
        "the secondary Surveyor should contribute slots only in the disjoint explicit window",
      ).toBe(true);
      expect(
        stateWithSecondarySurveyor.slots.every((slot) => {
          const startsAt = new Date(slot.startsAt).getTime();
          const endsAt = new Date(slot.endsAt).getTime();
          const inPrimaryWindow =
            startsAt >= primaryWindow.start.getTime() &&
            endsAt <= primaryWindow.end.getTime();
          const inSecondaryWindow =
            startsAt >= secondaryWindow.start.getTime() &&
            endsAt <= secondaryWindow.end.getTime();
          const inAdditionalWindow =
            startsAt >= additionalWindow.start.getTime() &&
            endsAt <= additionalWindow.end.getTime();
          return inPrimaryWindow || inAdditionalWindow || inSecondaryWindow;
        }),
        "eligible Surveyor slots should stay inside their explicit disjoint windows",
      ).toBe(true);
      const selectedSlot = stateWithSecondarySurveyor.slots.find((slot) => {
        const startsAt = new Date(slot.startsAt).getTime();
        const endsAt = new Date(slot.endsAt).getTime();
        return (
          startsAt >= primaryWindow.start.getTime() &&
          endsAt <= primaryWindow.end.getTime()
        );
      });
      expect(
        selectedSlot,
        "a primary Surveyor slot should remain for the initial booking",
      ).toBeTruthy();
      if (!selectedSlot) {
        throw new Error(
          "No primary Surveyor slot remained for initial booking",
        );
      }
      const customerBState = await getBookingState(
        request,
        customerBSession,
        "customer B ready survey state",
      );
      expect(customerBState.deals.map((deal) => deal.id)).toEqual([dealBId]);
      expect(
        customerBState.slots.some((slot) => slot.id === selectedSlot.id),
      ).toBe(true);

      const customerABookingCustomerBDeal = await postBooking(
        request,
        customerASession,
        {
          dealId: dealBId,
          slotId: selectedSlot.id,
        },
      );
      expect(
        customerABookingCustomerBDeal.status(),
        "customer A cannot book customer B deal",
      ).toBe(404);

      const crossDealResponses = await Promise.all([
        postBooking(request, customerASession, {
        dealId: dealAId,
        slotId: selectedSlot.id,
        }),
        postBooking(request, customerBSession, {
          dealId: dealBId,
          slotId: selectedSlot.id,
        }),
      ]);
      const crossDealBodies = await Promise.all(
        crossDealResponses.map((response) =>
          readJsonSafe<BookingPostResponse & { error?: string }>(response),
        ),
      );
      fixtures.concurrencyInteractionIds.push(
        ...crossDealBodies.flatMap((body) =>
          typeof body?.booking?.id === "string" ? [body.booking.id] : [],
        ),
      );
      expect(
        crossDealResponses.map((response) => response.status()).sort(),
      ).toEqual([200, 409]);
      const crossDealSuccess = crossDealResponses.find(
        (response) => response.status() === 200,
      );
      const crossDealConflict = crossDealResponses.find(
        (response) => response.status() === 409,
      );
      expect(crossDealSuccess).toBeTruthy();
      expect(crossDealConflict).toBeTruthy();
      const crossDealSuccessBody =
        crossDealBodies[crossDealResponses.indexOf(crossDealSuccess!)];
      const crossDealConflictBody =
        crossDealBodies[crossDealResponses.indexOf(crossDealConflict!)];
      expect(crossDealConflictBody).toMatchObject({ ok: false });
      expect(typeof crossDealConflictBody?.error).toBe("string");
      const temporaryInteractionId = expectId(
        crossDealSuccessBody?.booking?.id,
        "cross-deal concurrency winner should create one interaction",
      );
      const crossDealPersisted = [
        ...(await listDealInteractions(request, adminToken, dealAId)),
        ...(await listDealInteractions(request, adminToken, dealBId)),
      ].filter(
        (interaction) =>
          interaction.source === SURVEY_SOURCE &&
          interaction.status !== "canceled",
      );
      expect(
        crossDealPersisted,
        "different deals competing for one Surveyor time should persist exactly one claim",
      ).toHaveLength(1);
      await deleteInteractionNow(
        request,
        adminToken,
        temporaryInteractionId,
        "cross-deal concurrency winner",
      );
      fixtures.concurrencyInteractionIds =
        fixtures.concurrencyInteractionIds.filter(
          (id) => id !== temporaryInteractionId,
        );

      const stateAfterCrossDealClaim = await getBookingState(
        request,
        customerASession,
        "customer A state after removing the cross-deal concurrency fixture",
      );
      const freshSelectedSlot = stateAfterCrossDealClaim.slots.find(
        (slot) => slot.id === selectedSlot.id,
      );
      expect(freshSelectedSlot).toBeTruthy();
      if (!freshSelectedSlot) {
        throw new Error("The released Surveyor slot did not become available");
      }

      const sameDealResponses = await Promise.all([
        postBooking(request, customerASession, {
          dealId: dealAId,
          slotId: freshSelectedSlot.id,
        }),
        postBooking(request, customerASession, {
          dealId: dealAId,
          slotId: freshSelectedSlot.id,
        }),
      ]);
      const sameDealBodies = await Promise.all(
        sameDealResponses.map((response) =>
          readJsonSafe<BookingPostResponse & { error?: string }>(response),
        ),
      );
      fixtures.concurrencyInteractionIds.push(
        ...sameDealBodies.flatMap((body) =>
          typeof body?.booking?.id === "string" ? [body.booking.id] : [],
        ),
      );
      expect(
        sameDealResponses.map((response) => response.status()).sort(),
      ).toEqual([200, 409]);
      const createResponse = sameDealResponses.find(
        (response) => response.status() === 200,
      );
      const sameDealConflict = sameDealResponses.find(
        (response) => response.status() === 409,
      );
      expect(createResponse).toBeTruthy();
      expect(sameDealConflict).toBeTruthy();
      const createBody =
        sameDealBodies[sameDealResponses.indexOf(createResponse!)];
      const sameDealConflictBody =
        sameDealBodies[sameDealResponses.indexOf(sameDealConflict!)];
      expect(sameDealConflictBody).toMatchObject({ ok: false });
      expect(typeof sameDealConflictBody?.error).toBe("string");
      expect(createBody?.ok).toBe(true);
      const interactionId = expectId(
        createBody?.booking?.id,
        "survey create response should include booking id",
      );
      fixtures.interactionId = interactionId;
      fixtures.concurrencyInteractionIds =
        fixtures.concurrencyInteractionIds.filter((id) => id !== interactionId);
      expect(createBody?.booking).toEqual(
        expect.objectContaining({
          id: interactionId,
          dealId: dealAId,
          scheduledAt: freshSelectedSlot.startsAt,
          durationMinutes: 60,
          status: "planned",
          updatedAt: expect.any(String),
        }),
      );

      const afterCreateInteractions = await listDealInteractions(
        request,
        adminToken,
        dealAId,
      );
      const created = afterCreateInteractions.find(
        (interaction) => interaction.id === interactionId,
      );
      expect(
        created,
        "created survey interaction should be readable by admin",
      ).toBeTruthy();
      if (!created)
        throw new Error(
          "Created survey interaction was not returned by canonical API",
        );
      assertSurveyInteraction(
        created,
        {
          id: interactionId,
          tenantId,
          organizationId,
          companyId: companyAId,
          dealId: dealAId,
          dealTitle: dealATitle,
          scheduledAt: freshSelectedSlot.startsAt,
          surveyorUserId: primarySurveyorUserId,
          surveyorName,
          customerDisplayName: customerA.displayName,
          customerEmail: customerA.email,
        },
        "survey booking after create",
      );
      const createdUpdatedAt = created.updatedAt as string;

      const conflictResponse = await postBooking(request, customerBSession, {
        dealId: dealBId,
        slotId: freshSelectedSlot.id,
      });
      expect(
        conflictResponse.status(),
        "occupied slot should return 409 for customer B",
      ).toBe(409);
      const customerBInteractions = await listDealInteractions(
        request,
        adminToken,
        dealBId,
      );
      expect(
        customerBInteractions.filter(
          (interaction) => interaction.source === SURVEY_SOURCE,
        ),
      ).toEqual([]);

      const afterCreateState = await getBookingState(
        request,
        customerASession,
        "customer A state after create",
      );
      const bookedAfterCreate = afterCreateState.deals.find(
        (deal) => deal.id === dealAId,
      )?.bookedSurvey;
      expect(bookedAfterCreate).toEqual(
        expect.objectContaining({
          id: interactionId,
          dealId: dealAId,
          scheduledAt: freshSelectedSlot.startsAt,
        }),
      );
      expect(
        afterCreateState.slots.some(
          (slot) => slot.startsAt === freshSelectedSlot.startsAt,
        ),
      ).toBe(false);
      const secondSlot = afterCreateState.slots.find((slot) => {
        const startsAt = new Date(slot.startsAt).getTime();
        const endsAt = new Date(slot.endsAt).getTime();
        return (
          startsAt >= secondaryWindow.start.getTime() &&
          endsAt <= secondaryWindow.end.getTime()
        );
      });
      expect(
        secondSlot,
        "the secondary Surveyor should expose a disjoint slot for rescheduling",
      ).toBeTruthy();
      if (!secondSlot)
        throw new Error("No secondary Surveyor slot remained for rescheduling");

      const concurrentTitle = `Survey booking concurrently reviewed ${suffix}`;
      const concurrentUpdate = await request.put(
        "/api/customers/interactions",
        {
          headers: {
            Authorization: `Bearer ${adminToken}`,
            ...JSON_HEADERS,
            [OPTIMISTIC_LOCK_HEADER]: createdUpdatedAt,
          },
          data: { id: interactionId, title: concurrentTitle },
        },
      );
      expect(
        concurrentUpdate.status(),
        "concurrent admin interaction update should advance updatedAt",
      ).toBe(200);
      const afterConcurrentUpdateInteractions = await listDealInteractions(
        request,
        adminToken,
        dealAId,
      );
      const latestBeforeStale = afterConcurrentUpdateInteractions.find(
        (interaction) => interaction.id === interactionId,
      );
      expect(latestBeforeStale).toBeTruthy();
      expect(latestBeforeStale?.updatedAt).not.toBe(createdUpdatedAt);
      expect(latestBeforeStale?.title).toBe(concurrentTitle);

      const staleRescheduleResponse = await postBooking(
        request,
        customerASession,
        { dealId: dealAId, slotId: secondSlot.id },
        createdUpdatedAt,
      );
      const staleRescheduleBody = await readJsonSafe<{
        error?: string;
        code?: string;
        currentUpdatedAt?: string;
        expectedUpdatedAt?: string;
      }>(staleRescheduleResponse);
      expect(
        staleRescheduleResponse.status(),
        "stale survey reschedule should preserve the standard 409",
      ).toBe(409);
      expect(staleRescheduleBody).toMatchObject({
        code: "optimistic_lock_conflict",
        currentUpdatedAt: latestBeforeStale?.updatedAt,
        expectedUpdatedAt: createdUpdatedAt,
      });

      const afterStaleInteractions = await listDealInteractions(
        request,
        adminToken,
        dealAId,
      );
      const unchangedAfterStale = afterStaleInteractions.find(
        (interaction) => interaction.id === interactionId,
      );
      expect(unchangedAfterStale).toMatchObject({
        id: interactionId,
        title: concurrentTitle,
        scheduledAt: freshSelectedSlot.startsAt,
        updatedAt: latestBeforeStale?.updatedAt,
      });

      const stateAfterStale = await getBookingState(
        request,
        customerASession,
        "customer A state after stale reschedule rejection",
      );
      const freshBookingVersion = stateAfterStale.deals.find(
        (deal) => deal.id === dealAId,
      )?.bookedSurvey?.updatedAt;
      const freshSecondSlot = stateAfterStale.slots.find(
        (slot) => slot.id === secondSlot.id,
      );
      expect(freshBookingVersion).toBe(latestBeforeStale?.updatedAt);
      expect(freshSecondSlot).toBeTruthy();
      if (!freshBookingVersion || !freshSecondSlot) {
        throw new Error(
          "Fresh booking version or reschedule slot was unavailable",
        );
      }

      const rescheduleResponse = await postBooking(
        request,
        customerASession,
        { dealId: dealAId, slotId: freshSecondSlot.id },
        freshBookingVersion,
      );
      const rescheduleBody =
        await readJsonSafe<BookingPostResponse>(rescheduleResponse);
      expect(
        rescheduleResponse.status(),
        "survey booking reschedule should return 200",
      ).toBe(200);
      expect(rescheduleBody?.booking.id).toBe(interactionId);
      expect(rescheduleBody?.booking.scheduledAt).toBe(
        freshSecondSlot.startsAt,
      );
      expect(typeof rescheduleBody?.booking.updatedAt).toBe("string");

      const afterRescheduleInteractions = await listDealInteractions(
        request,
        adminToken,
        dealAId,
      );
      const activeSurveyInteractions = afterRescheduleInteractions.filter(
        (interaction) =>
          interaction.source === SURVEY_SOURCE &&
          interaction.status !== "canceled",
      );
      expect(activeSurveyInteractions).toHaveLength(1);
      const rescheduled = activeSurveyInteractions[0];
      expect(rescheduled.id).toBe(interactionId);
      expect(rescheduled.updatedAt).not.toBe(createdUpdatedAt);
      expect(rescheduled.ownerUserId).toBe(secondarySurveyorUserId);
      expect(rescheduled.ownerUserId).not.toBe(created.ownerUserId);
      expect(rescheduled.authorUserId).toBe(secondarySurveyorUserId);
      expect(rescheduled.authorUserId).not.toBe(created.authorUserId);
      expect(
        created.participants?.map((participant) => participant.userId),
      ).toEqual([primarySurveyorUserId]);
      expect(
        rescheduled.participants?.map((participant) => participant.userId),
      ).toEqual([secondarySurveyorUserId]);
      assertSurveyInteraction(
        rescheduled,
        {
          id: interactionId,
          tenantId,
          organizationId,
          companyId: companyAId,
          dealId: dealAId,
          dealTitle: dealATitle,
          scheduledAt: freshSecondSlot.startsAt,
          surveyorUserId: secondarySurveyorUserId,
          surveyorName: secondarySurveyorName,
          customerDisplayName: customerA.displayName,
          customerEmail: customerA.email,
        },
        "survey booking after reschedule",
      );

      const reloadedCustomerASession = await portalLogin(request, {
        email: customerA.email,
        password: customerA.password,
        tenantId,
      });
      const reloadedState = await getBookingState(
        request,
        reloadedCustomerASession,
        "customer A survey state after a fresh portal login",
      );
      const reloadedBooking = reloadedState.deals.find(
        (deal) => deal.id === dealAId,
      )?.bookedSurvey;
      expect(reloadedBooking).toEqual(
        expect.objectContaining({
          id: interactionId,
          dealId: dealAId,
          scheduledAt: freshSecondSlot.startsAt,
          durationMinutes: 60,
          status: "planned",
        }),
      );
    } catch (error) {
      testError = error;
      testFailed = true;
    } finally {
      const cleanupFailures: string[] = [];

      for (const interactionId of fixtures.concurrencyInteractionIds) {
        await cleanupQueryDelete(
          request,
          adminToken,
          cleanupFailures,
          "concurrency survey interaction",
          "/api/customers/interactions",
          interactionId,
        );
      }

      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "survey booking interaction",
        "/api/customers/interactions",
        fixtures.interactionId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "all-day busy interaction",
        "/api/customers/interactions",
        fixtures.allDayBusyInteractionId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "participant-only busy interaction",
        "/api/customers/interactions",
        fixtures.participantBusyInteractionId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "owner busy interaction",
        "/api/customers/interactions",
        fixtures.busyInteractionId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "non-Survey deal",
        "/api/customers/deals",
        fixtures.nonSurveyDealId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "Customer B deal",
        "/api/customers/deals",
        fixtures.dealBId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "Customer A deal",
        "/api/customers/deals",
        fixtures.dealAId,
      );

      await cleanupCustomerUser(
        request,
        adminToken,
        cleanupFailures,
        "Customer B portal user",
        fixtures.customerBUserId,
      );
      await cleanupCustomerUser(
        request,
        adminToken,
        cleanupFailures,
        "unlinked portal user",
        fixtures.unlinkedCustomerUserId,
      );
      await cleanupCustomerUser(
        request,
        adminToken,
        cleanupFailures,
        "no-feature portal user",
        fixtures.noFeatureCustomerUserId,
      );
      await cleanupCustomerUser(
        request,
        adminToken,
        cleanupFailures,
        "Customer A portal user",
        fixtures.customerAUserId,
      );
      await cleanupPathDelete(
        request,
        adminToken,
        cleanupFailures,
        "no-feature customer role",
        "/api/customer_accounts/admin/roles",
        fixtures.noFeatureCustomerRoleId,
      );
      await cleanupPathDelete(
        request,
        adminToken,
        cleanupFailures,
        "survey booking customer role",
        "/api/customer_accounts/admin/roles",
        fixtures.bookingCustomerRoleId,
      );

      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "non-Surveyor availability rule",
        "/api/planner/availability",
        fixtures.nonSurveyorAvailabilityRuleId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "secondary Surveyor availability rule",
        "/api/planner/availability",
        fixtures.secondaryAvailabilityRuleId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "additional Surveyor availability rule",
        "/api/planner/availability",
        fixtures.additionalAvailabilityRuleId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "primary Surveyor availability rule",
        "/api/planner/availability",
        fixtures.primaryAvailabilityRuleId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "non-Surveyor availability rule set",
        "/api/planner/availability-rule-sets",
        fixtures.nonSurveyorAvailabilityRuleSetId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "secondary Surveyor availability rule set",
        "/api/planner/availability-rule-sets",
        fixtures.secondaryAvailabilityRuleSetId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "additional Surveyor availability rule set",
        "/api/planner/availability-rule-sets",
        fixtures.additionalAvailabilityRuleSetId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "primary Surveyor availability rule set",
        "/api/planner/availability-rule-sets",
        fixtures.primaryAvailabilityRuleSetId,
      );

      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "non-Surveyor staff member",
        "/api/staff/team-members",
        fixtures.nonSurveyorStaffMemberId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "Surveyor without availability staff member",
        "/api/staff/team-members",
        fixtures.noAvailabilityStaffMemberId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "secondary Surveyor staff member",
        "/api/staff/team-members",
        fixtures.secondaryStaffMemberId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "additional Surveyor staff member",
        "/api/staff/team-members",
        fixtures.additionalStaffMemberId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "primary Surveyor staff member",
        "/api/staff/team-members",
        fixtures.primaryStaffMemberId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "non-Surveyor auth user",
        "/api/auth/users",
        fixtures.nonSurveyorUserId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "Surveyor without availability auth user",
        "/api/auth/users",
        fixtures.noAvailabilitySurveyorUserId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "secondary Surveyor auth user",
        "/api/auth/users",
        fixtures.secondarySurveyorUserId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "primary Surveyor auth user",
        "/api/auth/users",
        fixtures.primarySurveyorUserId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "Surveyor auth role",
        "/api/auth/roles",
        fixtures.surveyorRoleId,
      );

      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "Customer B company",
        "/api/customers/companies",
        fixtures.companyBId,
      );
      await cleanupQueryDelete(
        request,
        adminToken,
        cleanupFailures,
        "Customer A company",
        "/api/customers/companies",
        fixtures.companyAId,
      );
      await cleanupBodyDelete(
        request,
        adminToken,
        cleanupFailures,
        "non-Survey pipeline stage",
        "/api/customers/pipeline-stages",
        fixtures.nonSurveyStageId,
      );
      await cleanupBodyDelete(
        request,
        adminToken,
        cleanupFailures,
        "Survey pipeline stage",
        "/api/customers/pipeline-stages",
        fixtures.surveyStageId,
      );
      await cleanupBodyDelete(
        request,
        adminToken,
        cleanupFailures,
        "Survey pipeline",
        "/api/customers/pipelines",
        fixtures.pipelineId,
      );

      if (cleanupFailures.length > 0) {
        const cleanupReport = cleanupFailures.join("\n");
        await testInfo
          .attach("cleanup-failures", {
            body: cleanupReport,
            contentType: "text/plain",
          })
          .catch((attachmentError) => {
            console.error(
              "Failed to attach cleanup failure report:",
              attachmentError,
            );
          });
        console.error(`Task 3 cleanup failures:\n${cleanupReport}`);
        if (!testFailed) {
          throw new Error(`Task 3 cleanup failed:\n${cleanupReport}`);
        }
      }
    }

    if (testFailed) throw testError;
  });
});
