import { ProjectId, ThreadId } from "@synara/contracts";
import type { ModelSelection, ProjectAgentConfig } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildGroupConfigureInput,
  buildGroupSettingsDraft,
  clampCharacterCount,
  FALLBACK_GROUP_MODEL_SELECTION,
  formatCharacterCount,
  GROUP_GOAL_MAX_CHARS,
  groupSettingsDirtySections,
  isGroupSettingsDirty,
  isGroupSettingsSection,
  memoryNoteDocumentPath,
  modelSelectionsEqual,
  saveGroupSettings,
  type GroupSettingsDraft,
} from "./groupSettingsDialog.logic";

const codexSelection: ModelSelection = { provider: "codex", model: "gpt-5-codex" };
const claudeSelection: ModelSelection = {
  provider: "claudeAgent",
  model: "claude-opus-4-5",
  supportsAutoMode: true,
};

const baseConfig: ProjectAgentConfig = {
  projectId: ProjectId.makeUnsafe("project-1"),
  coordinatorThreadId: ThreadId.makeUnsafe("thread-1"),
  coordinatorName: "alpha Coordinator",
  coordinatorModelSelection: codexSelection,
  limits: {
    maxConcurrentWorkers: 4,
    maxNewWorkersPerTurn: 2,
    maxWorkerCreationsPerGoal: 16,
    maxAutomaticContinuationsPerGoal: 8,
    maxRepairRoundsPerTask: 2,
  },
  captureEnabled: true,
  enabled: true,
  automationId: null,
  revision: 4,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  disabledAt: null,
} as ProjectAgentConfig;

function makeDraft(overrides: Partial<GroupSettingsDraft> = {}): GroupSettingsDraft {
  return {
    name: "alpha",
    icon: "🐝",
    goal: "ship it",
    coordinatorModelSelection: codexSelection,
    workerModelSelection: codexSelection,
    workerEnvironment: "local",
    autoMemoryEnabled: true,
    libraryPath: "",
    libraryRemoteUrl: "",
    libraryPushOnChange: false,
    ...overrides,
  };
}

describe("buildGroupSettingsDraft", () => {
  it("mirrors the persisted config", () => {
    const draft = buildGroupSettingsDraft({
      config: {
        ...baseConfig,
        icon: "🌊",
        goal: "keep it tidy",
        workerRouting: { modelSelection: claudeSelection, environment: "worktree" },
        autoMemoryEnabled: false,
        libraryPath: "/tmp/lib",
        libraryRemoteUrl: "https://example.com/lib.git",
        libraryPushOnChange: true,
      },
      projectName: "alpha",
      defaultModelSelection: claudeSelection,
    });
    expect(draft.icon).toBe("🌊");
    expect(draft.goal).toBe("keep it tidy");
    expect(draft.coordinatorModelSelection).toEqual(codexSelection);
    expect(draft.workerModelSelection).toEqual(claudeSelection);
    expect(draft.workerEnvironment).toBe("worktree");
    expect(draft.autoMemoryEnabled).toBe(false);
    expect(draft.libraryPath).toBe("/tmp/lib");
    expect(draft.libraryRemoteUrl).toBe("https://example.com/lib.git");
    expect(draft.libraryPushOnChange).toBe(true);
  });

  it("resolves 'Use default' sources: falls back to defaultModelSelection, then the codex fallback", () => {
    const withDefault = buildGroupSettingsDraft({
      config: null,
      projectName: "alpha",
      defaultModelSelection: claudeSelection,
    });
    expect(withDefault.coordinatorModelSelection).toEqual(claudeSelection);
    expect(withDefault.workerModelSelection).toEqual(claudeSelection);

    const noDefault = buildGroupSettingsDraft({
      config: null,
      projectName: "alpha",
      defaultModelSelection: null,
    });
    expect(noDefault.coordinatorModelSelection).toEqual(FALLBACK_GROUP_MODEL_SELECTION);
    expect(noDefault.workerModelSelection).toEqual(FALLBACK_GROUP_MODEL_SELECTION);
  });
});

