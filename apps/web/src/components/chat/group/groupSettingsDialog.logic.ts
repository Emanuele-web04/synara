import {
  type ModelSelection,
  PROJECT_AGENT_RESERVED_PATHS,
  type ProviderKind,
  type ProjectAgentConfig,
  type ProjectAgentConfigureInput,
  type ProjectAgentOverview,
  type ProjectId,
} from "@synara/contracts";
import { MEMORY_NOTES_DOCUMENT_PREFIX } from "@synara/shared/projectAgent";

export const GROUP_SETTINGS_SECTIONS = ["general", "memory", "environment", "plugins"] as const;
export type GroupSettingsSection = (typeof GROUP_SETTINGS_SECTIONS)[number];

export const GROUP_SETTINGS_SECTION_LABELS: Record<GroupSettingsSection, string> = {
  general: "General",
  memory: "Memory",
  environment: "Environment",
  plugins: "Plugins",
};

export const GROUP_NAME_MAX_CHARS = 160;
export const GROUP_GOAL_MAX_CHARS = 8_000;
export const GROUP_INSTRUCTIONS_MAX_CHARS = 16_000;

export const GROUP_ICON_OPTIONS = [
  "🐝",
  "🌱",
  "🌊",
  "🌸",
  "🍀",
  "🔥",
  "⚡",
  "🌙",
  "☀️",
  "🪐",
  "🧭",
  "🛠️",
  "📦",
  "🧪",
  "📚",
  "🎨",
  "🎧",
  "🚀",
  "🏗️",
  "🧠",
  "💎",
  "🦉",
  "🐙",
  "🤖",
] as const;

export function isGroupSettingsSection(value: unknown): value is GroupSettingsSection {
  return (
    typeof value === "string" && (GROUP_SETTINGS_SECTIONS as ReadonlyArray<string>).includes(value)
  );
}

export function clampCharacterCount(value: string, max: number): number {
  return Math.min(Math.max(0, value.length), max);
}

// The counter tells the truth about how long the text is — an over-limit value
// reads e.g. "8,412 / 8,000" in destructive color, never a clamped "8,000".
export function formatCharacterCount(value: string, max: number): string {
  return `${Math.max(0, value.length).toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`;
}

/**
 * The editable surface of a group, mirrored from `ProjectAgentConfig` plus the
 * project title. Model selections always hold a concrete selection — "Use
 * default" resolves to the client-side `defaultModelSelection` instead of a
 * server sentinel, which keeps `coordinatorModelSelection` valid (required).
 */
export interface GroupSettingsDraft {
  readonly name: string;
  readonly icon: string;
  readonly goal: string;
  readonly coordinatorIcon: string;
  readonly coordinatorColor: string;
  readonly coordinatorModelSelection: ModelSelection;
  readonly workerModelSelection: ModelSelection;
  readonly workerEnvironment: "local" | "worktree";
  readonly autoMemoryEnabled: boolean;
  readonly libraryPath: string;
  readonly libraryRemoteUrl: string;
  readonly libraryPushOnChange: boolean;
}

export const FALLBACK_GROUP_MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
};

function modelSelectionFingerprint(selection: ModelSelection): string {
  return JSON.stringify({
    provider: selection.provider,
    model: selection.model,
    options: selection.options ?? null,
    supportsAutoMode: "supportsAutoMode" in selection ? (selection.supportsAutoMode ?? null) : null,
  });
}

export function modelSelectionsEqual(a: ModelSelection, b: ModelSelection): boolean {
  return modelSelectionFingerprint(a) === modelSelectionFingerprint(b);
}

/**
 * Provider keys warmed for the group model catalog. While the picker is open
 * every visible provider's catalog warms — same as the composer picker — so
 * each provider lists its real models; when closed, only the row's own
 * provider needs runtime discovery (effort levels, selected-model hint).
 */
export function resolveGroupModelCatalogPrefetchProviders(
  pickerOpen: boolean,
  selectedProvider: ProviderKind,
): ReadonlyArray<ProviderKind> | undefined {
  return pickerOpen ? undefined : [selectedProvider];
}

export function buildGroupSettingsDraft(input: {
  readonly config: ProjectAgentConfig | null | undefined;
  readonly projectName: string;
  readonly defaultModelSelection: ModelSelection | null | undefined;
}): GroupSettingsDraft {
  const config = input.config ?? null;
  const fallbackSelection = input.defaultModelSelection ?? FALLBACK_GROUP_MODEL_SELECTION;
  return {
    name: input.projectName,
    icon: config?.icon ?? "",
    goal: config?.goal ?? "",
    coordinatorIcon: config?.coordinatorIcon ?? "",
    coordinatorColor: config?.coordinatorColor ?? "",
    coordinatorModelSelection: config?.coordinatorModelSelection ?? fallbackSelection,
    workerModelSelection: config?.workerRouting?.modelSelection ?? fallbackSelection,
    workerEnvironment: config?.workerRouting?.environment ?? "local",
    autoMemoryEnabled: config?.autoMemoryEnabled ?? true,
    libraryPath: config?.libraryPath ?? "",
    libraryRemoteUrl: config?.libraryRemoteUrl ?? "",
    libraryPushOnChange: config?.libraryPushOnChange ?? false,
  };
}

