import type { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";

// union type, validator, metadata map, and add-menu order all derive from this one list so they can't drift
export const RIGHT_DOCK_PANE_KINDS = [
  "browser",
  "device",
  "diff",
  "explorer",
  "file",
  "terminal",
  "sidechat",
  "git",
  "pullRequest",
] as const;

export type RightDockPaneKind = (typeof RIGHT_DOCK_PANE_KINDS)[number];
export type PullRequestInitialTab = "summary" | "timeline" | "code";

const RIGHT_DOCK_PANE_KIND_SET: ReadonlySet<string> = new Set(RIGHT_DOCK_PANE_KINDS);

export interface RightDockPane {
  id: string;
  kind: RightDockPaneKind;
  threadId: ThreadId | null;
  diffTurnId: TurnId | null;
  diffFilePath: string | null;
  filePath: string | null;
  pullRequestProjectId: ProjectId | null;
  pullRequestRepository: string | null;
  pullRequestNumber: number | null;
  pullRequestInitialTab: PullRequestInitialTab | null;
}

export interface RightDockThreadState {
  open: boolean;
  panes: RightDockPane[];
  activePaneId: string | null;
}

// file previews are the only multi-instance dock kind — side chats share one destination and switch the embedded thread
const MULTI_INSTANCE_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set(["file"]);

// Kinds that can only ever have one instance per host thread, derived as "every kind that is not multi-instance" so the two sets can never drift.
export const SINGLETON_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set(
  RIGHT_DOCK_PANE_KINDS.filter((kind) => !MULTI_INSTANCE_PANE_KINDS.has(kind)),
);

export function isSingletonPaneKind(kind: RightDockPaneKind): boolean {
  return SINGLETON_PANE_KINDS.has(kind);
}

export function createDefaultRightDockState(): RightDockThreadState {
  return {
    open: false,
    panes: [],
    activePaneId: null,
  };
}

export function isRightDockPaneKind(value: unknown): value is RightDockPaneKind {
  return typeof value === "string" && RIGHT_DOCK_PANE_KIND_SET.has(value);
}

// persisted state predates the current pane-kind union — drop unknown kinds and keep the active tab on a surviving pane
function sanitizePersistedPane(value: unknown): RightDockPane | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const candidate = value;
  if (typeof candidate.id !== "string" || !isRightDockPaneKind(candidate.kind)) {
    return null;
  }
  return {
    id: candidate.id,
    kind: candidate.kind,
    threadId: typeof candidate.threadId === "string" ? (candidate.threadId as ThreadId) : null,
    diffTurnId: typeof candidate.diffTurnId === "string" ? (candidate.diffTurnId as TurnId) : null,
    diffFilePath: typeof candidate.diffFilePath === "string" ? candidate.diffFilePath : null,
    filePath: typeof candidate.filePath === "string" ? candidate.filePath : null,
    pullRequestProjectId:
      typeof candidate.pullRequestProjectId === "string"
        ? (candidate.pullRequestProjectId as ProjectId)
        : null,
    pullRequestRepository:
      typeof candidate.pullRequestRepository === "string" ? candidate.pullRequestRepository : null,
    pullRequestNumber:
      typeof candidate.pullRequestNumber === "number" &&
      Number.isInteger(candidate.pullRequestNumber) &&
      candidate.pullRequestNumber > 0
        ? candidate.pullRequestNumber
        : null,
    pullRequestInitialTab:
      candidate.pullRequestInitialTab === "summary" ||
      candidate.pullRequestInitialTab === "timeline" ||
      candidate.pullRequestInitialTab === "code"
        ? candidate.pullRequestInitialTab
        : null,
  };
}

export function sanitizeRightDockThreadState(value: unknown): RightDockThreadState {
  if (!isPlainObject(value)) {
    return createDefaultRightDockState();
  }
  const candidate = value;
  const sanitizedPanes = Array.isArray(candidate.panes)
    ? candidate.panes
        .map(sanitizePersistedPane)
        .filter((pane): pane is RightDockPane => pane !== null)
    : [];
  const persistedActivePaneId =
    typeof candidate.activePaneId === "string" ? candidate.activePaneId : null;
  const keptSingletonPaneIdByKind = new Map<RightDockPaneKind, string>();
  for (const pane of sanitizedPanes) {
    if (
      isSingletonPaneKind(pane.kind) &&
      (pane.id === persistedActivePaneId || !keptSingletonPaneIdByKind.has(pane.kind))
    ) {
      keptSingletonPaneIdByKind.set(pane.kind, pane.id);
    }
  }
  const panes = sanitizedPanes.filter(
    (pane) =>
      !isSingletonPaneKind(pane.kind) || keptSingletonPaneIdByKind.get(pane.kind) === pane.id,
  );
  const activePaneId =
    persistedActivePaneId && panes.some((pane) => pane.id === persistedActivePaneId)
      ? persistedActivePaneId
      : (panes[0]?.id ?? null);
  return {
    open: candidate.open === true,
    panes,
    activePaneId,
  };
}

