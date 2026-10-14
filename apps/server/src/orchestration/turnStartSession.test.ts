import { ThreadId, type OrchestrationSession } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { canAdoptFirstTurnProvider, deriveTurnStartSession } from "./turnStartSession.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-turn-start-session");
const REQUESTED_AT = "2026-07-21T00:00:00.000Z";

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "codex",
    providerInstanceId: "codex",
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError: status === "error" ? "runtime exploded" : null,
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function derive(currentSession: OrchestrationSession | null) {
  return deriveTurnStartSession({
    threadId: THREAD_ID,
    currentSession,
    providerName: "pi",
    requestedRuntimeMode: "full-access",
    observedAt: REQUESTED_AT,
  });
}

describe("deriveTurnStartSession", () => {
  it("ignores imported history when deciding first-turn provider adoption", () => {
    expect(
      canAdoptFirstTurnProvider({
        hasLatestTurn: false,
        hasSession: false,
        messages: [{ source: "fork-import" }, { source: "handoff-import" }, { source: "native" }],
      }),
    ).toBe(true);

    expect(
      canAdoptFirstTurnProvider({
        hasLatestTurn: false,
        hasSession: false,
        messages: [{ source: "fork-import" }, { source: "native" }, { source: "native" }],
      }),
    ).toBe(false);

    expect(
      canAdoptFirstTurnProvider({
        hasLatestTurn: true,
        hasSession: false,
        messages: [{ source: "fork-import" }],
      }),
    ).toBe(false);
  });

  it("preserves established provider settings when starting an idle session", () => {
    expect(derive(makeSession("idle"))).toMatchObject({
      status: "starting",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
    });
  });

  it.each(["starting", "running"] as const)(
    "does not replace an established %s session with a false Starting state",
    (status) => {
      expect(derive(makeSession(status))).toBeNull();
    },
  );

  it("keeps an authoritative pending-start fence for an established ready session", () => {
    expect(derive(makeSession("ready"))).toMatchObject({
      status: "starting",
      providerName: "codex",
      runtimeMode: "approval-required",
    });
  });

  it("fences accepted ready-session work despite a client timestamp behind the server", () => {
    const session = { ...makeSession("ready"), updatedAt: "2026-07-22T00:00:00.000Z" };
    expect(derive(session)).toMatchObject({ status: "starting", updatedAt: REQUESTED_AT });
  });

  it("does not overwrite newer terminal state with a delayed start request", () => {
    const recentError = {
      ...makeSession("error"),
      updatedAt: "2026-07-22T00:00:00.000Z",
    };
    expect(derive(recentError)).toBeNull();
  });

  it("clears terminal error details when a new turn starts", () => {
    expect(derive(makeSession("error"))).toMatchObject({
      status: "starting",
      activeTurnId: null,
      lastError: null,
    });
  });
});

it("timestamps a pending follow-up with server observation despite a slow client clock", () => {
  const observedAt = "2026-07-23T01:00:00.000Z";
  expect(
    deriveTurnStartSession({
      threadId: THREAD_ID,
      currentSession: makeSession("ready"),
      providerName: "codex",
      requestedRuntimeMode: "full-access",
      observedAt,
    }),
  ).toMatchObject({ status: "starting", updatedAt: observedAt });
});

it.each(["stopped", "error", "interrupted"] as const)(
  "fences a %s retry using server ordering despite clock skew",
  (status) => {
    const observedAt = "2026-07-23T01:00:00.000Z";
    expect(
      deriveTurnStartSession({
        threadId: THREAD_ID,
        currentSession: makeSession(status),
        providerName: "codex",
        requestedRuntimeMode: "full-access",
        observedAt,
      }),
    ).toMatchObject({ status: "starting", updatedAt: observedAt });
  },
);
