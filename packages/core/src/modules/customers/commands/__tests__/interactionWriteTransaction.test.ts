import type { EntityManager } from "@mikro-orm/postgresql";
import type { CommandRuntimeContext } from "@open-mercato/shared/lib/commands";
import {
  attachInternalInteractionWriteTransactionHook,
  runInternalInteractionWriteTransactionHook,
} from "../interactionWriteTransaction";

const input = {
  entityId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
  interactionType: "event" as const,
};

describe("internal interaction write transaction hook", () => {
  it("is absent for ordinary callers and leaves their command context unchanged", async () => {
    const ctx = { container: {} } as CommandRuntimeContext;

    await expect(
      runInternalInteractionWriteTransactionHook(ctx, {
        em: {} as EntityManager,
        operation: "create",
        input,
      }),
    ).resolves.toBeUndefined();
    expect(Object.getOwnPropertySymbols(ctx)).toEqual([]);
  });

  it("runs only in local memory and is omitted from serialized command context", async () => {
    const ctx = {
      container: {},
      selectedOrganizationId: "organization",
    } as CommandRuntimeContext;
    const em = {} as EntityManager;
    const hook = jest.fn(async () => undefined);

    attachInternalInteractionWriteTransactionHook(ctx, hook);

    expect(JSON.stringify(ctx)).toBe(
      '{"container":{},"selectedOrganizationId":"organization"}',
    );
    expect(Symbol.keyFor(Object.getOwnPropertySymbols(ctx)[0])).toBe(
      "open-mercato.customers.internal-interaction-write-transaction-hook",
    );
    await runInternalInteractionWriteTransactionHook(ctx, {
      em,
      operation: "create",
      input,
    });
    expect(hook).toHaveBeenCalledWith({ em, operation: "create", input });
  });
});