describe("groupSettingsDirtySections", () => {
  const baseline = makeDraft();

  it("is clean when draft matches baseline", () => {
    expect(groupSettingsDirtySections(makeDraft(), baseline).size).toBe(0);
    expect(isGroupSettingsDirty(makeDraft(), baseline)).toBe(false);
  });

  it("marks general for name, icon, goal, and either model selection", () => {
    expect(groupSettingsDirtySections(makeDraft({ name: "beta" }), baseline)).toEqual(
      new Set(["general"]),
    );
    expect(groupSettingsDirtySections(makeDraft({ icon: "🚀" }), baseline)).toEqual(
      new Set(["general"]),
    );
    expect(groupSettingsDirtySections(makeDraft({ goal: "other" }), baseline)).toEqual(
      new Set(["general"]),
    );
    expect(
      groupSettingsDirtySections(
        makeDraft({ coordinatorModelSelection: claudeSelection }),
        baseline,
      ),
    ).toEqual(new Set(["general"]));
    expect(
      groupSettingsDirtySections(makeDraft({ workerModelSelection: claudeSelection }), baseline),
    ).toEqual(new Set(["general"]));
  });

  it("trims name before comparing", () => {
    expect(groupSettingsDirtySections(makeDraft({ name: "  alpha  " }), baseline).size).toBe(0);
  });

  it("marks memory for autoMemoryEnabled only", () => {
    expect(groupSettingsDirtySections(makeDraft({ autoMemoryEnabled: false }), baseline)).toEqual(
      new Set(["memory"]),
    );
  });

  it("marks environment for worker and library fields", () => {
    expect(
      groupSettingsDirtySections(makeDraft({ workerEnvironment: "worktree" }), baseline),
    ).toEqual(new Set(["environment"]));
    expect(groupSettingsDirtySections(makeDraft({ libraryPath: "/tmp/x" }), baseline)).toEqual(
      new Set(["environment"]),
    );
    expect(groupSettingsDirtySections(makeDraft({ libraryRemoteUrl: "u" }), baseline)).toEqual(
      new Set(["environment"]),
    );
    expect(groupSettingsDirtySections(makeDraft({ libraryPushOnChange: true }), baseline)).toEqual(
      new Set(["environment"]),
    );
  });

  it("accumulates across sections and never flags plugins", () => {
    const dirty = groupSettingsDirtySections(
      makeDraft({ name: "beta", autoMemoryEnabled: false, libraryPushOnChange: true }),
      baseline,
    );
    expect(dirty).toEqual(new Set(["general", "memory", "environment"]));
    expect(dirty.has("plugins")).toBe(false);
  });
});

describe("modelSelectionsEqual", () => {
  it("compares provider, model, options, and supportsAutoMode", () => {
    expect(modelSelectionsEqual(codexSelection, { ...codexSelection })).toBe(true);
    expect(modelSelectionsEqual(codexSelection, claudeSelection)).toBe(false);
    expect(
      modelSelectionsEqual(
        { provider: "codex", model: "gpt-5-codex", options: { reasoningEffort: "high" } },
        { provider: "codex", model: "gpt-5-codex" },
      ),
    ).toBe(false);
    expect(
      modelSelectionsEqual(claudeSelection, {
        provider: "claudeAgent",
        model: "claude-opus-4-5",
      }),
    ).toBe(false);
  });
});

