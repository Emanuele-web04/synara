import { ProjectId, ThreadId, type NativeApi, type ThreadBrowserState } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { closeLiveEditPreviewTabs, openLiveEditPreviewTab } from "./liveEditPreviewTabs";

function createBrowserApiMock(threadId: ThreadId): NativeApi {
  let tabIndex = 0;
  const states = new Map<ThreadId, ThreadBrowserState>();
  const stateForThread = (nextThreadId: ThreadId) => {
    const existing = states.get(nextThreadId);
    if (existing) return existing;
    const state: ThreadBrowserState = {
      threadId: nextThreadId,
      version: 0,
      open: false,
      activeTabId: null,
      tabs: [],
      lastError: null,
    };
    states.set(nextThreadId, state);
    return state;
  };
  const clone = (state: ThreadBrowserState) => ({
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
  });
  const createTab = (nextThreadId: ThreadId, url = "about:blank") => ({
    id: `${nextThreadId}:tab-${++tabIndex}`,
    url,
    title: url,
    status: "live" as const,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: url === "about:blank" ? null : url,
    lastError: null,
  });

  return {
    browser: {
      open: async (input) => {
        const state = stateForThread(input.threadId);
        state.open = true;
        if (state.tabs.length === 0) {
          const tab = createTab(input.threadId, input.initialUrl);
          state.tabs = [tab];
          state.activeTabId = tab.id;
        }
        state.version += 1;
        return clone(state);
      },
      navigate: async (input) => {
        const state = stateForThread(input.threadId);
        const tab =
          state.tabs.find((entry) => entry.id === input.tabId) ??
          state.tabs.find((entry) => entry.id === state.activeTabId) ??
          state.tabs[0];
        if (!tab) throw new Error("No tab");
        tab.url = input.url;
        tab.title = input.url;
        tab.lastCommittedUrl = input.url;
        state.version += 1;
        return clone(state);
      },
      newTab: async (input) => {
        const state = stateForThread(input.threadId);
        const tab = createTab(input.threadId, input.url);
        state.tabs.push(tab);
        if (input.activate !== false) {
          state.activeTabId = tab.id;
        }
        state.version += 1;
        return clone(state);
      },
      selectTab: async (input) => {
        const state = stateForThread(input.threadId);
        state.activeTabId = input.tabId;
        state.version += 1;
        return clone(state);
      },
      getState: async (input) => clone(stateForThread(input.threadId)),
      listStates: async () => Array.from(states.values(), clone),
      closeTab: async (input) => {
        const state = stateForThread(input.threadId);
        state.tabs = state.tabs.filter((tab) => tab.id !== input.tabId);
        if (state.activeTabId === input.tabId) {
          state.activeTabId = state.tabs[0]?.id ?? null;
        }
        if (state.tabs.length === 0) {
          state.open = false;
        }
        state.version += 1;
        return clone(state);
      },
    },
  } as NativeApi;
}

