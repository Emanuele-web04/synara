import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { GatewayToolError } from "../agentGateway/toolRuntime.ts";
import { waitForExternalMcpTaskState } from "./waitForTask.ts";

const inactive = () =>
  Effect.fail(new GatewayToolError("external_credential_inactive", "Integration revoked."));

describe("waitForExternalMcpTaskState", () => {
  it("waits for a latest turn that appears after the thread projection", async () => {
    let latestReads = 0;
    const result = await Effect.runPromise(
      waitForExternalMcpTaskState({
        threadId: "thread-projection-lag",
        runId: null,
        initialState: "pending",
        timeoutMs: 1_000,
        assertActive: () => Effect.void,
        projectionTurns: {
          getManyWaitSnapshot: () => Effect.die("resolved terminal turns must not poll again"),
        } as never,
        resolveLatestTurn: () => {
          latestReads += 1;
          return Effect.succeed({ runId: "turn-projected-later", state: "completed" as const });
        },
      }),
    );
    expect(latestReads).toBe(1);
    expect(result).toMatchObject({
      runId: "turn-projected-later",
      state: "completed",
      terminal: true,
      timedOut: false,
    });
  });

  it("returns a terminal startup failure even when no turn id was projected", async () => {
    const result = await Effect.runPromise(
      waitForExternalMcpTaskState({
        threadId: "thread-startup-failed",
        runId: null,
        initialState: "pending",
        timeoutMs: 1_000,
        assertActive: () => Effect.void,
        projectionTurns: {
          getManyWaitSnapshot: () => Effect.die("a terminal session must not poll turns"),
        } as never,
        resolveLatestTurn: () => Effect.succeed({ runId: null, state: "error" as const }),
      }),
    );
    expect(result).toMatchObject({
      runId: null,
      state: "error",
      terminal: true,
      timedOut: false,
    });
  });

  it("rejects revocation that occurs while a running wait is asleep", async () => {
    let snapshotReads = 0;
    const exit = await Effect.runPromiseExit(
      waitForExternalMcpTaskState({
        threadId: "thread-running-revoked",
        runId: "turn-running-revoked",
        initialState: "running",
        timeoutMs: 1,
        assertActive: inactive,
        projectionTurns: {
          getManyWaitSnapshot: () => {
            snapshotReads += 1;
            return Effect.succeed({ existingThreadIds: [], turns: [] });
          },
        } as never,
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(snapshotReads).toBe(0);
    expect(String(exit)).toContain("Integration revoked");
  });

  it("checks revocation even when the observed task is already terminal", async () => {
    const exit = await Effect.runPromiseExit(
      waitForExternalMcpTaskState({
        threadId: "thread-terminal-revoked",
        runId: "turn-terminal-revoked",
        initialState: "completed",
        timeoutMs: 60_000,
        assertActive: inactive,
        projectionTurns: {
          getManyWaitSnapshot: () => Effect.die("terminal waits must not poll"),
        } as never,
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("Integration revoked");
  });
});
