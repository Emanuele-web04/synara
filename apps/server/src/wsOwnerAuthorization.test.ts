import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { CurrentWsSessionRole } from "./wsConnectionSessions";
import { requireWsOwnerSession } from "./wsOwnerAuthorization";

describe("owner-only read admission", () => {
  it("requires the connection owner role before calling a reader", async () => {
    const read = vi.fn(() => "history");
    const operation = requireWsOwnerSession.pipe(Effect.andThen(Effect.sync(read)));
    await expect(Effect.runPromise(operation)).rejects.toThrow("Owner authorization");
    await expect(
      Effect.runPromise(operation.pipe(Effect.provideService(CurrentWsSessionRole, "client"))),
    ).rejects.toThrow("Owner authorization");
    expect(read).not.toHaveBeenCalled();
    await expect(
      Effect.runPromise(operation.pipe(Effect.provideService(CurrentWsSessionRole, "owner"))),
    ).resolves.toBe("history");
    expect(read).toHaveBeenCalledOnce();
  });
});
