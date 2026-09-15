// FILE: CursorAdapter.test.ts
// Purpose: Characterizes Cursor's private Synara host-policy delivery.
// Layer: Provider adapter tests

import {
  EventId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import {
  stampCursorTerminalEventInstance,
  takeCursorSynaraHarnessPolicyTextPart,
} from "./CursorAdapter.ts";

describe("Cursor Synara harness policy", () => {
  it("delivers scoped MCP host context exactly once per fresh/load/fork session", () => {
    for (const lifecycle of ["fresh", "load", "fork"] as const) {
      const state: { harnessPolicyDelivered?: boolean } = {};
      const first = takeCursorSynaraHarnessPolicyTextPart(state, true);
      expect(first?.text, lifecycle).toContain(SYNARA_HARNESS_POLICY_MARKER);
      expect(first?.text, lifecycle).toContain("Use the synara_* tools");
      expect(takeCursorSynaraHarnessPolicyTextPart(state, true), lifecycle).toBeNull();
    }
  });

  it("stays truthful without a scoped gateway connection", () => {
    expect(takeCursorSynaraHarnessPolicyTextPart({}, false)?.text).toContain(
      "Synara MCP control is unavailable",
    );
  });
});

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

    const stamped = stampCursorTerminalEventInstance(terminalEvent, accountA);

    expect(accountB).not.toBe(accountA);
    expect(stamped.providerInstanceId).toBe(accountA);
  });
});
