// FILE: Sidebar.logic.ts
// Purpose: Shared sidebar logic surface. Misc row/visibility helpers live here; sorting, status, and tree
//   derivation are split into sibling modules and re-exported so consumers keep importing from "./Sidebar.logic".
// Layer: Sidebar logic (pure).
// Exports: Sidebar row state derivation, add-project error helpers, sort utilities, status/PR indicators, and visibility helpers.

import type {
  KeybindingCommand,
  ProjectId,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import type { Project, SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import { shortcutLabelForCommand, threadJumpCommandForIndex } from "../keybindings";
import { resolveThreadEnvironmentPresentation } from "../lib/threadEnvironment";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "../sidebarRowStyles";
import { isDuplicateProjectCreateError } from "../lib/projectCreateRecovery";
import { workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";

export {
  extractDuplicateProjectCreateProjectId,
  isDuplicateProjectCreateError,
} from "../lib/projectCreateRecovery";

export {
  getFallbackThreadIdAfterDelete,
  getProjectSortTimestamp,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic.sorting";

export {
  hasUnseenCompletion,
  prStatusIndicator,
  resolveProjectStatusIndicator,
  resolveThreadStatusPill,
  terminalStatusFromThreadState,
  toThreadPr,
  type PrStatusIndicator,
  type TerminalStatusIndicator,
  type ThreadPr,
  type ThreadStatusPill,
} from "./Sidebar.logic.status";

export {
  buildProjectThreadTree,
  deriveSidebarProjectData,
  getPinnedThreadsForSidebar,
  getRenderedThreadsForSidebarProject,
  getUnpinnedThreadsForSidebar,
  getVisibleSidebarEntriesForPreview,
  getVisibleSidebarThreadIds,
  getVisibleThreadsForProject,
  groupSidebarThreadsByProjectId,
  type SidebarDerivedProjectData,
  type SidebarProjectEntry,
  type SidebarThreadTreeRow,
} from "./Sidebar.logic.tree";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const SIDEBAR_THREAD_PREWARM_LIMIT = 10;
export const DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY = "synara:show-debug-feature-flags-menu";
export type SidebarNewThreadEnvMode = "local" | "worktree";

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "");

  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1" ||
    normalizedHostname === "[::1]"
  );
}

export function shouldShowDebugFeatureFlagsMenu(input: {
  readonly isDev: boolean;
  readonly hostname: string;
  readonly storageValue: string | null;
}): boolean {
  return input.isDev && isLoopbackHostname(input.hostname) && input.storageValue === "true";
}

const THREAD_JUMP_COMMANDS = [
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
] as const satisfies readonly KeybindingCommand[];

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

// Drops remembered "show more" state for projects that are currently collapsed.
export function pruneExpandedProjectThreadListsForCollapsedProjects<
  T extends Pick<Project, "cwd" | "expanded">,
>(input: {
  expandedProjectThreadListCwds: ReadonlySet<string>;
  projects: readonly T[];
  normalizeProjectCwd: (cwd: string) => string;
}): ReadonlySet<string> {
  const { expandedProjectThreadListCwds, normalizeProjectCwd, projects } = input;
  const collapsedProjectCwds = new Set(
    projects
      .filter((project) => !project.expanded)
      .map((project) => normalizeProjectCwd(project.cwd))
      .filter((cwd) => cwd.length > 0),
  );

  if (collapsedProjectCwds.size === 0) {
    return expandedProjectThreadListCwds;
  }

  let changed = false;
  const nextExpandedProjectThreadListCwds = new Set<string>();
  for (const cwd of expandedProjectThreadListCwds) {
    if (collapsedProjectCwds.has(cwd)) {
      changed = true;
      continue;
    }
    nextExpandedProjectThreadListCwds.add(cwd);
  }

  return changed ? nextExpandedProjectThreadListCwds : expandedProjectThreadListCwds;
}

/**
 * Trailing padding that protects the title from the absolutely-positioned
 * meta-chip + timestamp / hover-action cluster. Sized to the actual number of
 * meta chips so rows without fork/worktree/handoff badges let the title use the
 * freed width instead of truncating against permanently-reserved empty space.
 *
 * Literal class strings are required so Tailwind's JIT scanner emits them.
 */
export function resolveThreadRowTrailingReserveClass(metaChipCount: number): string {
  if (metaChipCount <= 0) return "pr-[2.75rem]";
  if (metaChipCount === 1) return "pr-[3.75rem]";
  if (metaChipCount === 2) return "pr-[4.25rem]";
  return "pr-[4.75rem]";
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  // Trailing reserve for the absolute cluster is applied separately by callers
  // via resolveThreadRowTrailingReserveClass so it can flex with the chip count.
  const baseClassName = SIDEBAR_THREAD_ROW_BASE_CLASS_NAME;

  if (input.isSelected && input.isActive) {
    return cn(baseClassName, SIDEBAR_ROW_ACTIVE_CLASS_NAME);
  }

  if (input.isSelected) {
    return cn(baseClassName, SIDEBAR_ROW_ACTIVE_CLASS_NAME);
  }

  if (input.isActive) {
    return cn(baseClassName, SIDEBAR_ROW_ACTIVE_CLASS_NAME);
  }

  return cn(baseClassName, SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME);
}

export function findWorkspaceRootMatch<T>(
  items: readonly T[],
  targetWorkspaceRoot: string,
  getWorkspaceRoot: (item: T) => string,
): T | undefined {
  return items.find((item) => workspaceRootsEqual(getWorkspaceRoot(item), targetWorkspaceRoot));
}

// Rechecks an existing local project against the server before the add flow decides to reuse it.
export async function recoverExistingAddProjectTarget(input: {
  readonly existingProjectId: ProjectId | null | undefined;
  readonly workspaceRoot: string;
  readonly recoverByProjectId: (projectId: ProjectId) => Promise<boolean>;
  readonly recoverByWorkspaceRoot: (workspaceRoot: string) => Promise<boolean>;
}): Promise<"recovered" | "create"> {
  if (!input.existingProjectId) {
    return "create";
  }

  if (await input.recoverByProjectId(input.existingProjectId)) {
    return "recovered";
  }

  if (await input.recoverByWorkspaceRoot(input.workspaceRoot)) {
    return "recovered";
  }

  return "create";
}

// Translates low-level add-project failures into a short explanation without
// hiding the original error text that developers may need for diagnosis.
export function describeAddProjectError(message: string): string | null {
  if (isDuplicateProjectCreateError(message)) {
    return "This usually means the folder is already linked to an existing project. On Windows, the same folder can arrive with a different path format, so it looks new even when it is not.";
  }

  if (
    message.startsWith("Failed to create project directory: /") ||
    message.startsWith("Project directory does not exist: /")
  ) {
    return "This is an absolute path from the filesystem root. If the folder is in your home directory, use ~/Developer/... or the full /Users/<name>/Developer/... path.";
  }

  return null;
}

// Resolve the next sidebar-visible thread for keyboard cycling with wraparound.
export function getNextVisibleSidebarThreadId(input: {
  visibleThreadIds: readonly Thread["id"][];
  activeThreadId: Thread["id"] | undefined;
  direction: "forward" | "backward";
}): Thread["id"] | null {
  const { activeThreadId, direction, visibleThreadIds } = input;
  if (visibleThreadIds.length === 0) {
    return null;
  }

  if (!activeThreadId) {
    return direction === "forward"
      ? (visibleThreadIds[0] ?? null)
      : (visibleThreadIds.at(-1) ?? null);
  }

  const activeIndex = visibleThreadIds.findIndex((threadId) => threadId === activeThreadId);
  if (activeIndex === -1) {
    return direction === "forward"
      ? (visibleThreadIds[0] ?? null)
      : (visibleThreadIds.at(-1) ?? null);
  }

  const nextIndex =
    direction === "forward"
      ? (activeIndex + 1) % visibleThreadIds.length
      : (activeIndex - 1 + visibleThreadIds.length) % visibleThreadIds.length;

  return visibleThreadIds[nextIndex] ?? null;
}

export function getSidebarThreadIdForJumpCommand(input: {
  visibleThreadIds: readonly Thread["id"][];
  command: string | null;
}): Thread["id"] | null {
  if (!input.command) {
    return null;
  }

  const jumpIndex = THREAD_JUMP_COMMANDS.indexOf(
    input.command as (typeof THREAD_JUMP_COMMANDS)[number],
  );
  if (jumpIndex === -1) {
    return null;
  }

  return input.visibleThreadIds[jumpIndex] ?? null;
}

export function getSidebarThreadIdsToPrewarm(input: {
  visibleThreadIds: readonly Thread["id"][];
  activeThreadId?: Thread["id"] | null;
  limit?: number;
  neighborRadius?: number;
}): Thread["id"][] {
  const limit = Math.max(0, input.limit ?? SIDEBAR_THREAD_PREWARM_LIMIT);
  if (limit === 0) {
    return [];
  }
  const prewarmedThreadIds = new Set<Thread["id"]>();
  const neighborRadius = Math.max(0, input.neighborRadius ?? 2);
  const activeIndex =
    input.activeThreadId === undefined || input.activeThreadId === null
      ? -1
      : input.visibleThreadIds.indexOf(input.activeThreadId);

  if (activeIndex >= 0) {
    const start = Math.max(0, activeIndex - neighborRadius);
    const end = Math.min(input.visibleThreadIds.length - 1, activeIndex + neighborRadius);
    for (let index = start; index <= end; index += 1) {
      if (prewarmedThreadIds.size >= limit) {
        break;
      }
      const threadId = input.visibleThreadIds[index];
      if (threadId) {
        prewarmedThreadIds.add(threadId);
      }
    }
  }

  for (const threadId of input.visibleThreadIds) {
    if (prewarmedThreadIds.size >= limit) {
      break;
    }
    prewarmedThreadIds.add(threadId);
  }

  return [...prewarmedThreadIds];
}

// Only prune persisted pins after the thread snapshot has hydrated.
export function shouldPrunePinnedThreads(input: { threadsHydrated: boolean }): boolean {
  return input.threadsHydrated;
}

export type ProjectEmptyState = "loading" | "empty" | null;

// Keep the initial shell bootstrap visually distinct from a genuinely empty project list.
export function resolveProjectEmptyState(input: {
  readonly projectCount: number;
  readonly shouldShowProjectPathEntry: boolean;
  readonly threadsHydrated: boolean;
}): ProjectEmptyState {
  if (input.projectCount > 0 || input.shouldShowProjectPathEntry) {
    return null;
  }

  return input.threadsHydrated ? "empty" : "loading";
}

export const EMPTY_THREAD_JUMP_LABELS = new Map<ThreadId, string>();

export function readDebugFeatureFlagsMenuVisibility(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return shouldShowDebugFeatureFlagsMenu({
      isDev: import.meta.env.DEV,
      hostname: window.location.hostname,
      storageValue: window.localStorage.getItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY),
    });
  } catch {
    return false;
  }
}

