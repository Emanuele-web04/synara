import { describe, expect, it } from "vitest";
import {
  CheckpointRef,
  MessageId,
  ProviderInstanceId,
  TurnId,
  type ModelSelection,
  type ProviderModelDescriptor,
} from "@synara/contracts";

import {
  buildRetryConfirmCopy,
  filterSupportedRetryEfforts,
  mergeRetryVariants,
  planRetryEffortChange,
  resolveEffortFromModelSelection,
  resolvePrecedingUserMessage,
  resolveRetryWithDifferentEffortAvailability,
  retryEffortDisabledReasonLabel,
  type RetryEffortVariant,
  type VerifiedRetryEffortTarget,
} from "./retryWithDifferentEffort.logic";

const userId = MessageId.makeUnsafe("user-1");
const assistantId = MessageId.makeUnsafe("assistant-1");
const turnId = TurnId.makeUnsafe("turn-1");

const codexSelection = {
  provider: "codex",
  instanceId: ProviderInstanceId.makeUnsafe("codex-work"),
  model: "gpt-5.4",
  options: { reasoningEffort: "medium" },
} as ModelSelection;

// Explicit fixture evidence only. Current production snapshots intentionally
// supply no verified target, so the draft retry action remains disabled.
const retryTarget: VerifiedRetryEffortTarget = {
  assistantMessageId: assistantId,
  userMessageId: userId,
  turnId,
  prompt: "fix the flaky test",
  modelSelection: codexSelection,
  baselineCheckpointRef: CheckpointRef.makeUnsafe("refs/synara/checkpoints/test/turn-start/turn-1"),
};

function messages() {
  return [
    {
      id: userId,
      role: "user" as const,
      text: "fix the flaky test",
      turnId: null,
      streaming: false,
    },
    {
      id: assistantId,
      role: "assistant" as const,
      text: "I looked at the flake.",
      turnId,
      streaming: false,
    },
  ];
}

describe("resolveRetryWithDifferentEffortAvailability", () => {
  it("disables with a clear reason when no pre-turn checkpoint exists", () => {
    const availability = resolveRetryWithDifferentEffortAvailability({
      messages: messages(),
      assistantMessageId: assistantId,
      assistantTurnId: turnId,
      showAssistantCopyButton: true,
      assistantTurnInProgress: false,
      runtimeMode: "approval-required",
      retryTarget,
      turnDiffSummary: undefined,
      activeTurnId: null,
      isBusy: false,
    });
    expect(availability.enabled).toBe(false);
    if (availability.enabled) return;
    expect(availability.reason).toBe("no-checkpoint");
    expect(availability.detail).toContain("no pre-turn workspace checkpoint");
    expect(retryEffortDisabledReasonLabel(availability.reason)).toContain("checkpoint");
  });

  it("disables outside approval-required mode", () => {
    const availability = resolveRetryWithDifferentEffortAvailability({
      messages: messages(),
      assistantMessageId: assistantId,
      assistantTurnId: turnId,
      showAssistantCopyButton: true,
      assistantTurnInProgress: false,
      runtimeMode: "full-access",
      retryTarget,
      turnDiffSummary: {
        turnId,
        completedAt: "2026-09-14T00:00:00.000Z",
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
      },
      activeTurnId: null,
      isBusy: false,
    });
    expect(availability.enabled).toBe(false);
    if (availability.enabled) return;
    expect(availability.reason).toBe("not-approval-required");
  });

  it("enables for a settled tail turn with checkpoint and alternate efforts", () => {
    const availability = resolveRetryWithDifferentEffortAvailability({
      messages: messages(),
      assistantMessageId: assistantId,
      assistantTurnId: turnId,
      showAssistantCopyButton: true,
      assistantTurnInProgress: false,
      runtimeMode: "approval-required",
      retryTarget,
      turnDiffSummary: {
        turnId,
        completedAt: "2026-09-14T00:00:00.000Z",
        status: "ready",
        files: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
        checkpointTurnCount: 2,
        checkpointRef: "refs/synara/checkpoints/demo/turn/2" as never,
      },
      activeTurnId: null,
      isBusy: false,
    });
    expect(availability.enabled).toBe(true);
    if (!availability.enabled) return;
    expect(availability.userMessageId).toBe(userId);
    expect(availability.checkpointTurnCount).toBe(2);
    expect(availability.changedFileCount).toBe(1);
    expect(
      availability.effortOptions.some((option) => option.value === "medium" && option.isCurrent),
    ).toBe(true);
    expect(availability.effortOptions.some((option) => !option.isCurrent)).toBe(true);
  });

  it.each([null, { ...retryTarget, prompt: "an older prompt" }])(
    "refuses missing or stale source evidence even when a post-turn checkpoint exists",
    (target) => {
      const availability = resolveRetryWithDifferentEffortAvailability({
        messages: messages(),
        assistantMessageId: assistantId,
        assistantTurnId: turnId,
        showAssistantCopyButton: true,
        assistantTurnInProgress: false,
        runtimeMode: "approval-required",
        retryTarget: target,
        turnDiffSummary: {
          turnId,
          completedAt: "2026-09-14T00:00:00.000Z",
          status: "ready",
          files: [],
          checkpointTurnCount: 1,
        },
        activeTurnId: null,
        isBusy: false,
      });
      expect(availability).toMatchObject({ enabled: false, reason: "unverified-target" });
      if (!availability.enabled) expect(availability.detail).toContain("could not be verified");
    },
  );

  it.each([
    [{ provider: "codex", model: "gpt-5.4" }, "high"],
    [{ provider: "claudeAgent", model: "claude-opus-4-8" }, "high"],
  ] as const)("recognizes the effective native default for %o", (source, effort) => {
    expect(resolveEffortFromModelSelection(source)).toBe(effort);
    expect(
      planRetryEffortChange({
        provider: source.provider,
        model: source.model,
        modelOptions: undefined,
        prompt: "fix the flaky test",
        nextEffort: effort,
      }),
    ).toBeNull();
  });

  it("reads Devin effort independently of the concrete model variant", () => {
    const runtimeModel: ProviderModelDescriptor = {
      slug: "gpt-5-6-sol",
      name: "GPT-5.6 Sol",
      supportedReasoningEfforts: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      defaultReasoningEffort: "low",
      modelVariants: [
        { model: "gpt-5-6-sol-low", reasoningEffort: "low" },
        { model: "gpt-5-6-sol-high", reasoningEffort: "high" },
      ],
    };
    expect(
      resolveEffortFromModelSelection(
        {
          provider: "devin",
          model: "gpt-5-6-sol",
          options: { reasoningEffort: "high", modelVariant: "gpt-5-6-sol-high" },
        },
        { runtimeModel },
      ),
    ).toBe("high");
  });

  it("never invents unsupported effort values when planning a retry", () => {
    const planned = planRetryEffortChange({
      provider: "codex",
      model: "gpt-5.4",
      modelOptions: { reasoningEffort: "medium" },
      prompt: "fix the flaky test",
      nextEffort: "not-a-real-effort",
    });
    expect(planned).toBeNull();
  });

  it("builds a model selection that only changes effort", () => {
    const planned = planRetryEffortChange({
      provider: "codex",
      model: "gpt-5.4",
      modelOptions: { reasoningEffort: "medium" },
      prompt: "fix the flaky test",
      nextEffort: "high",
      instanceId: ProviderInstanceId.makeUnsafe("codex-work"),
    });
    expect(planned).not.toBeNull();
    expect(planned?.nextModelSelection.instanceId).toBe("codex-work");
    expect(planned?.nextModelSelection.provider).toBe("codex");
    expect(planned?.nextModelSelection.model).toBe("gpt-5.4");
    expect(resolveEffortFromModelSelection(planned?.nextModelSelection)).toBe("high");
  });
});