export function sanitizeRightDockStateByThreadId(
  value: unknown,
): Record<string, RightDockThreadState> {
  return sanitizeStringKeyedRecord(value, (raw) =>
    raw === undefined ? null : sanitizeRightDockThreadState(raw),
  );
}

export interface OpenPaneInput {
  paneId: string;
  kind: RightDockPaneKind;
  threadId?: ThreadId | null;
  diffTurnId?: TurnId | null;
  diffFilePath?: string | null;
  filePath?: string | null;
  pullRequestProjectId?: ProjectId | null;
  pullRequestRepository?: string | null;
  pullRequestNumber?: number | null;
  pullRequestInitialTab?: PullRequestInitialTab | null;
}

function createPane(input: OpenPaneInput): RightDockPane {
  return {
    id: input.paneId,
    kind: input.kind,
    threadId: input.threadId ?? null,
    diffTurnId: input.diffTurnId ?? null,
    diffFilePath: input.diffFilePath ?? null,
    filePath: input.filePath ?? null,
    pullRequestProjectId: input.pullRequestProjectId ?? null,
    pullRequestRepository: input.pullRequestRepository ?? null,
    pullRequestNumber: input.pullRequestNumber ?? null,
    pullRequestInitialTab: input.pullRequestInitialTab ?? null,
  };
}

// only overwrite content metadata when the caller targets new content — a bare re-open keeps the pane focused on what it shows
function singletonPaneReopenPatch(input: OpenPaneInput): Partial<RightDockPane> | null {
  if (input.kind === "sidechat" && input.threadId !== undefined) {
    return { threadId: input.threadId ?? null };
  }
  if (
    input.kind === "diff" &&
    (input.diffTurnId !== undefined || input.diffFilePath !== undefined)
  ) {
    return { diffTurnId: input.diffTurnId ?? null, diffFilePath: input.diffFilePath ?? null };
  }
  if (
    input.kind === "pullRequest" &&
    (input.pullRequestProjectId !== undefined ||
      input.pullRequestRepository !== undefined ||
      input.pullRequestNumber !== undefined ||
      input.pullRequestInitialTab !== undefined)
  ) {
    return {
      pullRequestProjectId: input.pullRequestProjectId ?? null,
      pullRequestRepository: input.pullRequestRepository ?? null,
      pullRequestNumber: input.pullRequestNumber ?? null,
      pullRequestInitialTab: input.pullRequestInitialTab ?? null,
    };
  }
  return null;
}

