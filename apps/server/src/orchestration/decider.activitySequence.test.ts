import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-09-10T00:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-activity-sequence");

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 10,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-activity-sequence"),
        title: "Activity sequence",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        handoff: null,
        messages: [],
        proposedPlans: [],
        activities: [
          {
            id: EventId.makeUnsafe("provider-activity"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Approval requested",
            payload: { requestId: "approval-1", requestKind: "command" },
            turnId: null,
            sequence: 1_695_339,
            createdAt: NOW,
          },
        ],
        checkpoints: [],
        session: null,
      },
    ],
  };
}

async function decideActivity(sequence?: number) {
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      readModel: makeReadModel(),
      command: {
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`append-activity-${sequence ?? "unsequenced"}`),
        threadId: THREAD_ID,
        activity: {
          id: EventId.makeUnsafe(`activity-${sequence ?? "unsequenced"}`),
          tone: "error",
          kind: "provider.approval.respond.failed",
          summary: "Approval response failed",
          payload: { requestId: "approval-1" },
          turnId: null,
          ...(sequence !== undefined ? { sequence } : {}),
          createdAt: NOW,
        },
        createdAt: NOW,
      },
    }),
  );
  const event = Array.isArray(result) ? result[0] : result;
  if (event.type !== "thread.activity-appended") {
    throw new Error(`Expected thread.activity-appended, received ${event.type}`);
  }
  return event.payload.activity;
}

describe("thread.activity.append sequence", () => {
  it("places an unsequenced server activity after the latest thread activity", async () => {
    await expect(decideActivity()).resolves.toMatchObject({ sequence: 1_695_340 });
  });

  it("preserves an explicit provider runtime sequence", async () => {
    await expect(decideActivity(42)).resolves.toMatchObject({ sequence: 42 });
  });
});
