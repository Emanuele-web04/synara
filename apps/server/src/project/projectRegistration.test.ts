import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ProjectCheckoutResult } from "./projectProvisioning";
import { recoverUnregisteredCheckout } from "./projectRegistration";

function checkout(kind: "created" | "reused"): ProjectCheckoutResult {
  return {
    operationId: "operation-1",
    repository: "openai/codex",
    workspaceRoot: "/repos/codex",
    checkout: kind,
    recoveryPath: kind === "created" ? "/repos/.synara-clone-1" : null,
  };
}

describe("recoverUnregisteredCheckout", () => {
  it("moves a newly created checkout to recovery storage when registration did not commit", async () => {
    const moves: Array<[string, string]> = [];

    await Effect.runPromise(
      recoverUnregisteredCheckout({
        checkout: checkout("created"),
        registrationCommitted: false,
        moveWorkspaceRoot: (workspaceRoot, recoveryPath) =>
          Effect.sync(() => moves.push([workspaceRoot, recoveryPath])),
      }),
    );

    expect(moves).toEqual([["/repos/codex", "/repos/.synara-clone-1"]]);
  });

  it.each([
    ["a reused checkout", checkout("reused"), false],
    ["a registered checkout", checkout("created"), true],
  ])("preserves %s", async (_label, provisionedCheckout, registrationCommitted) => {
    let moved = false;

    await Effect.runPromise(
      recoverUnregisteredCheckout({
        checkout: provisionedCheckout,
        registrationCommitted,
        moveWorkspaceRoot: () => Effect.sync(() => (moved = true)),
      }),
    );

    expect(moved).toBe(false);
  });
});