/**
 * The draft plus the config snapshot it was built from. `config.revision` is the
 * optimistic-lock token sent as `expectedRevision`, and the preserved fields the
 * dialog does not edit (extra `workerRouting` keys, `limits`, `captureEnabled`,
 * `coordinatorProviderOptions`) are sent from this snapshot — never from live
 * config, which may already reflect another writer's save.
 */
export interface GroupSettingsBaseline {
  readonly draft: GroupSettingsDraft;
  readonly config: ProjectAgentConfig | null;
}

export function buildGroupSettingsBaseline(input: {
  readonly config: ProjectAgentConfig | null | undefined;
  readonly projectName: string;
  readonly defaultModelSelection: ModelSelection | null | undefined;
}): GroupSettingsBaseline {
  return {
    draft: buildGroupSettingsDraft(input),
    config: input.config ?? null,
  };
}

/** Sections whose draft fields differ from the baseline. The Plugins section has no settings. */
export function groupSettingsDirtySections(
  draft: GroupSettingsDraft,
  baseline: GroupSettingsDraft,
): ReadonlySet<GroupSettingsSection> {
  const dirty = new Set<GroupSettingsSection>();
  if (
    draft.name.trim() !== baseline.name.trim() ||
    draft.icon !== baseline.icon ||
    draft.goal !== baseline.goal ||
    draft.coordinatorIcon !== baseline.coordinatorIcon ||
    draft.coordinatorColor !== baseline.coordinatorColor ||
    !modelSelectionsEqual(draft.coordinatorModelSelection, baseline.coordinatorModelSelection) ||
    !modelSelectionsEqual(draft.workerModelSelection, baseline.workerModelSelection)
  ) {
    dirty.add("general");
  }
  if (draft.autoMemoryEnabled !== baseline.autoMemoryEnabled) {
    dirty.add("memory");
  }
  if (
    draft.workerEnvironment !== baseline.workerEnvironment ||
    draft.libraryPath !== baseline.libraryPath ||
    draft.libraryRemoteUrl !== baseline.libraryRemoteUrl ||
    draft.libraryPushOnChange !== baseline.libraryPushOnChange
  ) {
    dirty.add("environment");
  }
  return dirty;
}

export function buildGroupConfigureInput(input: {
  readonly projectId: ProjectId;
  readonly requestId: string;
  readonly mode: "onboarding" | "edit";
  readonly draft: GroupSettingsDraft;
  readonly baseline: GroupSettingsBaseline;
  readonly expectedRevision?: number | undefined;
  readonly importedInstructions?: string | undefined;
  readonly userDisplayName?: string | undefined;
}): ProjectAgentConfigureInput {
  const { draft, baseline } = input;
  const baselineDraft = baseline.draft;
  // Preserved fields come from the baseline snapshot so a concurrent write that
  // already landed is not silently folded into this save.
  const config = baseline.config;
  const generalDirty = groupSettingsDirtySections(draft, baselineDraft).has("general");

  // Preserve fields the dialog does not edit so a save never drops them server-side.
  const workerRouting: ProjectAgentConfigureInput["workerRouting"] = {
    ...config?.workerRouting,
    modelSelection: draft.workerModelSelection,
    environment: draft.workerEnvironment,
  };

  // Cleared fields are sent as `null` (the server nulls the column); a field is
  // omitted only when it was empty in the baseline too, where absent == keep.
  const icon = draft.icon.trim();
  const coordinatorIcon = draft.coordinatorIcon.trim();
  const coordinatorColor = draft.coordinatorColor.trim();
  const libraryPath = draft.libraryPath.trim();
  const libraryRemoteUrl = draft.libraryRemoteUrl.trim();

  return {
    requestId: input.requestId,
    projectId: input.projectId,
    coordinatorModelSelection: draft.coordinatorModelSelection,
    workerRouting,
    ...(generalDirty || input.mode === "onboarding"
      ? {
          coordinatorName:
            draft.name.trim().length > 0
              ? `${draft.name.trim()} Coordinator`.slice(0, GROUP_NAME_MAX_CHARS)
              : "Group Coordinator",
        }
      : {}),
    ...(config?.coordinatorProviderOptions
      ? { coordinatorProviderOptions: config.coordinatorProviderOptions }
      : {}),
    ...(config?.limits ? { limits: config.limits } : {}),
    ...(config ? { captureEnabled: config.captureEnabled } : {}),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    ...(input.importedInstructions?.trim()
      ? { importedInstructions: input.importedInstructions }
      : {}),
    goal: draft.goal,
    ...(icon.length > 0 ? { icon } : baselineDraft.icon.trim().length > 0 ? { icon: null } : {}),
    ...(coordinatorIcon.length > 0
      ? { coordinatorIcon }
      : baselineDraft.coordinatorIcon.trim().length > 0
        ? { coordinatorIcon: null }
        : {}),
    ...(coordinatorColor.length > 0
      ? { coordinatorColor }
      : baselineDraft.coordinatorColor.trim().length > 0
        ? { coordinatorColor: null }
        : {}),
    autoMemoryEnabled: draft.autoMemoryEnabled,
    ...(input.userDisplayName?.trim() ? { userDisplayName: input.userDisplayName.trim() } : {}),
    ...(libraryPath.length > 0
      ? { libraryPath }
      : baselineDraft.libraryPath.trim().length > 0
        ? { libraryPath: null }
        : {}),
    ...(libraryRemoteUrl.length > 0
      ? { libraryRemoteUrl }
      : baselineDraft.libraryRemoteUrl.trim().length > 0
        ? { libraryRemoteUrl: null }
        : {}),
    libraryPushOnChange: draft.libraryPushOnChange,
  };
}

