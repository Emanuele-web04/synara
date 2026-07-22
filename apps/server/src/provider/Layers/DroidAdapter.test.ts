import { TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";

import {
  extractDroidApproveSpecPlanMarkdown,
  isDroidNestedTaskToolCall,
  isExpectedDroidPlanRejection,
  isRenderableDroidAssistantDelta,
  resolveDroidSessionCwd,
  scopeDroidRuntimeItemIdForTurn,
  scopeDroidToolCallStateForTurn,
  shouldIgnoreDroidInterrupt,
  takeDroidSynaraHarnessPolicyTextPart,
} from "./DroidAdapter.ts";

describe("Droid Synara harness policy", () => {
  it("delivers private scoped host context once", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    expect(takeDroidSynaraHarnessPolicyTextPart(state, true)?.text).toContain(
      SYNARA_HARNESS_POLICY_MARKER,
    );
    expect(takeDroidSynaraHarnessPolicyTextPart(state, true)).toBeNull();
  });
});

const serverConfig = {
  cwd: "/server/cwd",
  homeDir: "/home/test",
} as Parameters<typeof resolveDroidSessionCwd>[1];

describe("resolveDroidSessionCwd", () => {
  it("prefers an explicit cwd over the active thread session cwd", () => {
    expect(resolveDroidSessionCwd("/explicit", serverConfig, "/thread")).toBe("/explicit");
  });

  it("uses the active thread session cwd before the server fallback", () => {
    expect(resolveDroidSessionCwd(undefined, serverConfig, "/thread")).toBe("/thread");
  });
});

describe("DroidAdapter runtime event scoping", () => {
  it("makes reused ACP assistant segment ids unique per turn", () => {
    const providerItemId = "assistant:droid-session:segment:5";

    expect(scopeDroidRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-a"), providerItemId)).toBe(
      "droid:turn-a:assistant:droid-session:segment:5",
    );
    expect(scopeDroidRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-b"), providerItemId)).toBe(
      "droid:turn-b:assistant:droid-session:segment:5",
    );
  });

  it("extracts Droid's current Approve Spec plan and recognizes its expected rejection", () => {
    const pending = {
      toolCallId: "spec-1",
      title: "Approve Spec",
      status: "pending" as const,
      data: {
        rawInput: {
          title: "Add the probe",
          plan: "\n# Plan\n\n- Add a focused test\n",
        },
      },
    };
    expect(extractDroidApproveSpecPlanMarkdown(pending)).toBe("# Plan\n\n- Add a focused test");
    expect(
      isExpectedDroidPlanRejection({
        ...pending,
        status: "failed",
        detail:
          "Error: Plan not approved - remaining in Spec Mode. Provide feedback to refine the spec.",
      }),
    ).toBe(true);
  });

  it("preserves the provider tool id while scoping the runtime item id", () => {
    const scoped = scopeDroidToolCallStateForTurn(TurnId.makeUnsafe("turn-a"), {
      toolCallId: "call-1",
      kind: "execute",
      status: "completed",
      title: "Ran command",
      data: {
        toolCallId: "call-1",
      },
    });

    expect(scoped.toolCallId).toBe("droid:turn-a:call-1");
    expect(scoped.data).toMatchObject({
      toolCallId: "call-1",
      providerToolCallId: "call-1",
    });
  });

  it("only treats visible assistant text as renderable Droid content", () => {
    expect(
      isRenderableDroidAssistantDelta({
        streamKind: "assistant_text",
        text: "done",
      }),
    ).toBe(true);
    expect(
      isRenderableDroidAssistantDelta({
        streamKind: "assistant_text",
        text: "   ",
      }),
    ).toBe(false);
  });

  it("recognizes Factory Task rows whose child progress is hidden from parent ACP", () => {
    expect(
      isDroidNestedTaskToolCall({
        toolCallId: "task-1",
        title: "Task",
        status: "pending",
        data: { rawInput: { subagent_type: "worker" } },
      }),
    ).toBe(true);
    expect(
      isDroidNestedTaskToolCall({
        toolCallId: "read-1",
        title: "Read",
        status: "pending",
        data: {},
      }),
    ).toBe(false);
  });

  it("ignores a delayed stop when its turn is no longer active", () => {
    const oldTurnId = TurnId.makeUnsafe("turn-a");
    const newTurnId = TurnId.makeUnsafe("turn-b");

    expect(shouldIgnoreDroidInterrupt(oldTurnId, newTurnId)).toBe(true);
    expect(shouldIgnoreDroidInterrupt(oldTurnId, undefined)).toBe(true);
    expect(shouldIgnoreDroidInterrupt(newTurnId, newTurnId)).toBe(false);
    expect(shouldIgnoreDroidInterrupt(undefined, newTurnId)).toBe(false);
  });
});