describe("live edit preview tabs", () => {
  it("routes each project preview back to its own tab", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-edit-tabs");
    const api = createBrowserApiMock(threadId);
    const firstProjectId = ProjectId.makeUnsafe("project-live-edit-a");
    const secondProjectId = ProjectId.makeUnsafe("project-live-edit-b");

    const firstState = await openLiveEditPreviewTab(api, {
      threadId,
      cwd: "/tmp/project-a",
      projectId: firstProjectId,
      url: "http://127.0.0.1:5173/",
    });
    expect(firstState.tabs).toHaveLength(1);
    expect(firstState.tabs[0]?.url).toBe("http://127.0.0.1:5173/");

    const secondState = await openLiveEditPreviewTab(api, {
      threadId,
      cwd: "/tmp/project-b",
      projectId: secondProjectId,
      url: "http://127.0.0.1:5174/",
    });
    expect(secondState.tabs).toHaveLength(2);
    expect(secondState.tabs.find((tab) => tab.id === secondState.activeTabId)?.url).toBe(
      "http://127.0.0.1:5174/",
    );

    const routedBackState = await openLiveEditPreviewTab(api, {
      threadId,
      cwd: "/tmp/project-a",
      projectId: firstProjectId,
      url: "http://127.0.0.1:5173/",
    });
    expect(routedBackState.tabs).toHaveLength(2);
    expect(routedBackState.tabs.find((tab) => tab.id === routedBackState.activeTabId)?.url).toBe(
      "http://127.0.0.1:5173/",
    );
  });

  it("keeps the current page when passively re-routing a tab already on the preview origin", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-edit-preserve-path");
    const api = createBrowserApiMock(threadId);
    const projectId = ProjectId.makeUnsafe("project-live-edit-preserve-path");
    const target = {
      threadId,
      cwd: "/tmp/preserve-path-project",
      projectId,
      url: "http://127.0.0.1:5173/",
    };

    const openedState = await openLiveEditPreviewTab(api, target);
    const previewTabId = openedState.activeTabId;
    expect(previewTabId).not.toBeNull();

    // The user browses to a deeper page inside the preview server.
    await api.browser.navigate({
      threadId,
      tabId: previewTabId!,
      url: "http://127.0.0.1:5173/settings/profile",
    });

    const preservedState = await openLiveEditPreviewTab(api, target, {
      preserveExistingPath: true,
    });
    expect(preservedState.tabs.find((tab) => tab.id === previewTabId)?.url).toBe(
      "http://127.0.0.1:5173/settings/profile",
    );

    // Without the flag (explicit preview open) the root URL still wins.
    const explicitState = await openLiveEditPreviewTab(api, target);
    expect(explicitState.tabs.find((tab) => tab.id === previewTabId)?.url).toBe(
      "http://127.0.0.1:5173/",
    );
  });

  it("adopts an untracked same-origin tab when preserving the existing path", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-edit-adopt-origin");
    const api = createBrowserApiMock(threadId);

    // Simulates a page reload: the tab exists on a deeper preview page but the
    // in-memory record map has no entry for it.
    await api.browser.open({
      threadId,
      initialUrl: "http://127.0.0.1:5175/dashboard",
    });

    const state = await openLiveEditPreviewTab(
      api,
      {
        threadId,
        cwd: "/tmp/adopt-origin-project",
        projectId: ProjectId.makeUnsafe("project-live-edit-adopt-origin"),
        url: "http://127.0.0.1:5175/",
      },
      { preserveExistingPath: true },
    );

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.url).toBe("http://127.0.0.1:5175/dashboard");
  });

  it("does not reuse another project tab only because the preview URL matches", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-edit-same-url-tabs");
    const api = createBrowserApiMock(threadId);

    await openLiveEditPreviewTab(api, {
      threadId,
      cwd: "/tmp/same-url-project-a",
      projectId: ProjectId.makeUnsafe("project-live-edit-same-url-a"),
      url: "http://127.0.0.1:5173/",
    });
    const secondState = await openLiveEditPreviewTab(api, {
      threadId,
      cwd: "/tmp/same-url-project-b",
      projectId: ProjectId.makeUnsafe("project-live-edit-same-url-b"),
      url: "http://127.0.0.1:5173/",
    });

    expect(secondState.tabs).toHaveLength(2);
    expect(secondState.activeTabId).not.toBe(secondState.tabs[0]?.id);
  });

  it("closes only the matching project preview tabs", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-edit-close-tabs");
    const api = createBrowserApiMock(threadId);
    const firstProjectId = ProjectId.makeUnsafe("project-live-edit-close-a");
    const secondProjectId = ProjectId.makeUnsafe("project-live-edit-close-b");

    await openLiveEditPreviewTab(api, {
      threadId,
      cwd: "/tmp/close-project-a",
      projectId: firstProjectId,
      url: "http://127.0.0.1:6173/",
    });
    await openLiveEditPreviewTab(api, {
      threadId,
      cwd: "/tmp/close-project-b",
      projectId: secondProjectId,
      url: "http://127.0.0.1:6174/",
    });

    const states = await closeLiveEditPreviewTabs(api, {
      threadId,
      cwd: "/tmp/close-project-a",
      projectId: firstProjectId,
    });
    const finalState = states.at(-1) ?? (await api.browser.getState({ threadId }));
    expect(finalState.tabs).toHaveLength(1);
    expect(finalState.tabs[0]?.url).toBe("http://127.0.0.1:6174/");
  });

  it("closes all known live edit preview tabs without a filter", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-edit-close-all-tabs");
    const api = createBrowserApiMock(threadId);

    await openLiveEditPreviewTab(api, {
      threadId,
      cwd: "/tmp/close-all-project-a",
      projectId: ProjectId.makeUnsafe("project-live-edit-close-all-a"),
      url: "http://127.0.0.1:7173/",
    });
    await openLiveEditPreviewTab(api, {
      threadId,
      cwd: "/tmp/close-all-project-b",
      projectId: ProjectId.makeUnsafe("project-live-edit-close-all-b"),
      url: "http://127.0.0.1:7174/",
    });

    const states = await closeLiveEditPreviewTabs(api);
    const finalState = states.at(-1) ?? (await api.browser.getState({ threadId }));
    expect(finalState.tabs).toHaveLength(0);
  });

  it("closes matching preview URL tabs even when no live edit record exists", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-edit-close-url-tabs");
    const api = createBrowserApiMock(threadId);

    await api.browser.open({
      threadId,
      initialUrl: "http://127.0.0.1:8173/",
    });

    const states = await closeLiveEditPreviewTabs(api, {
      urls: ["http://127.0.0.1:8173"],
      fallbackThreadIds: [threadId],
    });
    const finalState = states.at(-1) ?? (await api.browser.getState({ threadId }));
    expect(finalState.tabs).toHaveLength(0);
  });

  it("can sweep local preview tabs for nuke when no URL was reported", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-edit-local-sweep-tabs");
    const api = createBrowserApiMock(threadId);

    await api.browser.open({
      threadId,
      initialUrl: "http://127.0.0.1:9173/",
    });

    const states = await closeLiveEditPreviewTabs(api, {
      fallbackThreadIds: [threadId],
      closeLocalPreviewTabs: true,
    });
    const finalState = states.at(-1) ?? (await api.browser.getState({ threadId }));
    expect(finalState.tabs).toHaveLength(0);
  });

  it("sweeps local preview tabs across all browser states for nuke", async () => {
    const currentThreadId = ThreadId.makeUnsafe("thread-live-edit-current-nuke-tabs");
    const otherThreadId = ThreadId.makeUnsafe("thread-live-edit-other-nuke-tabs");
    const api = createBrowserApiMock(currentThreadId);

    await api.browser.open({
      threadId: currentThreadId,
      initialUrl: "http://127.0.0.1:10173/",
    });
    await api.browser.open({
      threadId: otherThreadId,
      initialUrl: "http://127.0.0.1:10174/",
    });

    await closeLiveEditPreviewTabs(api, {
      fallbackThreadIds: [currentThreadId],
      closeLocalPreviewTabs: true,
    });

    expect((await api.browser.getState({ threadId: currentThreadId })).tabs).toHaveLength(0);
    expect((await api.browser.getState({ threadId: otherThreadId })).tabs).toHaveLength(0);
  });

  it("closes reported preview URLs across all browser states for nuke", async () => {
    const currentThreadId = ThreadId.makeUnsafe("thread-live-edit-current-url-nuke-tabs");
    const otherThreadId = ThreadId.makeUnsafe("thread-live-edit-other-url-nuke-tabs");
    const api = createBrowserApiMock(currentThreadId);

    await api.browser.open({
      threadId: currentThreadId,
      initialUrl: "https://example.com/",
    });
    await api.browser.open({
      threadId: otherThreadId,
      initialUrl: "https://preview.example.test/",
    });

    await closeLiveEditPreviewTabs(api, {
      urls: ["https://preview.example.test/"],
      fallbackThreadIds: [currentThreadId],
      closeLocalPreviewTabs: true,
    });

    expect((await api.browser.getState({ threadId: currentThreadId })).tabs).toHaveLength(1);
    expect((await api.browser.getState({ threadId: otherThreadId })).tabs).toHaveLength(0);
  });
});
