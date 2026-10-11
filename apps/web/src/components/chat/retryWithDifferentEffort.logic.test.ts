import { describe, expect, it } from "vitest";
import {
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
} from "./retryWithDifferentEffort.logic";

const userId = MessageId.makeUnsafe("user-1");
const assistantId = MessageId.makeUnsafe("assistant-1");
const turnId = TurnId.makeUnsafe("turn-1");

const codexSelection = {
  provider: "codex",
  model: "gpt-5.4",
  options: { reasoningEffort: "medium" },
} as ModelSelection;

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

const runtimeModel: ProviderModelDescriptor = {
  slug: "gateway-model",
  name: "Gateway model",
  supportedReasoningEfforts: [{ value: "low" }, { value: "high" }],
  defaultReasoningEffort: "high",
};

function availableInput(): Parameters<typeof resolveRetryWithDifferentEffortAvailability>[0] {
  return {
    messages: messages(),
    assistantMessageId: assistantId,
    assistantTurnId: turnId,
    showAssistantCopyButton: true,
    assistantTurnInProgress: false,
    runtimeMode: "approval-required",
    modelSelection: { provider: "codex", model: runtimeModel.slug },
    modelOptions: undefined,
    runtimeModel,
    turnDiffSummary: {
      turnId,
      completedAt: "2026-09-14T00:00:00.000Z",
      files: [],
      checkpointTurnCount: 2,
      checkpointRef: "refs/synara/checkpoints/demo/turn/2" as never,
    },
    activeTurnId: null,
    isBusy: false,
  };
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
      modelSelection: codexSelection,
      modelOptions: { reasoningEffort: "medium" },
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
      modelSelection: codexSelection,
      modelOptions: { reasoningEffort: "medium" },
      turnDiffSummary: {
        turnId,
        completedAt: "2026-09-14T00:00:00.000Z",
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
      modelSelection: codexSelection,
      modelOptions: { reasoningEffort: "medium" },
      turnDiffSummary: {
        turnId,
        completedAt: "2026-09-14T00:00:00.000Z",
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
    });
    expect(planned).not.toBeNull();
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
  it("mentions the pre-retry snapshot and file restore target", () => {
    const copy = buildRetryConfirmCopy({
      changedFileCount: 3,
      checkpointTurnCount: 2,
      nextEffortLabel: "High",
      currentEffortLabel: "Low",
    });
    expect(copy).toContain("High");
    expect(copy).toContain("3 files");
    expect(copy).toContain("checkpoint 1");
    expect(copy).toContain("pre-retry snapshot");
    expect(copy).toContain("variant pager");
  });
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

describe("retry effort safety boundaries", () => {
  it.each([undefined, ""])(
    "requires a real checkpoint ref, not just a turn counter (%s)",
    (checkpointRef) => {
      const input = availableInput();
      const availability = resolveRetryWithDifferentEffortAvailability({
        ...input,
        turnDiffSummary: { ...input.turnDiffSummary!, checkpointRef: checkpointRef as never },
      });
      expect(availability.enabled).toBe(false);
      if (availability.enabled) return;
      expect(availability.reason).toBe("no-checkpoint");
    },
  );

  it.each(["missing", "error"] as const)("refuses a checkpoint with status %s", (status) => {
    const input = availableInput();
    const availability = resolveRetryWithDifferentEffortAvailability({
      ...input,
      turnDiffSummary: { ...input.turnDiffSummary!, status },
    });
    expect(availability.enabled).toBe(false);
    if (availability.enabled) return;
    expect(availability.reason).toBe("no-checkpoint");
  });

  it("does not let an earlier assistant answer reuse the final answer's tail prompt", () => {
    const input = availableInput();
    const availability = resolveRetryWithDifferentEffortAvailability({
      ...input,
      messages: [
        ...input.messages,
        {
          id: MessageId.makeUnsafe("later-assistant"),
          role: "assistant",
          text: "A later final answer for the same prompt.",
          turnId,
          streaming: false,
        },
      ],
    });
    expect(availability.enabled).toBe(false);
    if (availability.enabled) return;
    expect(availability.reason).toBe("not-tail");
  });

  it("marks the effective runtime default when no effort override was persisted", () => {
    const availability = resolveRetryWithDifferentEffortAvailability(availableInput());
    expect(availability.enabled).toBe(true);
    expect(availability.currentEffort).toBe("high");
    expect(availability.effortOptions.filter((option) => option.isCurrent)).toEqual([
      { value: "high", label: "High", isDefault: true, isCurrent: true },
    ]);
  });

  it("refuses a destructive retry at the already effective effort", () => {
    expect(
      planRetryEffortChange({
        provider: "codex",
        model: runtimeModel.slug,
        runtimeModel,
        modelOptions: undefined,
        prompt: "fix the flaky test",
        nextEffort: "high",
      }),
    ).toBeNull();
  });

  it("keeps the selected provider instance and unrelated model options", () => {
    const instanceId = ProviderInstanceId.makeUnsafe("codex-private");
    const planned = planRetryEffortChange({
      provider: "codex",
      instanceId,
      model: runtimeModel.slug,
      runtimeModel,
      modelOptions: { reasoningEffort: "high", fastMode: true },
      prompt: "fix the flaky test",
      nextEffort: "low",
    });
    expect(planned?.nextModelSelection).toEqual({
      provider: "codex",
      instanceId,
      model: runtimeModel.slug,
      options: { reasoningEffort: "low", fastMode: true },
    });
    expect(planned?.nextPrompt).toBe("fix the flaky test");
  });

  it("uses Devin reasoning effort without treating the concrete model variant as effort", () => {
    const availability = resolveRetryWithDifferentEffortAvailability({
      ...availableInput(),
      modelSelection: {
        provider: "devin",
        model: runtimeModel.slug,
        options: { reasoningEffort: "high", modelVariant: "gateway-model-high" },
      },
    });
    expect(availability.currentEffort).toBe("high");
    expect(availability.effortOptions.find((option) => option.isCurrent)?.value).toBe("high");
  });

  it("uses the OMP thinking level descriptor", () => {
    const availability = resolveRetryWithDifferentEffortAvailability({
      ...availableInput(),
      modelSelection: {
        provider: "omp",
        model: runtimeModel.slug,
        options: { thinkingLevel: "high" },
      },
    });
    expect(availability.currentEffort).toBe("high");
    expect(availability.effortOptions.find((option) => option.isCurrent)?.value).toBe("high");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses an invalid checkpoint turn count %s",
    (checkpointTurnCount) => {
      const input = availableInput();
      const availability = resolveRetryWithDifferentEffortAvailability({
        ...input,
        turnDiffSummary: { ...input.turnDiffSummary!, checkpointTurnCount },
      });
      expect(availability.enabled).toBe(false);
      if (availability.enabled) return;
      expect(availability.reason).toBe("no-checkpoint");
    },
  );

  it("refuses another turn's checkpoint even if its counter is valid", () => {
    const input = availableInput();
    const availability = resolveRetryWithDifferentEffortAvailability({
      ...input,
      turnDiffSummary: { ...input.turnDiffSummary!, turnId: TurnId.makeUnsafe("other-turn") },
    });
    expect(availability.enabled).toBe(false);
    if (availability.enabled) return;
    expect(availability.reason).toBe("no-checkpoint");
  });

  it("refuses a retry while a provider turn is active even before the busy projection updates", () => {
    const availability = resolveRetryWithDifferentEffortAvailability({
      ...availableInput(),
      activeTurnId: TurnId.makeUnsafe("next-turn"),
    });
    expect(availability.enabled).toBe(false);
    if (availability.enabled) return;
    expect(availability.reason).toBe("busy");
  });

  it("names the pre-turn checkpoint consistently when no files changed", () => {
    const copy = buildRetryConfirmCopy({
      changedFileCount: 0,
      checkpointTurnCount: 2,
      nextEffortLabel: "Low",
      currentEffortLabel: "High",
    });
    expect(copy).toContain("checkpoint 1");
    expect(copy).not.toContain("checkpoint 2");
  });
});
