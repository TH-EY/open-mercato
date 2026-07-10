/** @jest-environment jsdom */

const apiCallOrThrowMock = jest.fn(async () => ({ result: { ok: true } }));
const withScopedApiRequestHeadersMock = jest.fn(
  async (_headers: Record<string, string>, call: () => Promise<unknown>) =>
    call(),
);

jest.mock("@open-mercato/ui/backend/utils/apiCall", () => ({
  apiCallOrThrow: (...args: unknown[]) => apiCallOrThrowMock(...args),
  withScopedApiRequestHeaders: (
    headers: Record<string, string>,
    call: () => Promise<unknown>,
  ) => withScopedApiRequestHeadersMock(headers, call),
}));

import { submitSurveyBookingRequest } from "../widget.client";

describe("EPC survey booking widget mutation", () => {
  beforeEach(() => {
    apiCallOrThrowMock.mockClear();
    withScopedApiRequestHeadersMock.mockClear();
  });

  it("wraps a reschedule POST with the booking optimistic-lock version", async () => {
    const updatedAt = "2026-07-10T10:00:00.000Z";

    await submitSurveyBookingRequest({
      dealId: "11111111-1111-4111-8111-111111111111",
      slotId: "survey_slot",
      bookedSurvey: {
        id: "22222222-2222-4222-8222-222222222222",
        dealId: "11111111-1111-4111-8111-111111111111",
        scheduledAt: "2026-07-11T10:00:00.000Z",
        endsAt: "2026-07-11T11:00:00.000Z",
        durationMinutes: 60,
        status: "planned",
        updatedAt,
      },
    });

    expect(withScopedApiRequestHeadersMock).toHaveBeenCalledWith(
      { "x-om-ext-optimistic-lock-expected-updated-at": updatedAt },
      expect.any(Function),
    );
    expect(apiCallOrThrowMock).toHaveBeenCalledWith(
      "/api/epc/portal/survey-booking",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps initial booking POSTs on the ordinary unversioned path", async () => {
    await submitSurveyBookingRequest({
      dealId: "11111111-1111-4111-8111-111111111111",
      slotId: "survey_slot",
      bookedSurvey: null,
    });

    expect(withScopedApiRequestHeadersMock).not.toHaveBeenCalled();
    expect(apiCallOrThrowMock).toHaveBeenCalledTimes(1);
  });
});
