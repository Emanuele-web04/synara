/**
 * DaytonaRuntimeProviderFacade unit tests.
 *
 * Pins the provider-agnostic surface the registry resolves: the facade routes
 * `refreshActivity` (the activity-lease keepalive the service renews on a timer)
 * through to the concrete Daytona adapter, and swallows a provider failure so a
 * failed keepalive never breaks the renew loop. Uses a recording stub adapter so
 * no Daytona client or provider access is involved.
 *
 * @module DaytonaRuntimeProviderFacade.test
 */
import { ExecutionInstanceId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { DaytonaApiError } from "../providers/daytona/DaytonaErrors.ts";
import type { DaytonaRuntimeAdapterShape } from "../providers/daytona/DaytonaRuntimeAdapter.ts";
import { makeDaytonaRuntimeProviderFacade } from "./DaytonaRuntimeProviderFacade.ts";

const unimplemented = () => Effect.die("not used in this test");

const makeStubAdapter = (
  overrides: Partial<DaytonaRuntimeAdapterShape>,
): DaytonaRuntimeAdapterShape => ({
  provision: unimplemented as DaytonaRuntimeAdapterShape["provision"],
  createTransport: unimplemented as DaytonaRuntimeAdapterShape["createTransport"],
  execCollect: unimplemented as DaytonaRuntimeAdapterShape["execCollect"],
  reinjectCredentials: () => Effect.void,
  exposePort: unimplemented as DaytonaRuntimeAdapterShape["exposePort"],
  snapshot: unimplemented as DaytonaRuntimeAdapterShape["snapshot"],
  refreshActivity: () => Effect.void,
  stop: () => Effect.void,
  isAlive: () => Effect.succeed(true),
  destroy: () => Effect.void,
  ...overrides,
});

describe("DaytonaRuntimeProviderFacade.refreshActivity", () => {
  const instanceId = ExecutionInstanceId.makeUnsafe("sandbox-1");

  it("routes the keepalive through to the concrete adapter", async () => {
    const refreshed: string[] = [];
    const facade = makeDaytonaRuntimeProviderFacade(
      makeStubAdapter({
        refreshActivity: (id) =>
          Effect.sync(() => {
            refreshed.push(String(id));
          }),
      }),
    );
    expect(facade.refreshActivity).toBeDefined();

    await Effect.runPromise(facade.refreshActivity!(instanceId));
    expect(refreshed).toEqual(["sandbox-1"]);
  });

  it("swallows a provider failure so a failed keepalive never breaks the renew loop", async () => {
    const facade = makeDaytonaRuntimeProviderFacade(
      makeStubAdapter({
        refreshActivity: () =>
          Effect.fail(
            new DaytonaApiError({ operation: "refreshActivity", status: 500, detail: "boom" }),
          ),
      }),
    );

    // The facade's surface declares a `never` error channel, so the failure is
    // absorbed: the effect succeeds rather than propagating the provider error.
    const exit = await Effect.runPromiseExit(facade.refreshActivity!(instanceId));
    expect(exit._tag).toBe("Success");
  });
});
