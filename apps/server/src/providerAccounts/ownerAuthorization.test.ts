import { readFileSync } from "node:fs";
import { PROVIDER_ACCOUNTS_WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CurrentWsSessionRole } from "../wsConnectionSessions";
import { requireWsOwnerSession } from "../wsOwnerAuthorization";

describe("provider account RPC admission", () => {
  it("gates every account RPC through owner authorization", () => {
    const source = readFileSync(new URL("../wsRpc.ts", import.meta.url), "utf8");
    for (const method of Object.keys(PROVIDER_ACCOUNTS_WS_METHODS)) {
      const marker = `[PROVIDER_ACCOUNTS_WS_METHODS.${method}]`;
      const start = source.indexOf(marker);
      expect(start, method).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf("\n        [", start + marker.length));
      expect(body, method).toContain("ownerAccountRpc(");
    }
    expect(source.replace(/\s/g, "")).toContain(
      "requireWsOwnerSession.pipe(Effect.andThen(rpcEffect(effect,fallbackMessage)))",
    );
  });
  it("does not execute a credential mutation for a paired client", async () => {
    const change = vi.fn();
    const operation = requireWsOwnerSession.pipe(Effect.andThen(Effect.sync(change)));
    await expect(
      Effect.runPromise(operation.pipe(Effect.provideService(CurrentWsSessionRole, "client"))),
    ).rejects.toThrow("Owner authorization");
    expect(change).not.toHaveBeenCalled();
    await Effect.runPromise(operation.pipe(Effect.provideService(CurrentWsSessionRole, "owner")));
    expect(change).toHaveBeenCalledOnce();
  });
});