// Multi-instance file panes reuse an existing pane when it already shows the requested path, so re-clicking a file focuses its tab instead of duplicating it.
function findMatchingMultiInstancePane(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockPane | undefined {
  if (input.kind === "file") {
    const filePath = input.filePath ?? null;
    return state.panes.find((pane) => pane.kind === "file" && pane.filePath === filePath);
  }
  return undefined;
}

function findSingletonPane(
  state: RightDockThreadState,
  kind: RightDockPaneKind,
): RightDockPane | undefined {
  return state.panes.find((pane) => pane.kind === kind);
}

export function openPaneInState(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockThreadState {
  if (isSingletonPaneKind(input.kind)) {
    const existing = findSingletonPane(state, input.kind);
    if (existing) {
      const patch = singletonPaneReopenPatch(input);
      const nextPanes = patch
        ? state.panes.map((pane) => (pane.id === existing.id ? { ...pane, ...patch } : pane))
        : state.panes;
      return { open: true, panes: nextPanes, activePaneId: existing.id };
    }
  } else {
    const existing = findMatchingMultiInstancePane(state, input);
    if (existing) {
      return { open: true, panes: state.panes, activePaneId: existing.id };
    }
  }

  const pane = createPane(input);
  return {
    open: true,
    panes: [...state.panes, pane],
    activePaneId: pane.id,
  };
}

function resolveActiveAfterRemoval(
  panes: RightDockPane[],
  removedIndex: number,
  previousActiveId: string | null,
  removedId: string,
): string | null {
  if (previousActiveId !== removedId) {
    return previousActiveId;
  }
  if (panes.length === 0) {
    return null;
  }
  const neighborIndex = Math.min(removedIndex, panes.length - 1);
  return panes[neighborIndex]?.id ?? null;
}

export function closePaneInState(
  state: RightDockThreadState,
  paneId: string,
): RightDockThreadState {
  const removedIndex = state.panes.findIndex((pane) => pane.id === paneId);
  if (removedIndex === -1) {
    return state;
  }
  const nextPanes = state.panes.filter((pane) => pane.id !== paneId);
  const nextActiveId = resolveActiveAfterRemoval(
    nextPanes,
    removedIndex,
    state.activePaneId,
    paneId,
  );
  return {
    // An open dock with no panes is the launcher state. Closing the final tab returns to that launcher instead of collapsing the entire dock.
    open: state.open,
    panes: nextPanes,
    activePaneId: nextActiveId,
  };
}

export function setActivePaneInState(
  state: RightDockThreadState,
  paneId: string,
): RightDockThreadState {
  if (!state.panes.some((pane) => pane.id === paneId)) {
    return state;
  }
  return { ...state, open: true, activePaneId: paneId };
}

export function setDockOpenInState(
  state: RightDockThreadState,
  open: boolean,
): RightDockThreadState {
  if (state.open === open) {
    return state;
  }
  return { ...state, open };
}

export function updatePaneInState(
  state: RightDockThreadState,
  paneId: string,
  patch: Partial<
    Pick<
      RightDockPane,
      | "diffTurnId"
      | "diffFilePath"
      | "filePath"
      | "threadId"
      | "pullRequestProjectId"
      | "pullRequestRepository"
      | "pullRequestNumber"
      | "pullRequestInitialTab"
    >
  >,
): RightDockThreadState {
  let changed = false;
  const nextPanes = state.panes.map((pane) => {
    if (pane.id !== paneId) {
      return pane;
    }
    const nextPane = { ...pane, ...patch };
    if (
      nextPane.diffTurnId !== pane.diffTurnId ||
      nextPane.diffFilePath !== pane.diffFilePath ||
      nextPane.filePath !== pane.filePath ||
      nextPane.threadId !== pane.threadId ||
      nextPane.pullRequestProjectId !== pane.pullRequestProjectId ||
      nextPane.pullRequestRepository !== pane.pullRequestRepository ||
      nextPane.pullRequestNumber !== pane.pullRequestNumber ||
      nextPane.pullRequestInitialTab !== pane.pullRequestInitialTab
    ) {
      changed = true;
      return nextPane;
    }
    return pane;
  });
  return changed ? { ...state, panes: nextPanes } : state;
}

// header toggle = visibility switch for a singleton kind: active visible pane collapses the dock (preserving tabs), otherwise open/focus it
export function toggleSingletonPaneInState(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockThreadState {
  const existing = findSingletonPane(state, input.kind);
  if (existing && state.open && state.activePaneId === existing.id) {
    return { ...state, open: false };
  }
  return openPaneInState(state, input);
}

export function resolveActivePane(state: RightDockThreadState): RightDockPane | null {
  if (!state.open || state.activePaneId === null) {
    return null;
  }
  return state.panes.find((pane) => pane.id === state.activePaneId) ?? null;
}

export function findMissingSidechatPaneIds(
  state: RightDockThreadState,
  existingThreadIds: ReadonlySet<ThreadId>,
): readonly string[] {
  return state.panes.flatMap((pane) =>
    pane.kind === "sidechat" && pane.threadId && !existingThreadIds.has(pane.threadId)
      ? [pane.id]
      : [],
  );
}

// an active sidechat embeds a full chat and needs a detail lease like a split pane; unrendered docks stay out of the live-stream budget
export function resolveVisibleDockSidechatThreadIds(input: {
  dockRendered: boolean;
  dockStateByThreadId: Record<string, RightDockThreadState | undefined>;
  hostThreadIds: readonly ThreadId[];
}): ThreadId[] {
  if (!input.dockRendered) {
    return [];
  }

  const sidechatThreadIds: ThreadId[] = [];
  const seenThreadIds = new Set<ThreadId>(input.hostThreadIds);
  for (const hostThreadId of input.hostThreadIds) {
    const dockState = input.dockStateByThreadId[hostThreadId];
    if (!dockState) {
      continue;
    }
    const activePane = resolveActivePane(dockState);
    if (
      activePane?.kind === "sidechat" &&
      activePane.threadId &&
      !seenThreadIds.has(activePane.threadId)
    ) {
      seenThreadIds.add(activePane.threadId);
      sidechatThreadIds.push(activePane.threadId);
    }
  }
  return sidechatThreadIds;
}
