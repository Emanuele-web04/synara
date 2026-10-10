import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-10-02T18:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-provider-handoff");
const SOURCE: ModelSelection = { provider: "codex", model: "gpt-5.4" };

function makeReadModel(
  session: OrchestrationReadModel["threads"][number]["session"] = null,
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-provider-handoff"),
        title: "Provider handoff",
        modelSelection: SOURCE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: "feature/handoff",
        worktreePath: "/tmp/worktrees/handoff",
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: null,
        handoff: null,
        messages: [],
        session,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

const decideHandoff = (modelSelection: ModelSelection, readModel = makeReadModel()) =>
  Effect.runPromise(
    decideOrchestrationCommand({
      command: {
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-provider-handoff"),
        threadId: THREAD_ID,
        modelSelection,
        providerHandoff: true,
      },
      readModel,
    }),
  );

describe("decider same-thread provider handoff", () => {
  it("records the source selection alongside the target selection", async () => {
    const event = await decideHandoff({ provider: "claudeAgent", model: "claude-sonnet-4-6" });
    const single = Array.isArray(event) ? event[0] : event;
    expect(single).toMatchObject({
      type: "thread.meta-updated",
      payload: {
        threadId: THREAD_ID,
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        providerHandoff: { sourceModelSelection: SOURCE },
      },
    });
    // The handoff only rebinds the provider; the workspace stays untouched.
    expect(single?.payload).not.toHaveProperty("worktreePath");
    expect(single?.payload).not.toHaveProperty("branch");
  });

  it("keeps same-provider account switches on the new-thread handoff", async () => {
    await expect(
      decideHandoff({
        provider: "codex",
        instanceId: "codex-work",
        model: "gpt-5.4",
      }),
    ).rejects.toThrow(/hand off to a new thread instead/);
  });

  it("rejects a handoff while the session is running", async () => {
    await expect(
      decideHandoff(
        { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        makeReadModel({
          threadId: THREAD_ID,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        }),
      ),
    ).rejects.toThrow(/still has a running turn/);
  });
});
