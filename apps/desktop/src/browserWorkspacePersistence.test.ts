import * as FS from "node:fs";
import * as Path from "node:path";

import { ThreadId, type ThreadBrowserState } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserWorkspacePersistence, readBrowserWorkspaces } from "./browserWorkspacePersistence";

function workspace(index = 0, count = 2): ThreadBrowserState {
  return {
    threadId: ThreadId.makeUnsafe(`thread-${index}`),
    version: 5,
    open: true,
    activeTabId: `tab-${count - 1}`,
    tabs: Array.from({ length: count }, (_, tab) => ({
      id: `tab-${tab}`,
      url: `https://example.test/${tab}`,
      title: `Page ${tab}`,
      runtimeSurface: "renderer",
      status: "live",
      isLoading: true,
      canGoBack: true,
      canGoForward: true,
      faviconUrl: "data:image/png;base64,private",
      lastCommittedUrl: null,
      lastError: "temporary error",
    })),
    lastError: null,
  };
}

describe("browser workspace persistence", () => {
  let directory: string;
  let filePath: string;
  let persistence: BrowserWorkspacePersistence;

  beforeEach(() => {
    vi.useFakeTimers();
    directory = FS.mkdtempSync(Path.join(process.cwd(), ".browser-workspace-test-"));
    filePath = Path.join(directory, "userdata", "browser-workspaces.json");
    persistence = new BrowserWorkspacePersistence(filePath);
  });

  afterEach(() => {
    persistence.flush();
    vi.useRealTimers();
    FS.rmSync(directory, { recursive: true, force: true });
  });

  it("round trips only tab metadata, committed URLs, active tab and order", () => {
    const state = workspace();
    state.tabs[0]!.lastCommittedUrl = "https://example.test/committed";
    persistence.update(state);
    persistence.flush();
    expect(readBrowserWorkspaces(filePath)).toEqual([
      {
        threadId: state.threadId,
        open: true,
        activeTabId: "tab-1",
        tabs: [
          { id: "tab-0", url: "https://example.test/committed", title: "Page 0" },
          { id: "tab-1", url: "https://example.test/1", title: "Page 1" },
        ],
      },
    ]);
    expect(JSON.parse(FS.readFileSync(filePath, "utf8"))).toEqual({
      version: 1,
      workspaces: readBrowserWorkspaces(filePath),
    });
    expect(new BrowserWorkspacePersistence(filePath).restoredWorkspaces()).toEqual(
      readBrowserWorkspaces(filePath),
    );
  });

  it("caps tabs at 20, retaining the active tab in its original order", () => {
    persistence.update(workspace(0, 25));
    persistence.flush();
    const restored = readBrowserWorkspaces(filePath)[0]!;
    expect(restored.tabs).toHaveLength(20);
    expect(restored.tabs.map((tab) => tab.id)).toEqual([
      ...Array.from({ length: 19 }, (_, index) => `tab-${index}`),
      "tab-24",
    ]);
    expect(restored.activeTabId).toBe("tab-24");
  });

  it("keeps the 50 most recently changed threads", () => {
    for (let index = 0; index < 50; index++) persistence.update(workspace(index));
    const oldest = workspace(0);
    oldest.tabs[0]!.title = "Updated";
    persistence.update(oldest);
    persistence.update(workspace(50));
    persistence.flush();
    const restored = readBrowserWorkspaces(filePath);
    expect(restored).toHaveLength(50);
    expect(restored[0]!.threadId).toBe("thread-2");
    expect(restored.at(-2)!.threadId).toBe("thread-0");
    expect(restored.at(-1)!.threadId).toBe("thread-50");
  });

  it("debounces updates and ignores changes to transient runtime fields", () => {
    const state = workspace();
    persistence.update(state);
    vi.advanceTimersByTime(400);
    state.tabs[0]!.title = "Latest title";
    persistence.update(state);
    vi.advanceTimersByTime(400);
    expect(FS.existsSync(filePath)).toBe(false);
    vi.advanceTimersByTime(100);
    expect(readBrowserWorkspaces(filePath)[0]!.tabs[0]!.title).toBe("Latest title");
    FS.unlinkSync(filePath);
    state.tabs[0]!.isLoading = false;
    state.tabs[0]!.status = "suspended";
    persistence.update(state);
    vi.advanceTimersByTime(1000);
    expect(FS.existsSync(filePath)).toBe(false);
  });

  it("removes closed browsers and about:blank-only workspaces", () => {
    const state = workspace();
    persistence.update(state);
    persistence.flush();
    persistence.update({ ...state, open: false });
    persistence.flush();
    expect(readBrowserWorkspaces(filePath)).toEqual([]);
    state.tabs.forEach((tab) => {
      tab.url = "about:blank";
    });
    persistence.update(state);
    persistence.flush();
    expect(readBrowserWorkspaces(filePath)).toEqual([]);
  });

  it("preserves an active blank tab alongside a real page", () => {
    const state = workspace();
    state.tabs[1]!.url = "about:blank";
    persistence.update(state);
    persistence.flush();
    expect(readBrowserWorkspaces(filePath)[0]).toMatchObject({
      activeTabId: "tab-1",
      tabs: [{ id: "tab-0" }, { id: "tab-1", url: "about:blank" }],
    });
  });

  it("drops inline content and invalid URLs, repairing the active tab", () => {
    const state = workspace(0, 4);
    state.tabs[1]!.url = "data:text/html,private-page-content";
    state.tabs[2]!.url = "javascript:alert(1)";
    state.tabs[3]!.url = "not a URL";
    persistence.update(state);
    persistence.flush();
    const restored = readBrowserWorkspaces(filePath)[0]!;
    expect(restored.tabs).toHaveLength(1);
    expect(restored.activeTabId).toBe("tab-0");
    expect(FS.readFileSync(filePath, "utf8")).not.toContain("private-page-content");
  });

  it.each(["{invalid", "null", '{"version":2,"workspaces":[]}', '{"version":1,"workspaces":{}}'])(
    "silently ignores corrupt or unsupported files: %s",
    (contents) => {
      FS.mkdirSync(Path.dirname(filePath), { recursive: true });
      FS.writeFileSync(filePath, contents);
      expect(readBrowserWorkspaces(filePath)).toEqual([]);
    },
  );

  it("silently ignores a missing file", () => {
    expect(readBrowserWorkspaces(filePath)).toEqual([]);
  });

  it("validates and caps incoming files, ignoring extra fields and duplicate tabs", () => {
    const states = Array.from({ length: 55 }, (_, index) => workspace(index, 25));
    states[54]!.tabs.splice(1, 0, states[54]!.tabs[0]!);
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, JSON.stringify({ version: 1, workspaces: [null, {}, ...states] }));
    const restored = readBrowserWorkspaces(filePath);
    expect(restored).toHaveLength(50);
    expect(restored[0]!.threadId).toBe("thread-5");
    expect(restored.at(-1)!.tabs).toHaveLength(20);
    expect(new Set(restored.at(-1)!.tabs.map((tab) => tab.id)).size).toBe(20);
    expect(restored.at(-1)!.activeTabId).toBe("tab-24");
    expect(restored.at(-1)!.tabs[0]).not.toHaveProperty("runtimeSurface");
  });

  it("ignores oversized files", () => {
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, " ".repeat(8 * 1024 * 1024 + 1));
    expect(readBrowserWorkspaces(filePath)).toEqual([]);
  });

  it("does not throw if the persistence location cannot be written", () => {
    FS.writeFileSync(Path.join(directory, "userdata"), "not a directory");
    persistence.update(workspace());
    expect(() => persistence.flush()).not.toThrow();
  });
});
