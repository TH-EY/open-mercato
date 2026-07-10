/** @jest-environment node */

import { CrudHttpError } from "@open-mercato/shared/lib/crud/errors";
import { handleSurveyBookingError } from "../route";

describe("EPC survey booking route errors", () => {
  it("preserves the standard optimistic-lock conflict status and structured body", async () => {
    const body = {
      error: "Record was modified by another request",
      code: "optimistic_lock_conflict",
      currentUpdatedAt: "2026-07-10T11:00:00.000Z",
      expectedUpdatedAt: "2026-07-10T10:00:00.000Z",
    };

    const response = handleSurveyBookingError(
      new CrudHttpError(409, body),
      "unused",
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(body);
  });
});
