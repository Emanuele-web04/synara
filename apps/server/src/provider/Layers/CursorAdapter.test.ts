import {
  EventId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { stampCursorTerminalEventInstance } from "./CursorAdapter.ts";

describe("CursorAdapter terminal event identity", () => {
  it("keeps the stopped account identity after the thread is rebound to another account", () => {
    const accountA = "cursor_account_a" as ProviderInstanceId;
    const accountB = "cursor_account_b" as ProviderInstanceId;
    const terminalEvent: ProviderRuntimeEvent = {
      type: "session.exited",
      eventId: EventId.makeUnsafe("cursor-exit-a"),
      provider: "cursor",
      threadId: ThreadId.makeUnsafe("shared-cursor-thread"),
      createdAt: "2026-07-11T00:00:00.000Z",
      payload: { exitKind: "graceful" },
    };

    const capturedInstanceId = accountA;
    const currentInstanceId = accountB;
    const stamped = stampCursorTerminalEventInstance(terminalEvent, capturedInstanceId);

    expect(currentInstanceId).toBe(accountB);
    expect(stamped.providerInstanceId).toBe(accountA);
  });
});
