import { ProjectId, ThreadId } from "@synara/contracts";
import type { ModelSelection, ProjectAgentConfig } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildGroupConfigureInput,
  buildGroupSettingsBaseline,
  buildGroupSettingsDraft,
  clampCharacterCount,
  FALLBACK_GROUP_MODEL_SELECTION,
  formatCharacterCount,
  GROUP_GOAL_MAX_CHARS,
  groupSettingsDirtySections,
  isGroupSettingsSection,
  memoryNoteDocumentPath,
  modelSelectionsEqual,
  resolveSaveAttemptRequestId,
  saveAttemptFingerprint,
  saveGroupSettings,
  type GroupSettingsBaseline,
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
};

function makeDraft(overrides: Partial<GroupSettingsDraft> = {}): GroupSettingsDraft {
  return {
    name: "alpha",
    icon: "🐝",
    goal: "ship it",
    coordinatorIcon: "",
    coordinatorColor: "",
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

function makeBaseline(
  overrides: Partial<GroupSettingsDraft> = {},
  config: ProjectAgentConfig | null = baseConfig,
): GroupSettingsBaseline {
  return { draft: makeDraft(overrides), config };
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

  it("snapshots the config into the baseline", () => {
    const baseline = buildGroupSettingsBaseline({
      config: baseConfig,
      projectName: "alpha",
      defaultModelSelection: null,
    });
    expect(baseline.config).toBe(baseConfig);
    expect(baseline.config?.revision).toBe(4);
    expect(baseline.draft.name).toBe("alpha");
  });
});

describe("groupSettingsDirtySections", () => {
  const baseline = makeDraft();

  it("is clean when draft matches baseline", () => {
    expect(groupSettingsDirtySections(makeDraft(), baseline).size).toBe(0);
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

describe("resolveSaveAttemptRequestId", () => {
  it("mints a fresh requestId per save attempt", () => {
    const generateRequestId = vi.fn(() => "req-new");
    const first = resolveSaveAttemptRequestId({
      failed: null,
      fingerprint: "fp-1",
      generateRequestId,
    });
    expect(first).toBe("req-new");
    // A save after a success (or an edited draft after a failure) is a new attempt.
    const second = resolveSaveAttemptRequestId({
      failed: { requestId: "req-old", fingerprint: "fp-1" },
      fingerprint: "fp-2",
      generateRequestId,
    });
    expect(second).toBe("req-new");
    expect(generateRequestId).toHaveBeenCalledTimes(2);
  });

  it("reuses the failed attempt's requestId only while the payload is unchanged", () => {
    const fingerprint = saveAttemptFingerprint({
      mode: "edit",
      draft: makeDraft({ goal: "changed" }),
      importedInstructions: undefined,
    });
    const reused = resolveSaveAttemptRequestId({
      failed: { requestId: "req-failed", fingerprint },
      fingerprint,
    });
    expect(reused).toBe("req-failed");

    const changedFingerprint = saveAttemptFingerprint({
      mode: "edit",
      draft: makeDraft({ goal: "changed again" }),
      importedInstructions: undefined,
    });
    expect(
      resolveSaveAttemptRequestId({
        failed: { requestId: "req-failed", fingerprint },
        fingerprint: changedFingerprint,
        generateRequestId: () => "req-fresh",
      }),
    ).toBe("req-fresh");
  });
});

describe("buildGroupConfigureInput", () => {
  const projectId = ProjectId.makeUnsafe("project-1");

  it("keeps coordinatorModelSelection required and merges workerRouting from the baseline snapshot", () => {
    const input = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft({
        coordinatorModelSelection: claudeSelection,
        workerEnvironment: "worktree",
      }),
      baseline: makeBaseline(
        {},
        {
          ...baseConfig,
          workerRouting: {
            providerOptions: { codex: { binaryPath: "/opt/codex" } },
            runtimeMode: "full-access",
          },
        },
      ),
    });
    expect(input.coordinatorModelSelection).toEqual(claudeSelection);
    expect(input.workerRouting).toEqual({
      providerOptions: { codex: { binaryPath: "/opt/codex" } },
      runtimeMode: "full-access",
      modelSelection: codexSelection,
      environment: "worktree",
    });
  });

  it("passes through coordinatorProviderOptions, limits, and captureEnabled from the snapshot", () => {
    const input = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft(),
      baseline: makeBaseline(
        {},
        {
          ...baseConfig,
          coordinatorProviderOptions: { codex: { binaryPath: "/usr/bin/codex" } },
        },
      ),
    });
    expect(input.coordinatorProviderOptions).toEqual({
      codex: { binaryPath: "/usr/bin/codex" },
    });
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
      baseline: makeBaseline(),
    });
    expect("coordinatorName" in clean).toBe(false);

    const renamed = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft({ name: "beta" }),
      baseline: makeBaseline(),
    });
    expect(renamed.coordinatorName).toBe("beta Coordinator");

    const onboarding = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "onboarding",
      draft: makeDraft({ name: "gamma" }),
      baseline: makeBaseline({}, null),
    });
    expect(onboarding.coordinatorName).toBe("gamma Coordinator");
  });

  it("sends null for fields cleared relative to the baseline, and omits ones that were already empty", () => {
    const input = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft({ icon: "", libraryPath: "  ", libraryRemoteUrl: "" }),
      baseline: makeBaseline({
        icon: "🌊",
        libraryPath: "/tmp/lib",
        libraryRemoteUrl: "https://example.com/lib.git",
      }),
      expectedRevision: 9,
      importedInstructions: "remember to test",
    });
    expect(input.icon).toBeNull();
    expect(input.libraryPath).toBeNull();
    expect(input.libraryRemoteUrl).toBeNull();
    expect(input.expectedRevision).toBe(9);
    expect(input.importedInstructions).toBe("remember to test");

    const alreadyEmpty = buildGroupConfigureInput({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft({ icon: "", libraryPath: "", libraryRemoteUrl: "" }),
      baseline: makeBaseline({ icon: "", libraryPath: "", libraryRemoteUrl: "" }),
    });
    expect("icon" in alreadyEmpty).toBe(false);
    expect("libraryPath" in alreadyEmpty).toBe(false);
    expect("libraryRemoteUrl" in alreadyEmpty).toBe(false);
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
      baseline: makeBaseline(),
      configure: vi.fn(),
    });
    expect(result).toEqual({ ok: false, error: "Give the group a name." });
  });

  it("configures before renaming when the name changed", async () => {
    const calls: string[] = [];
    const result = await saveGroupSettings({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft({ name: "beta" }),
      baseline: makeBaseline(),
      renameProject: (title) => {
        calls.push(`rename:${title}`);
      },
      configure: (payload) => {
        calls.push(`configure:${payload.coordinatorName}`);
        return Promise.resolve({} as never);
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["configure:beta Coordinator", "rename:beta"]);
  });

  it("does not rename when configure fails", async () => {
    const renameProject = vi.fn();
    const result = await saveGroupSettings({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft({ name: "beta" }),
      baseline: makeBaseline(),
      renameProject,
      configure: () => Promise.reject(new Error("boom")),
    });
    expect(result).toEqual({ ok: false, error: "boom" });
    expect(renameProject).not.toHaveBeenCalled();
  });

  it("conflicts when the server revision moved past the snapshotted baseline revision", async () => {
    const baseline = buildGroupSettingsBaseline({
      config: baseConfig,
      projectName: "alpha",
      defaultModelSelection: null,
    });
    // Another writer saved first: the server is now one revision ahead.
    const serverRevision = baseConfig.revision + 1;
    const configure = vi.fn((payload: { expectedRevision?: number | undefined }) => {
      if (payload.expectedRevision !== serverRevision) {
        return Promise.reject(new Error("Coordinator settings changed. Reload and retry."));
      }
      return Promise.resolve({} as never);
    });
    const result = await saveGroupSettings({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: baseline.draft,
      baseline,
      expectedRevision: baseline.config?.revision,
      configure,
    });
    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: baseConfig.revision }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("changed");
    }
  });

  it("wraps configure failures", async () => {
    const result = await saveGroupSettings({
      projectId,
      requestId: "req",
      mode: "edit",
      draft: makeDraft(),
      baseline: makeBaseline(),
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
