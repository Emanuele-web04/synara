import { EventId, ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
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
});
