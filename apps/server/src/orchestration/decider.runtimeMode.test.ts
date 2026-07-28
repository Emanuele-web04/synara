import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-25T18:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-auto-claude");

function makeReadModel(supportsAutoMode: boolean): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-auto-claude"),
        title: "Claude Auto",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          supportsAutoMode,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "auto",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: null,
        handoff: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

describe("decider Auto model compatibility", () => {
  it("rejects changing an Auto thread to a Claude model reported as unsupported", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-unsupported-claude-model"),
            threadId: THREAD_ID,
            modelSelection: {
              provider: "claudeAgent",
              model: "claude-haiku-4-5",
              supportsAutoMode: false,
            },
          },
          readModel: makeReadModel(true),
        }),
      ),
    ).rejects.toThrow('Claude model "claude-haiku-4-5" does not support Auto mode.');
  });

  it("rejects enabling Auto when the current Claude model is reported as unsupported", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.runtime-mode.set",
            commandId: CommandId.makeUnsafe("cmd-enable-auto-unsupported-model"),
            threadId: THREAD_ID,
            runtimeMode: "auto",
            createdAt: NOW,
          },
          readModel: makeReadModel(false),
        }),
      ),
    ).rejects.toThrow('Claude model "claude-opus-4-6" does not support Auto mode.');
  });

  it("allows a Claude model reported as Auto-compatible", async () => {
    const event = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-supported-claude-model"),
          threadId: THREAD_ID,
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-fable-5",
            supportsAutoMode: true,
          },
        },
        readModel: makeReadModel(true),
      }),
    );

    expect("type" in event ? event.type : event[0]?.type).toBe("thread.meta-updated");
  });
});
