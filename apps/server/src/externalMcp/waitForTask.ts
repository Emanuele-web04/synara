import { ThreadId, TurnId } from "@synara/contracts";
import { Effect } from "effect";

import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import { GatewayToolError } from "../agentGateway/toolRuntime.ts";

export type ExternalMcpWaitState =
  | "idle"
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "interrupted";

const isTerminalWaitState = (state: ExternalMcpWaitState) =>
  state === "idle" || state === "completed" || state === "error" || state === "interrupted";

/**
 * Long-poll durable turn state while preserving an immediate revocation boundary.
 *
 * Authority is checked after every sleep (so revocation during the sleep wins
 * before another read) and once more at the response boundary. The caller
 * performs one final check after any terminal-detail read as well.
 */
export const waitForExternalMcpTaskState = Effect.fn(function* (input: {
  readonly threadId: string;
  readonly runId: string | null;
  readonly initialState: ExternalMcpWaitState;
  readonly timeoutMs: number;
  readonly assertActive: () => Effect.Effect<void, GatewayToolError>;
  readonly projectionTurns: Pick<ProjectionTurnRepositoryShape, "getManyWaitSnapshot">;
}) {
  const deadline = Date.now() + input.timeoutMs;
  const threadId = ThreadId.makeUnsafe(input.threadId);
  const runId = input.runId === null ? null : TurnId.makeUnsafe(input.runId);
  let state = input.initialState;
  let pollDelayMs = 200;
  while (!isTerminalWaitState(state) && Date.now() < deadline) {
    yield* Effect.sleep(Math.min(pollDelayMs, Math.max(1, deadline - Date.now())));
    yield* input.assertActive();
    const snapshot = yield* input.projectionTurns.getManyWaitSnapshot({
      threadIds: [threadId],
      turns: runId ? [{ threadId, turnId: runId }] : [],
    });
    if (!snapshot.existingThreadIds.includes(threadId)) {
      return yield* Effect.fail(
        new GatewayToolError("thread_not_found", `Thread "${input.threadId}" was not found.`),
      );
    }
    state = runId ? (snapshot.turns.find((turn) => turn.turnId === runId)?.state ?? state) : "idle";
    pollDelayMs = Math.min(1_000, Math.ceil(pollDelayMs * 1.5));
  }
  yield* input.assertActive();
  return {
    state,
    terminal: isTerminalWaitState(state),
    timedOut: !isTerminalWaitState(state),
  } as const;
});
