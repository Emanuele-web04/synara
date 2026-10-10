import { ProjectId, ThreadId } from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  GROUPS_BETA_ONLY_MESSAGE,
  gateProjectAgentServiceForStable,
  isGroupProjectCommand,
} from "./groupsBetaGate";
import type { ProjectAgentServiceShape } from "./Services/ProjectAgentService";

const PROJECT_ID = ProjectId.makeUnsafe("project-group");
const THREAD_ID = ThreadId.makeUnsafe("thread-coordinator");

function gatedService() {
  const onProjectDeleted = vi.fn(() => Effect.void);
  const service = { onProjectDeleted } as unknown as ProjectAgentServiceShape;
  return { gated: gateProjectAgentServiceForStable(service), onProjectDeleted };
}

describe("gateProjectAgentServiceForStable", () => {
  it("refuses hub APIs with the Beta message", async () => {
    const { gated } = gatedService();
    const error = await Effect.runPromise(
      Effect.flip(gated.getOverview({ projectId: PROJECT_ID }, { kind: "user" })),
    );
    expect(error.message).toBe(GROUPS_BETA_ONLY_MESSAGE);
    expect(error.code).toBe("forbidden");
  });

  it("answers the lists and streams the web reads everywhere with nothing", async () => {
    const { gated } = gatedService();
    await expect(Effect.runPromise(gated.listSummaries({}, { kind: "user" }))).resolves.toEqual({
      summaries: [],
    });
    const events = await Effect.runPromise(
      Stream.runCollect(gated.streamEvents({ projectId: PROJECT_ID })),
    );
    expect(Array.from(events)).toEqual([]);
  });

  it("treats a hub thread's turn like any other thread's", async () => {
    const { gated } = gatedService();
    await expect(Effect.runPromise(gated.formatContextPacketForTurn(THREAD_ID))).resolves.toBe("");
    await expect(
      Effect.runPromise(gated.assertGroupCoordinatorTurnAllowed({ threadId: THREAD_ID })),
    ).resolves.toBeUndefined();
  });

  it("still cleans up hub data when a project is deleted", async () => {
    const { gated, onProjectDeleted } = gatedService();
    await Effect.runPromise(gated.onProjectDeleted(PROJECT_ID));
    expect(onProjectDeleted).toHaveBeenCalledWith(PROJECT_ID);
  });
});

describe("isGroupProjectCommand", () => {
  it("matches only commands that create or re-kind a hub", () => {
    expect(isGroupProjectCommand({ type: "project.create", kind: "group" })).toBe(true);
    expect(isGroupProjectCommand({ type: "project.meta.update", kind: "group" })).toBe(true);
    expect(isGroupProjectCommand({ type: "project.create", kind: "project" })).toBe(false);
    expect(isGroupProjectCommand({ type: "thread.create", kind: "group" })).toBe(false);
  });
});
