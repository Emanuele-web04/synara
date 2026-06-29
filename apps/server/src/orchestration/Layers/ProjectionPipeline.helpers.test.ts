import { RuntimeItemId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  retainProjectionProviderItemsAfterConversationRollback,
  retainProjectionProviderItemsAfterRevert,
} from "./ProjectionPipeline.helpers.ts";
import type { ProjectionThreadProviderItem } from "../../persistence/Services/ProjectionThreadProviderItems.ts";
import type { ProjectionTurn } from "../../persistence/Services/ProjectionTurns.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-provider-retention");

function providerItem(id: string, turnId: TurnId | null): ProjectionThreadProviderItem {
  const createdAt = "2026-06-28T00:00:00.000Z";
  const runtimeItemId = RuntimeItemId.makeUnsafe(id);
  return {
    providerItemId: runtimeItemId,
    threadId: THREAD_ID,
    turnId,
    item: {
      id: runtimeItemId,
      providerItemId: null,
      provider: "codex",
      turnId,
      itemType: "command_execution",
      status: "completed",
      title: "Tool call",
      detail: null,
      data: null,
      content: [],
      sourceRef: null,
      createdAt,
      updatedAt: createdAt,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

function projectionTurn(turnId: TurnId, checkpointTurnCount: number | null): ProjectionTurn {
  return {
    threadId: THREAD_ID,
    turnId,
    pendingMessageId: null,
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    assistantMessageId: null,
    state: "completed",
    requestedAt: "2026-06-28T00:00:00.000Z",
    startedAt: "2026-06-28T00:00:01.000Z",
    completedAt: "2026-06-28T00:00:02.000Z",
    checkpointTurnCount,
    checkpointRef: null,
    checkpointStatus: null,
    checkpointFiles: [],
  };
}

describe("provider item projection retention", () => {
  it("keeps turnless and retained-turn provider items after checkpoint revert", () => {
    const turnOne = TurnId.makeUnsafe("turn-1");
    const turnTwo = TurnId.makeUnsafe("turn-2");
    const retained = retainProjectionProviderItemsAfterRevert(
      [
        providerItem("provider-turnless", null),
        providerItem("provider-turn-1", turnOne),
        providerItem("provider-turn-2", turnTwo),
      ],
      [projectionTurn(turnOne, 1), projectionTurn(turnTwo, 2)],
      1,
    );

    expect(retained.map((item) => item.providerItemId)).toEqual([
      RuntimeItemId.makeUnsafe("provider-turnless"),
      RuntimeItemId.makeUnsafe("provider-turn-1"),
    ]);
  });

  it("keeps turnless and retained-turn provider items after conversation rollback", () => {
    const turnOne = TurnId.makeUnsafe("turn-1");
    const turnTwo = TurnId.makeUnsafe("turn-2");
    const retained = retainProjectionProviderItemsAfterConversationRollback(
      [
        providerItem("provider-turnless", null),
        providerItem("provider-turn-1", turnOne),
        providerItem("provider-turn-2", turnTwo),
      ],
      new Set([turnTwo]),
    );

    expect(retained.map((item) => item.providerItemId)).toEqual([
      RuntimeItemId.makeUnsafe("provider-turnless"),
      RuntimeItemId.makeUnsafe("provider-turn-1"),
    ]);
  });
});