describe("buildGroupConfigureInput", () => {
  const projectId = ProjectId.makeUnsafe("project-1");

  it("reuses the same requestId on every call (stable per dialog session)", () => {
    const first = buildGroupConfigureInput({
      projectId,
      requestId: "req-123",
      mode: "edit",
      draft: makeDraft(),
      baseline: makeDraft(),
      config: baseConfig,
    });
    const second = buildGroupConfigureInput({
      projectId,
      requestId: "req-123",
      mode: "edit",
      draft: makeDraft({ goal: "changed" }),
      baseline: makeDraft(),
      config: baseConfig,
    });
    expect(first.requestId).toBe("req-123");
    expect(second.requestId).toBe("req-123");
  });

  it("keeps coordinatorModelSelection required and merges workerRouting", () => {
    const input = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft({
        coordinatorModelSelection: claudeSelection,
        workerEnvironment: "worktree",
      }),
      baseline: makeDraft(),
      config: {
        ...baseConfig,
        workerRouting: { providerOptions: { a: 1 }, runtimeMode: "yolo" },
      } as unknown as ProjectAgentConfig,
    });
    expect(input.coordinatorModelSelection).toEqual(claudeSelection);
    expect(input.workerRouting).toEqual({
      providerOptions: { a: 1 },
      runtimeMode: "yolo",
      modelSelection: codexSelection,
      environment: "worktree",
    });
  });

  it("passes through coordinatorProviderOptions, limits, and captureEnabled", () => {
    const input = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft(),
      baseline: makeDraft(),
      config: {
        ...baseConfig,
        coordinatorProviderOptions: { codexBinaryPath: "/usr/bin/codex" },
      } as unknown as ProjectAgentConfig,
    });
    expect(input.coordinatorProviderOptions).toEqual({ codexBinaryPath: "/usr/bin/codex" });
    expect(input.limits).toEqual({
      maxConcurrentWorkers: 4,
      maxNewWorkersPerTurn: 2,
      maxWorkerCreationsPerGoal: 16,
      maxAutomaticContinuationsPerGoal: 8,
      maxRepairRoundsPerTask: 2,
    });
    expect(input.captureEnabled).toBe(true);
  });

  it("names the coordinator after the group only when general is dirty or onboarding", () => {
    const clean = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft(),
      baseline: makeDraft(),
      config: baseConfig,
    });
    expect("coordinatorName" in clean).toBe(false);

    const renamed = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft({ name: "beta" }),
      baseline: makeDraft(),
      config: baseConfig,
    });
    expect(renamed.coordinatorName).toBe("beta Coordinator");

    const onboarding = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "onboarding",
      draft: makeDraft({ name: "gamma" }),
      baseline: makeDraft(),
      config: null,
    });
    expect(onboarding.coordinatorName).toBe("gamma Coordinator");
  });

  it("omits empty optional fields and includes expectedRevision / importedInstructions only when set", () => {
    const input = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft({ icon: "", libraryPath: "  ", libraryRemoteUrl: "" }),
      baseline: makeDraft(),
      config: baseConfig,
      expectedRevision: 9,
      importedInstructions: "remember to test",
    });
    expect("icon" in input).toBe(false);
    expect("libraryPath" in input).toBe(false);
    expect("libraryRemoteUrl" in input).toBe(false);
    expect(input.expectedRevision).toBe(9);
    expect(input.importedInstructions).toBe("remember to test");
  });
});

describe("saveGroupSettings", () => {
  const projectId = ProjectId.makeUnsafe("project-1");

  it("rejects an empty name", async () => {
    const result = await saveGroupSettings({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft({ name: "   " }),
      baseline: makeDraft(),
      config: baseConfig,
      configure: vi.fn(),
    });
    expect(result).toEqual({ ok: false, error: "Give the group a name." });
  });

  it("renames before configuring when the name changed", async () => {
    const calls: string[] = [];
    const result = await saveGroupSettings({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft({ name: "beta" }),
      baseline: makeDraft(),
      config: baseConfig,
      renameProject: (title) => {
        calls.push(`rename:${title}`);
      },
      configure: (payload) => {
        calls.push(`configure:${payload.coordinatorName}`);
        return Promise.resolve({} as never);
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["rename:beta", "configure:beta Coordinator"]);
  });

  it("wraps configure failures", async () => {
    const result = await saveGroupSettings({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft(),
      baseline: makeDraft(),
      config: baseConfig,
      configure: () => Promise.reject(new Error("boom")),
    });
    expect(result).toEqual({ ok: false, error: "boom" });
  });
});

describe("character counters and section guards", () => {
  it("clamps the count at the max", () => {
    expect(clampCharacterCount("abc", 10)).toBe(3);
    expect(clampCharacterCount("x".repeat(9000), GROUP_GOAL_MAX_CHARS)).toBe(8000);
  });

  it("formats like 'N / 8,000'", () => {
    expect(formatCharacterCount("abc", GROUP_GOAL_MAX_CHARS)).toBe("3 / 8,000");
    expect(formatCharacterCount("", GROUP_GOAL_MAX_CHARS)).toBe("0 / 8,000");
  });

  it("validates section names", () => {
    expect(isGroupSettingsSection("memory")).toBe(true);
    expect(isGroupSettingsSection("nope")).toBe(false);
  });
});

describe("memoryNoteDocumentPath", () => {
  it("builds memory/notes/<timestamp>-<slug>.md", () => {
    const path = memoryNoteDocumentPath(
      "Releases go out on Tuesdays!",
      new Date("2026-09-21T00:00:00.000Z"),
    );
    expect(path).toBe("memory/notes/2026-09-21-00-00-00-000-releases-go-out-on-tuesdays.md");
  });

  it("falls back to 'note' for content with no slug characters", () => {
    const path = memoryNoteDocumentPath("!!!", new Date("2026-09-21T00:00:00.000Z"));
    expect(path).toMatch(/^memory\/notes\/.+-note\.md$/);
  });
});
