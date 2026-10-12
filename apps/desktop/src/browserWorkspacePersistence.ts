// Main-process browser metadata only; runtime/session data never crosses this boundary.
import * as FS from "node:fs";
import * as Path from "node:path";

import { ThreadId, type ThreadBrowserState } from "@synara/contracts";
import { BROWSER_BLANK_URL } from "@synara/shared/browserSession";

const MAX_TABS = 20;
const MAX_THREADS = 50;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const WRITE_DELAY_MS = 500;

interface PersistedBrowserTab {
  id: string;
  url: string;
  title: string;
}

interface PersistedBrowserWorkspace {
  threadId: ThreadId;
  open: true;
  activeTabId: string;
  // Array order is tab order. Workspace array order is oldest to newest.
  tabs: PersistedBrowserTab[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function isRestorableUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  if (value === BROWSER_BLANK_URL) return true;
  try {
    // Exclude inline page content (data:), transient blobs and executable schemes.
    return ["http:", "https:", "file:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function normalizeWorkspace(value: unknown): PersistedBrowserWorkspace | null {
  if (
    !isRecord(value) ||
    !isId(value.threadId) ||
    value.open !== true ||
    !Array.isArray(value.tabs)
  ) {
    return null;
  }
  const seen = new Set<string>();
  const tabs: PersistedBrowserTab[] = [];
  for (const tab of value.tabs) {
    if (!isRecord(tab) || !isId(tab.id) || seen.has(tab.id)) continue;
    const url = tab.lastCommittedUrl ?? tab.url;
    if (!isRestorableUrl(url) || typeof tab.title !== "string") continue;
    seen.add(tab.id);
    tabs.push({ id: tab.id, url, title: tab.title.slice(0, 512) });
  }
  const active = tabs.find((tab) => tab.id === value.activeTabId);
  const retained = tabs.slice(0, MAX_TABS);
  // Keep the active tab even when it lies beyond the cap, without reordering it.
  if (active && !retained.includes(active)) retained[MAX_TABS - 1] = active;
  if (!retained.some((tab) => tab.url !== BROWSER_BLANK_URL)) return null;
  return {
    threadId: ThreadId.makeUnsafe(value.threadId),
    open: true,
    activeTabId: active?.id ?? retained[0]!.id,
    tabs: retained,
  };
}

export function readBrowserWorkspaces(filePath: string): PersistedBrowserWorkspace[] {
  try {
    if (FS.statSync(filePath).size > MAX_FILE_BYTES) return [];
    const value: unknown = JSON.parse(FS.readFileSync(filePath, "utf8"));
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.workspaces)) return [];
    const byThread = new Map<ThreadId, PersistedBrowserWorkspace>();
    for (const entry of value.workspaces) {
      const state = normalizeWorkspace(entry);
      if (!state) continue;
      byThread.delete(state.threadId);
      byThread.set(state.threadId, state);
    }
    return [...byThread.values()].slice(-MAX_THREADS);
  } catch {
    return [];
  }
}

export class BrowserWorkspacePersistence {
  private readonly workspaces: Map<ThreadId, PersistedBrowserWorkspace>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(private readonly filePath: string) {
    this.workspaces = new Map(
      readBrowserWorkspaces(filePath).map((state) => [state.threadId, state]),
    );
  }

  restoredWorkspaces(): ReadonlyArray<PersistedBrowserWorkspace> {
    return [...this.workspaces.values()];
  }

  update(state: ThreadBrowserState): void {
    const next = normalizeWorkspace(state);
    const previous = this.workspaces.get(state.threadId);
    // Loading flags, favicons, runtime status and errors must not cause disk writes.
    if (JSON.stringify(previous ?? null) === JSON.stringify(next)) return;
    this.workspaces.delete(state.threadId);
    if (next) this.workspaces.set(state.threadId, next);
    while (this.workspaces.size > MAX_THREADS) {
      this.workspaces.delete(this.workspaces.keys().next().value!);
    }
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    this.timer.unref();
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    try {
      FS.mkdirSync(Path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      FS.writeFileSync(
        temporaryPath,
        JSON.stringify({ version: 1, workspaces: [...this.workspaces.values()] }),
        { encoding: "utf8", mode: 0o600 },
      );
      FS.renameSync(temporaryPath, this.filePath);
      this.dirty = false;
    } catch {
      // Optional recovery metadata must never prevent browsing or quitting.
    }
  }
}
