import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { GatewayToolError } from "../agentGateway/toolRuntime.ts";
import { waitForExternalMcpTaskState } from "./waitForTask.ts";

const inactive = () =>
  Effect.fail(new GatewayToolError("external_credential_inactive", "Integration revoked."));

describe("waitForExternalMcpTaskState", () => {
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