describe("retry effort variants", () => {
  it("keeps archived answers when merging the live tip", () => {
    const archived: RetryEffortVariant[] = [
      {
        id: "v1",
        assistantMessageId: MessageId.makeUnsafe("assistant-old"),
        turnId,
        text: "old answer",
        effort: "low",
        effortLabel: "Low",
        provider: "codex",
        model: "gpt-5.4",
        createdAt: "2026-09-14T00:00:00.000Z",
        checkpointTurnCount: 1,
        changedFileCount: 0,
      },
    ];
    const live: RetryEffortVariant = {
      id: "live",
      assistantMessageId: assistantId,
      turnId,
      text: "new answer",
      effort: "high",
      effortLabel: "High",
      provider: "codex",
      model: "gpt-5.4",
      createdAt: "2026-09-14T00:01:00.000Z",
      checkpointTurnCount: 1,
      changedFileCount: 0,
    };
    const merged = mergeRetryVariants({ archived, live });
    expect(merged.map((variant) => variant.text)).toEqual(["old answer", "new answer"]);
    expect(merged.map((variant) => variant.effort)).toEqual(["low", "high"]);
  });

  it("filters blank effort values out of the picker", () => {
    expect(
      filterSupportedRetryEfforts([
        { value: "low", label: "Low", isCurrent: false },
        { value: "  ", label: "Blank", isCurrent: false },
        { value: "high", label: "High", isCurrent: true },
      ]).map((option) => option.value),
    ).toEqual(["low", "high"]);
  });
});

describe("buildRetryConfirmCopy", () => {
  it.each([0, 3])(
    "describes the pre-turn restore and recovery limits with %i changed files",
    (changedFileCount) => {
      const copy = buildRetryConfirmCopy({
        changedFileCount,
        checkpointTurnCount: 2,
        nextEffortLabel: "High",
        currentEffortLabel: "Low",
      });
      expect(copy).toContain("High");
      if (changedFileCount > 0) expect(copy).toContain("3 files");
      expect(copy).toContain("checkpoint 1");
      expect(copy).toContain("pre-retry snapshot");
      expect(copy).toContain("variant pager");
      expect(copy).toContain("cannot restore provider conversation history");
    },
  );
});

describe("resolvePrecedingUserMessage", () => {
  it("finds the user prompt that produced the assistant turn", () => {
    expect(
      resolvePrecedingUserMessage({
        messages: messages(),
        assistantMessageId: assistantId,
      }),
    ).toEqual({
      messageId: userId,
      text: "fix the flaky test",
      index: 0,
    });
  });
});
