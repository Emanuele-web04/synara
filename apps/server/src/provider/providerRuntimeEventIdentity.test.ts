import { EventId, RuntimeTaskId, ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { assignDerivedProviderRuntimeEventIds } from "./providerRuntimeEventIdentity.ts";

const base = {
  eventId: EventId.makeUnsafe("native-event"),
  provider: "codex" as const,
  threadId: ThreadId.makeUnsafe("thread-derived-events"),
  createdAt: "2026-07-23T20:00:00.000Z",
};

describe("assignDerivedProviderRuntimeEventIds", () => {
  it("keeps singleton native ids unchanged", () => {
    const event = {
      ...base,
      type: "runtime.warning",
      payload: { message: "warning" },
    } satisfies ProviderRuntimeEvent;
    expect(assignDerivedProviderRuntimeEventIds([event])).toEqual([event]);
  });

  it("assigns stable distinct ids when one native event expands", () => {
    const events = [
      {
        ...base,
        type: "task.completed",
        payload: { taskId: RuntimeTaskId.makeUnsafe("task-1"), status: "completed" },
      },
      {
        ...base,
        type: "turn.proposed.completed",
        payload: { planMarkdown: "# Plan" },
      },
    ] satisfies ReadonlyArray<ProviderRuntimeEvent>;

    const assigned = assignDerivedProviderRuntimeEventIds(events);
    expect(assigned.map((event) => event.eventId)).toEqual([
      "native-event:task.completed:0",
      "native-event:turn.proposed.completed:1",
    ]);
  });
});
