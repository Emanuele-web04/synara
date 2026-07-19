// FILE: editorViewState.ts
// Purpose: Persists per-thread editor workspace view state (expanded explorer
//          directories, center mode) so re-entering the editor view restores it.
// Layer: Web UI state persistence

import type { ProviderKind, ThreadId } from "@synara/contracts";
import { isProviderKind } from "./providerOrdering";

const EDITOR_VIEW_STATE_STORAGE_KEY = "synara.editor.viewStateByThreadId";
const EDITOR_RAIL_CHAT_TABS_STORAGE_KEY = "synara.editor.railChatTabsByProjectId";
const EDITOR_RAIL_CLOSED_CHAT_TABS_STORAGE_KEY = "synara.editor.closedRailChatTabsByScopeId";
const EDITOR_RAIL_ACTIVE_CHAT_STORAGE_KEY = "synara.editor.railActiveChatByScopeId";
const MAX_PERSISTED_THREADS = 50;
const MAX_EDITOR_RAIL_CHAT_TABS = 8;
const MAX_EDITOR_RAIL_CLOSED_CHAT_TABS = 30;
const MAX_PERSISTED_EDITOR_RAIL_SCOPES = 100;

export interface EditorViewStateSnapshot {
  expandedDirectories: ReadonlyArray<string>;
  centerMode: "file" | "diff";
}

interface PersistedEditorViewState extends EditorViewStateSnapshot {
  updatedAt: number;
}

type PersistedEditorViewStateMap = Record<string, PersistedEditorViewState>;

export interface EditorRailChatTabSnapshot {
  id: ThreadId;
  title: string;
  provider: ProviderKind;
}

type PersistedEditorRailChatTabsMap = Record<string, ReadonlyArray<EditorRailChatTabSnapshot>>;

interface PersistedEditorRailActiveChat {
  threadId: ThreadId;
  updatedAt: number;
}

type PersistedEditorRailActiveChatMap = Record<string, PersistedEditorRailActiveChat>;

function readPersistedMap(): PersistedEditorViewStateMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as PersistedEditorViewStateMap;
  } catch {
    return {};
  }
}

export function readEditorViewState(threadId: string): EditorViewStateSnapshot | null {
  const entry = readPersistedMap()[threadId];
  if (!entry) {
    return null;
  }
  return {
    expandedDirectories: Array.isArray(entry.expandedDirectories)
      ? entry.expandedDirectories.filter((path): path is string => typeof path === "string")
      : [],
    centerMode: entry.centerMode === "file" ? "file" : "diff",
  };
}

export function storeEditorViewState(threadId: string, snapshot: EditorViewStateSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const map = readPersistedMap();
    map[threadId] = { ...snapshot, updatedAt: Date.now() };
    const entries = Object.entries(map);
    if (entries.length > MAX_PERSISTED_THREADS) {
      entries
        .toSorted((left, right) => (left[1]?.updatedAt ?? 0) - (right[1]?.updatedAt ?? 0))
        .slice(0, entries.length - MAX_PERSISTED_THREADS)
        .forEach(([staleThreadId]) => {
          delete map[staleThreadId];
        });
    }
    window.localStorage.setItem(EDITOR_VIEW_STATE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort preference persistence only.
  }
}

function normalizeEditorRailChatTabs(
  tabs: ReadonlyArray<EditorRailChatTabSnapshot>,
  limit = MAX_EDITOR_RAIL_CHAT_TABS,
): ReadonlyArray<EditorRailChatTabSnapshot> {
  const seen = new Set<ThreadId>();
  const normalized: EditorRailChatTabSnapshot[] = [];
  for (const tab of tabs) {
    if (seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    normalized.push({
      id: tab.id,
      title: tab.title.trim() || "New thread",
      provider: tab.provider,
    });
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
}

function readEditorRailChatTabsMap(
  storageKey = EDITOR_RAIL_CHAT_TABS_STORAGE_KEY,
  limit = MAX_EDITOR_RAIL_CHAT_TABS,
): PersistedEditorRailChatTabsMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const map: PersistedEditorRailChatTabsMap = {};
    for (const [projectId, rawTabs] of Object.entries(parsed)) {
      if (!Array.isArray(rawTabs)) {
        continue;
      }
      map[projectId] = normalizeEditorRailChatTabs(
        rawTabs.flatMap((rawTab): EditorRailChatTabSnapshot[] => {
          if (typeof rawTab !== "object" || rawTab === null || Array.isArray(rawTab)) {
            return [];
          }
          const candidate = rawTab as Record<string, unknown>;
          if (
            typeof candidate.id !== "string" ||
            typeof candidate.title !== "string" ||
            typeof candidate.provider !== "string" ||
            !isProviderKind(candidate.provider)
          ) {
            return [];
          }
          return [
            {
              id: candidate.id as ThreadId,
              title: candidate.title,
              provider: candidate.provider,
            },
          ];
        }),
        limit,
      );
    }
    return map;
  } catch {
    return {};
  }
}

