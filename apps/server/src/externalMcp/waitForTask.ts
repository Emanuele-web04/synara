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
  state === "completed" || state === "error" || state === "interrupted";

const isLiveWaitState = (state: ExternalMcpWaitState) => state === "pending" || state === "running";

export const requestedExternalMcpRunId = (
  input: { readonly runId?: string | null | undefined },
  latestTurnId: string | null,
): string | null => (Object.hasOwn(input, "runId") ? (input.runId ?? null) : latestTurnId);

export const latestExternalMcpWaitState = (thread: {
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: ExternalMcpWaitState;
  } | null;
  readonly session: { readonly status: string } | null;
}): { readonly runId: string | null; readonly state: ExternalMcpWaitState } | null => {
  if (thread.latestTurn !== null && isLiveWaitState(thread.latestTurn.state)) {
    return { runId: thread.latestTurn.turnId, state: thread.latestTurn.state };
  }
  if (thread.session?.status === "error") return { runId: null, state: "error" };
  if (thread.session?.status === "interrupted" || thread.session?.status === "stopped") {
    return { runId: null, state: "interrupted" };
  }
  return thread.latestTurn === null
    ? null
    : { runId: thread.latestTurn.turnId, state: thread.latestTurn.state };
};

export const terminalExternalMcpSessionStateForRun = (
  thread: {
    readonly latestTurn: {
      readonly turnId: string;
      readonly state: ExternalMcpWaitState;
    } | null;
    readonly session: { readonly status: string } | null;
  },
  runId: string | null,
): Extract<ExternalMcpWaitState, "error" | "interrupted"> | null => {
  // Session state has no durable run id. Once a run is pinned, its projected
  // turn is authoritative; a session failure can belong to a later startup.
  // A visible live turn is also more specific than uncorrelated session state.
  if (runId !== null || (thread.latestTurn !== null && isLiveWaitState(thread.latestTurn.state))) {
    return null;
  }
  if (thread.session?.status === "error") return "error";
  return thread.session?.status === "interrupted" || thread.session?.status === "stopped"
    ? "interrupted"
    : null;
};

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
  readonly resolveLatestTurn?: () => Effect.Effect<
    { readonly runId: string | null; readonly state: ExternalMcpWaitState } | null,
    unknown
  >;
}) {
  const deadline = Date.now() + input.timeoutMs;
  const threadId = ThreadId.makeUnsafe(input.threadId);
  let runId = input.runId === null ? null : TurnId.makeUnsafe(input.runId);
  let state = runId === null && input.initialState === "idle" ? "pending" : input.initialState;
  let pollDelayMs = 200;
  while (!isTerminalWaitState(state) && Date.now() < deadline) {
    yield* Effect.sleep(Math.min(pollDelayMs, Math.max(1, deadline - Date.now())));
    yield* input.assertActive();
    if (runId === null && input.resolveLatestTurn) {
      const latest = yield* input.resolveLatestTurn();
      if (latest !== null) {
        runId = latest.runId === null ? null : TurnId.makeUnsafe(latest.runId);
        state = latest.state;
      } else {
        state = "pending";
      }
    } else {
      const snapshot = yield* input.projectionTurns.getManyWaitSnapshot({
        threadIds: [threadId],
        turns: runId ? [{ threadId, turnId: runId }] : [],
      });
      if (!snapshot.existingThreadIds.includes(threadId)) {
        return yield* Effect.fail(
          new GatewayToolError("thread_not_found", `Thread "${input.threadId}" was not found.`),
        );
      }
      state = runId
        ? (snapshot.turns.find((turn) => turn.turnId === runId)?.state ?? state)
        : "pending";
    }
    pollDelayMs = Math.min(1_000, Math.ceil(pollDelayMs * 1.5));
  }
  yield* input.assertActive();
  return {
    runId,
    state,
    terminal: isTerminalWaitState(state),
    timedOut: !isTerminalWaitState(state),
  } as const;
});