/**
 * Covers everything a save attempt sends. A failed attempt may be retried with
 * the same requestId only while this fingerprint is unchanged; editing the draft
 * (or a different imported-instructions payload) starts a fresh attempt id so a
 * server-side receipt never swallows a changed payload.
 */
export function saveAttemptFingerprint(input: {
  readonly mode: "onboarding" | "edit";
  readonly draft: GroupSettingsDraft;
  readonly importedInstructions: string | undefined;
}): string {
  return JSON.stringify({
    ...input.draft,
    mode: input.mode,
    importedInstructions: input.importedInstructions ?? null,
  });
}

export function resolveSaveAttemptRequestId(input: {
  readonly failed: { readonly requestId: string; readonly fingerprint: string } | null;
  readonly fingerprint: string;
  readonly generateRequestId?: () => string;
}): string {
  if (input.failed !== null && input.failed.fingerprint === input.fingerprint) {
    return input.failed.requestId;
  }
  return (input.generateRequestId ?? (() => crypto.randomUUID()))();
}

export type SaveGroupSettingsResult =
  | { readonly ok: true; readonly overview: ProjectAgentOverview }
  | { readonly ok: false; readonly error: string };

export async function saveGroupSettings(input: {
  readonly projectId: ProjectId;
  readonly requestId: string;
  readonly mode: "onboarding" | "edit";
  readonly draft: GroupSettingsDraft;
  readonly baseline: GroupSettingsBaseline;
  readonly expectedRevision?: number | undefined;
  readonly importedInstructions?: string | undefined;
  readonly userDisplayName?: string | undefined;
  readonly configure: (payload: ProjectAgentConfigureInput) => Promise<ProjectAgentOverview>;
  readonly renameProject?: ((title: string) => Promise<void> | void) | undefined;
}): Promise<SaveGroupSettingsResult> {
  const trimmedName = input.draft.name.trim();
  if (trimmedName.length === 0) {
    return { ok: false, error: "Give the group a name." };
  }
  try {
    // Configure first: a revision conflict must abort before the project meta
    // rename lands. On retry the rename is compared against the last saved name
    // (the baseline), and a reused requestId makes the configure call replay its
    // receipt instead of re-applying.
    const overview = await input.configure(
      buildGroupConfigureInput({
        projectId: input.projectId,
        requestId: input.requestId,
        mode: input.mode,
        draft: input.draft,
        baseline: input.baseline,
        expectedRevision: input.expectedRevision,
        importedInstructions: input.importedInstructions,
        userDisplayName: input.userDisplayName,
      }),
    );
    if (input.renameProject && trimmedName !== input.baseline.draft.name.trim()) {
      await input.renameProject(trimmedName);
    }
    return { ok: true, overview };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save the group settings.",
    };
  }
}

/** `memory/notes/<timestamp-slug>.md` — timestamp keeps names unique, slug keeps them readable. */
export function memoryNoteDocumentPath(note: string, now = new Date()): string {
  const slug =
    note
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "note";
  const timestamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "-").replace(/Z$/, "");
  return `${MEMORY_NOTES_DOCUMENT_PREFIX}${timestamp}-${slug}.md`;
}

// Documents every group project starts with; "files yet" means anything
// beyond this set (the coordinator playbook lives outside reserved paths).
export const GROUP_SEED_DOCUMENT_PATHS: ReadonlySet<string> = new Set([
  ...PROJECT_AGENT_RESERVED_PATHS,
  "docs/project-bot.md",
]);

/**
 * A group whose onboarding was cancelled is safe to discard only while it is
 * still untouched: no threads anywhere the sidebar can surface them, no
 * linked repositories, and no documents beyond the seeded scaffold.
 */
export function isGroupOnboardingDiscardable(input: {
  readonly threadIndexCount: number;
  readonly sidebarThreadCount: number;
  readonly linkedProjectIds: ReadonlyArray<string>;
  readonly documentPaths: ReadonlyArray<string>;
}): boolean {
  return (
    input.threadIndexCount === 0 &&
    input.sidebarThreadCount === 0 &&
    input.linkedProjectIds.length === 0 &&
    input.documentPaths.every((path) => GROUP_SEED_DOCUMENT_PATHS.has(path))
  );
}
