import { readFileSync } from "node:fs";
import { WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CurrentWsSessionRole } from "../wsConnectionSessions";
import { requireWsOwnerSession } from "../wsOwnerAuthorization";

describe("Mind RPC admission", () => {
  it("gates every Mind RPC through owner authorization", () => {
    const source = readFileSync(new URL("../wsRpc.ts", import.meta.url), "utf8");
    for (const method of Object.keys(WS_METHODS).filter((method) => method.startsWith("mind"))) {
      const marker = `[WS_METHODS.${method}]`;
      const start = source.indexOf(marker);
      expect(start, method).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf("\n        [", start + marker.length));
      expect(body, method).toContain("ownerMindRpc(");
    }
    expect(source.replace(/\s/g, "")).toContain(
      "requireWsOwnerSession.pipe(Effect.andThen(rpcEffect(effect,fallbackMessage)))",
    );
  });
  it("does not execute a memory mutation for a paired client", async () => {
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