export function readEditorRailChatTabs(scopeKey: string): ReadonlyArray<EditorRailChatTabSnapshot> {
  return readEditorRailChatTabsMap()[scopeKey] ?? [];
}

export function storeEditorRailChatTabs(
  scopeKey: string,
  tabs: ReadonlyArray<EditorRailChatTabSnapshot>,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const map = readEditorRailChatTabsMap();
    const normalizedTabs = normalizeEditorRailChatTabs(tabs);
    if (normalizedTabs.length === 0) {
      delete map[scopeKey];
    } else {
      map[scopeKey] = normalizedTabs;
    }
    window.localStorage.setItem(EDITOR_RAIL_CHAT_TABS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort preference persistence only.
  }
}

export function readEditorRailClosedChatTabs(
  scopeKey: string,
): ReadonlyArray<EditorRailChatTabSnapshot> {
  return (
    readEditorRailChatTabsMap(
      EDITOR_RAIL_CLOSED_CHAT_TABS_STORAGE_KEY,
      MAX_EDITOR_RAIL_CLOSED_CHAT_TABS,
    )[scopeKey] ?? []
  );
}

export function storeEditorRailClosedChatTabs(
  scopeKey: string,
  tabs: ReadonlyArray<EditorRailChatTabSnapshot>,
): void {
  if (typeof window === "undefined") return;
  try {
    const map = readEditorRailChatTabsMap(
      EDITOR_RAIL_CLOSED_CHAT_TABS_STORAGE_KEY,
      MAX_EDITOR_RAIL_CLOSED_CHAT_TABS,
    );
    const normalizedTabs = normalizeEditorRailChatTabs(
      tabs.slice(-MAX_EDITOR_RAIL_CLOSED_CHAT_TABS),
      MAX_EDITOR_RAIL_CLOSED_CHAT_TABS,
    );
    if (normalizedTabs.length === 0) {
      delete map[scopeKey];
    } else {
      map[scopeKey] = normalizedTabs;
    }
    window.localStorage.setItem(EDITOR_RAIL_CLOSED_CHAT_TABS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort preference persistence only.
  }
}

export function pushEditorRailClosedChatTab(
  scopeKey: string,
  tab: EditorRailChatTabSnapshot,
): void {
  const previous = readEditorRailClosedChatTabs(scopeKey).filter(
    (candidate) => candidate.id !== tab.id,
  );
  storeEditorRailClosedChatTabs(scopeKey, [...previous, tab]);
}

function readEditorRailActiveChatMap(): PersistedEditorRailActiveChatMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(EDITOR_RAIL_ACTIVE_CHAT_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const map: PersistedEditorRailActiveChatMap = {};
    for (const [scopeKey, rawEntry] of Object.entries(parsed)) {
      if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
        continue;
      }
      const entry = rawEntry as Record<string, unknown>;
      if (typeof entry.threadId !== "string" || typeof entry.updatedAt !== "number") {
        continue;
      }
      map[scopeKey] = {
        threadId: entry.threadId as ThreadId,
        updatedAt: entry.updatedAt,
      };
    }
    return map;
  } catch {
    return {};
  }
}

export function readEditorRailActiveChat(scopeKey: string): ThreadId | null {
  return readEditorRailActiveChatMap()[scopeKey]?.threadId ?? null;
}

export function storeEditorRailActiveChat(scopeKey: string, threadId: ThreadId): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const map = readEditorRailActiveChatMap();
    map[scopeKey] = { threadId, updatedAt: Date.now() };
    const entries = Object.entries(map);
    if (entries.length > MAX_PERSISTED_EDITOR_RAIL_SCOPES) {
      entries
        .toSorted((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(0, entries.length - MAX_PERSISTED_EDITOR_RAIL_SCOPES)
        .forEach(([staleScopeKey]) => {
          delete map[staleScopeKey];
        });
    }
    window.localStorage.setItem(EDITOR_RAIL_ACTIVE_CHAT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort preference persistence only.
  }
}