export function threadJumpLabelMapsEqual(
  left: ReadonlyMap<ThreadId, string>,
  right: ReadonlyMap<ThreadId, string>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const [threadId, label] of left) {
    if (right.get(threadId) !== label) {
      return false;
    }
  }
  return true;
}

// Resolve the visible numbered-thread hints from the active keybinding config.
export function buildThreadJumpLabelMap(input: {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByThreadId: ReadonlyMap<
    ThreadId,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<ThreadId, string> {
  if (input.threadJumpCommandByThreadId.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<ThreadId, string>();
  for (const [threadId, command] of input.threadJumpCommandByThreadId) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadId, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

// Right-aligned slot wrapper that matches the timestamp width and fades out on
// row hover/focus so the trailing hover actions can take over.
export function threadStatusSlotClassName(isSubagentThread: boolean): string {
  return cn(
    "mr-1 flex shrink-0 items-center justify-end transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
    isSubagentThread ? "w-[1.2rem]" : "w-[1.625rem]",
  );
}

export function resolveWorktreeBadgeLabel(
  thread: Pick<Thread, "envMode" | "worktreePath">,
): string | null {
  return resolveThreadEnvironmentPresentation({
    envMode: thread.envMode,
    worktreePath: thread.worktreePath,
  }).worktreeBadgeLabel;
}

export function resolveSplitPreviewTitle(input: {
  thread: Pick<SidebarThreadSummary, "title"> | null;
  draftPrompt: string | null;
}): string {
  if (input.thread?.title) {
    return input.thread.title;
  }
  const draftPrompt = input.draftPrompt?.trim() ?? "";
  if (draftPrompt.length > 0) {
    return draftPrompt;
  }
  return "New chat";
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
