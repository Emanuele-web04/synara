import {
  EventId,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  coalesceProviderRuntimeProgress,
  providerRuntimeProgressKey,
} from "./providerRuntimeProgressCoalescing.ts";

const threadId = ThreadId.makeUnsafe("progress-thread");
const turnId = TurnId.makeUnsafe("progress-turn");
const event = (id: string, overrides: Partial<ProviderRuntimeEvent> = {}): ProviderRuntimeEvent =>
  ({
    type: "tool.progress",
    eventId: EventId.makeUnsafe(id),
    provider: "claudeAgent",
    createdAt: "2026-10-06T12:00:00.000Z",
    threadId,
    turnId,
    payload: { toolUseId: "tool-a", toolName: "Bash", elapsedSeconds: 1 },
    ...overrides,
  }) as ProviderRuntimeEvent;
const row = (sequence: number, value: ProviderRuntimeEvent) => ({ sequence, event: value });

const ids = (rows: ReadonlyArray<{ event: ProviderRuntimeEvent }>) =>
  rows.map((entry) => entry.event.eventId);

describe("provider runtime progress coalescing", () => {
  it("retains latest snapshots in source order for parallel tools and tasks", () => {
    const task = (id: string) =>
      event(id, {
        type: "task.progress",
        payload: { taskId: RuntimeTaskId.makeUnsafe("task-a"), description: id },
      });
    const input = [
      row(1, event("tool-a-old")),
      row(
        2,
        event("tool-b", { payload: { toolUseId: "tool-b", toolName: "Bash", elapsedSeconds: 2 } }),
      ),
      row(3, task("task-old")),
      row(
        4,
        event("tool-a-latest", {
          payload: { toolUseId: "tool-a", toolName: "Bash", elapsedSeconds: 4 },
        }),
      ),
      row(5, task("task-latest")),
    ];
    expect(ids(coalesceProviderRuntimeProgress(input))).toEqual([
      "tool-b",
      "tool-a-latest",
      "task-latest",
    ]);
    expect(input).toHaveLength(5);
  });

  it.each([
    "content.delta",
    "request.opened",
    "item.completed",
    "task.completed",
    "turn.completed",
    "session.exited",
  ])("flushes the latest update before %s without merging across its boundary", (type) => {
    const boundary = event("boundary", { type } as Partial<ProviderRuntimeEvent>);
    const input = [
      row(1, event("old")),
      row(2, event("before")),
      row(3, boundary),
      row(4, event("after-old")),
      row(5, event("after")),
    ];
    expect(ids(coalesceProviderRuntimeProgress(input))).toEqual(["before", "boundary", "after"]);
  });

  it("keeps turn, provider instance, lifecycle generation and native child identities independent", () => {
    const variants = [
      event("base"),
      event("other-turn", { turnId: TurnId.makeUnsafe("other-turn") }),
      event("other-instance", { providerInstanceId: ProviderInstanceId.makeUnsafe("secondary") }),
      event("other-generation", { lifecycleGeneration: "generation-2" }),
      event("child", {
        providerRefs: {
          providerThreadId: "child-native-thread",
          providerParentThreadId: "parent-native-thread",
        },
      }),
    ];
    expect(new Set(variants.map(providerRuntimeProgressKey)).size).toBe(5);
    expect(
      ids(coalesceProviderRuntimeProgress(variants.map((value, index) => row(index + 1, value)))),
    ).toEqual(["base", "other-turn", "other-instance", "other-generation", "child"]);
  });

  it("coalesces only in-progress tool snapshots with stable IDs", () => {
    const tool = event("tool", {
      type: "item.updated",
      itemId: RuntimeItemId.makeUnsafe("item-a"),
      payload: { itemType: "command_execution", status: "inProgress", detail: "running" },
    });
    expect(providerRuntimeProgressKey(tool)).toBeDefined();
    for (const itemType of [
      "reasoning",
      "collab_agent_tool_call",
      "context_compaction",
      "assistant_message",
    ]) {
      expect(
        providerRuntimeProgressKey(
          event(itemType, {
            type: "item.updated",
            itemId: RuntimeItemId.makeUnsafe("item-a"),
            payload: { itemType, status: "inProgress" },
          } as Partial<ProviderRuntimeEvent>),
        ),
      ).toBeUndefined();
    }
    expect(
      providerRuntimeProgressKey(event("no-id", { payload: { elapsedSeconds: 1 } })),
    ).toBeUndefined();
    expect(
      providerRuntimeProgressKey(
        event("completed", {
          type: "item.updated",
          itemId: RuntimeItemId.makeUnsafe("item-a"),
          payload: { itemType: "command_execution", status: "completed" },
        }),
      ),
    ).toBeUndefined();
  });
});
