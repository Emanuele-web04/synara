import {
  AgentProfileId,
  AgentProfileRevisionId,
  ThreadId,
  type OrchestrationSession,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  canAdoptFirstTurnProvider,
  deriveTurnAttribution,
  deriveTurnStartSession,
} from "./turnStartSession.ts";

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
    requestedAt: REQUESTED_AT,
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

  it("preserves established provider settings when restarting an idle session", () => {
    expect(derive(makeSession("ready"))).toMatchObject({
      status: "starting",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
    });
  });

  it.each(["starting", "running"] as const)("does not replace a %s session", (status) => {
    expect(derive(makeSession(status))).toBeNull();
  });

  it("clears terminal error details when a new turn starts", () => {
    expect(derive(makeSession("error"))).toMatchObject({
      status: "starting",
      activeTurnId: null,
      lastError: null,
    });
  });
});

describe("deriveTurnAttribution", () => {
  it("pins the external agent revision and spawning profile for an external selection", () => {
    const profileId = AgentProfileId.makeUnsafe("agentprofile_attribution");
    const revisionId = AgentProfileRevisionId.makeUnsafe("rev_attribution");
    expect(
      deriveTurnAttribution({
        modelSelection: {
          provider: "external",
          instanceId: "external",
          profileId,
          revisionId,
          model: "cline",
        },
      }),
    ).toEqual({ externalAgentRevisionId: revisionId, spawningProfileId: profileId });
  });

  it("returns null attribution for built-in provider selections", () => {
    expect(
      deriveTurnAttribution({
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
      }),
    ).toEqual({ externalAgentRevisionId: null, spawningProfileId: null });
  });

  it("returns null attribution when no model selection is present", () => {
    expect(deriveTurnAttribution({ modelSelection: undefined })).toEqual({
      externalAgentRevisionId: null,
      spawningProfileId: null,
    });
  });
});
