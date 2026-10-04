import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  addOpenThreadTab,
  buildOpenThreadTabs,
  closeOpenThreadTab,
  closeOpenThreadTabs,
  createOpenThreadTabCloseQueue,
  moveOpenThreadTab,
  replaceLastTabWithFreshChat,
  normalizeOpenThreadTabIds,
  type OpenThreadTabSource,
  resolveOpenThreadTabCloseTarget,
  resolveOpenThreadTabsInCloseScope,
} from "./openThreadTabs.logic";
import type { SidebarThreadSummary, Thread } from "./types";

const projectA = ProjectId.makeUnsafe("project-a");
const projectB = ProjectId.makeUnsafe("project-b");

function summary(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: projectA,
    title: `Thread ${id}`,
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    session: null,
    ...overrides,
  } as SidebarThreadSummary;
}

function serverSource(
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
  terminalEntryPoint = false,
): OpenThreadTabSource {
  return {
    threadId: ThreadId.makeUnsafe(id),
    summary: summary(id, overrides),
    terminalEntryPoint,
  };
}

function tabIds(ids: readonly string[]) {
  return ids.map((id) => ({ threadId: ThreadId.makeUnsafe(id) }));
}

describe("open thread tab list", () => {
  it("keeps an already open thread in place and appends new ones", () => {
    const open = ["a", "b", "c"].map((id) => ThreadId.makeUnsafe(id));

    expect(addOpenThreadTab(open, ThreadId.makeUnsafe("a"))).toEqual(open);
    expect(addOpenThreadTab(open, ThreadId.makeUnsafe("d"))).toEqual([...open, "d"]);
  });

  it("moves a dragged tab into the slot of the tab it is dropped on", () => {
    const open = ["a", "b", "c", "d"].map((id) => ThreadId.makeUnsafe(id));
    const move = (from: string, to: string) =>
      moveOpenThreadTab(open, ThreadId.makeUnsafe(from), ThreadId.makeUnsafe(to));

    expect(move("a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(move("d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(move("b", "b")).toBe(open);
    expect(move("b", "missing")).toBe(open);
  });

  it("restores a persisted list without duplicates or malformed entries", () => {
    expect(normalizeOpenThreadTabIds(["a", " b ", "a", "", 3, null, "c"])).toEqual(["a", "b", "c"]);
    expect(normalizeOpenThreadTabIds({ threadIds: ["a"] })).toEqual([]);
  });
});

describe("buildOpenThreadTabs", () => {
  it("labels saved threads by title and provider", () => {
    const tabs = buildOpenThreadTabs({
      activeThreadId: null,
      sources: [
        serverSource("claude", {
          title: "Refactor rows",
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        }),
        // A live session wins over the stored model selection, as in the sidebar.
        serverSource("handed-off", {
          session: { provider: "cursor" } as SidebarThreadSummary["session"],
        }),
        serverSource("shell", {}, true),
      ],
    });

    expect(tabs).toEqual([
      expect.objectContaining({ title: "Refactor rows", provider: "claudeAgent" }),
      expect.objectContaining({ threadId: "handed-off", provider: "cursor" }),
      expect.objectContaining({ threadId: "shell", isTerminal: true }),
    ]);
  });

  it("marks a tab as running while its thread works, not while it waits on the user", () => {
    const tabs = buildOpenThreadTabs({
      activeThreadId: null,
      sources: [
        serverSource("idle"),
        serverSource("working", { hasLiveTailWork: true }),
        serverSource("connecting", {
          session: { status: "connecting" } as SidebarThreadSummary["session"],
        }),
        serverSource("approval", {
          hasLiveTailWork: true,
          hasPendingApprovals: true,
          session: { status: "running" } as SidebarThreadSummary["session"],
        }),
      ],
    });

    expect(tabs.map((tab) => [tab.threadId, tab.isRunning])).toEqual([
      ["idle", false],
      ["working", true],
      ["connecting", true],
      ["approval", false],
    ]);
  });

  it("names a subagent tab from its parent's activity when its own metadata is a placeholder", () => {
    const parentId = ThreadId.makeUnsafe("parent");
    const tabs = buildOpenThreadTabs({
      activeThreadId: null,
      sources: [
        {
          ...serverSource("subagent:parent:child-1", {
            title: "Subagent 019d8cae",
            parentThreadId: parentId,
          }),
          parentThread: {
            id: parentId,
            activities: [
              {
                payload: {
                  data: {
                    item: {
                      receiverThreadIds: ["child-1"],
                      receiverAgents: [
                        { threadId: "child-1", agentNickname: "Locke", agentRole: "explorer" },
                      ],
                    },
                  },
                },
              },
            ] as unknown as Thread["activities"],
          },
        },
      ],
    });

    expect(tabs.map((tab) => tab.title)).toEqual(["Locke [explorer]"]);
  });

  it("drops threads that no longer exist, and archived or Side chats unless on screen", () => {
    const sources: OpenThreadTabSource[] = [
      serverSource("kept"),
      { ...serverSource("deleted"), summary: undefined },
      serverSource("archived", { archivedAt: "2026-09-30T00:00:00.000Z" }),
      serverSource("side", { sidechatSourceThreadId: ThreadId.makeUnsafe("kept") }),
      serverSource("standalone-side", {
        sidechatContext: {
          kind: "github-item",
          itemKind: "issue",
          repository: "acme/widgets",
          number: 42,
          url: "https://github.com/acme/widgets/issues/42",
        },
      }),
    ];

    expect(
      buildOpenThreadTabs({ sources, activeThreadId: null }).map((tab) => tab.threadId),
    ).toEqual(["kept"]);
    expect(
      buildOpenThreadTabs({ sources, activeThreadId: ThreadId.makeUnsafe("archived") }).map(
        (tab) => tab.threadId,
      ),
    ).toEqual(["kept", "archived"]);
  });

  it("scopes tabs to one project for the editor rail", () => {
    const tabs = buildOpenThreadTabs({
      activeThreadId: null,
      projectId: projectB,
      sources: [serverSource("a"), serverSource("b", { projectId: projectB })],
    });

    expect(tabs.map((tab) => tab.threadId)).toEqual(["b"]);
  });
});

describe("resolveOpenThreadTabCloseTarget", () => {
  const tabs = tabIds(["a", "b", "c"]);

  it("stays on the current thread when a background tab closes", () => {
    expect(
      resolveOpenThreadTabCloseTarget({
        tabs,
        closedThreadId: ThreadId.makeUnsafe("a"),
        activeThreadId: ThreadId.makeUnsafe("b"),
      }),
    ).toBeNull();
  });

  it.each([
    ["a middle tab moves right", "b", "c"],
    ["the last tab moves left", "c", "b"],
  ])("closing the active tab: %s", (_label, closed, next) => {
    expect(
      resolveOpenThreadTabCloseTarget({
        tabs,
        closedThreadId: ThreadId.makeUnsafe(closed),
        activeThreadId: ThreadId.makeUnsafe(closed),
      }),
    ).toEqual({ threadId: next });
  });

  it("reports no successor when the only tab closes", () => {
    expect(
      resolveOpenThreadTabCloseTarget({
        tabs: tabIds(["a"]),
        closedThreadId: ThreadId.makeUnsafe("a"),
        activeThreadId: ThreadId.makeUnsafe("a"),
      }),
    ).toEqual({ threadId: null });
  });
});

describe("closeOpenThreadTab", () => {
  // A route that follows successful navigations, unless a guard blocks leaving `blocked`.
  function harness(input: { active: string; blocked?: boolean; freshChatError?: string }) {
    let route: string | null = input.active;
    const closeTab = vi.fn();
    const openTab = vi.fn(async (threadId: string) => {
      if (!input.blocked) route = threadId;
    });
    const openFreshChat = vi.fn(async () => {
      if (input.freshChatError) throw new Error(input.freshChatError);
      route = "fresh";
      return ThreadId.makeUnsafe("fresh");
    });
    const replaceLastTab = replaceLastTabWithFreshChat(openFreshChat);
    const close = (tabs: readonly string[], closed: string) =>
      closeOpenThreadTab({
        tabs: tabIds(tabs),
        closedThreadId: ThreadId.makeUnsafe(closed),
        activeThreadId: ThreadId.makeUnsafe(input.active),
        closeTab,
        openTab,
        replaceLastTab,
        readRouteThreadId: () => route,
      });
    return { close, closeTab, openTab, openFreshChat };
  }

  it("closes a background tab without navigating", async () => {
    const { close, closeTab, openTab } = harness({ active: "b" });

    await expect(close(["a", "b"], "a")).resolves.toEqual({ ok: true });
    expect(closeTab).toHaveBeenCalledWith("a");
    expect(openTab).not.toHaveBeenCalled();
  });

  it("moves to the successor before closing the active tab", async () => {
    const { close, closeTab, openTab } = harness({ active: "b" });

    await close(["a", "b", "c"], "b");
    expect(openTab).toHaveBeenCalledWith("c");
    expect(closeTab).toHaveBeenCalledWith("b");
    expect(openTab.mock.invocationCallOrder[0]).toBeLessThan(closeTab.mock.invocationCallOrder[0]!);
  });

  it("keeps the active tab when navigation is blocked", async () => {
    const { close, closeTab, openTab } = harness({ active: "b", blocked: true });

    await expect(close(["a", "b"], "b")).resolves.toEqual({ ok: true });
    expect(openTab).toHaveBeenCalledWith("a");
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("opens a fresh chat for the last tab, keeping the tab when that fails", async () => {
    const opened = harness({ active: "a" });
    await opened.close(["a"], "a");
    expect(opened.closeTab).toHaveBeenCalledWith("a");

    const failed = harness({ active: "a", freshChatError: "Home folder is not available yet." });
    await expect(failed.close(["a"], "a")).resolves.toEqual({
      ok: false,
      error: "Home folder is not available yet.",
    });
    expect(failed.closeTab).not.toHaveBeenCalled();
  });

  it("keeps the last tab when nothing can take its place", async () => {
    const closeTab = vi.fn();
    await closeOpenThreadTab({
      tabs: tabIds(["a"]),
      closedThreadId: ThreadId.makeUnsafe("a"),
      activeThreadId: ThreadId.makeUnsafe("a"),
      closeTab,
      openTab: vi.fn(),
      readRouteThreadId: () => "a",
    });

    expect(closeTab).not.toHaveBeenCalled();
  });
});

describe("resolveOpenThreadTabsInCloseScope", () => {
  const inScope = (tabs: readonly string[], anchor: string) => ({
    left: resolveOpenThreadTabsInCloseScope(tabIds(tabs), ThreadId.makeUnsafe(anchor), "left"),
    right: resolveOpenThreadTabsInCloseScope(tabIds(tabs), ThreadId.makeUnsafe(anchor), "right"),
    others: resolveOpenThreadTabsInCloseScope(tabIds(tabs), ThreadId.makeUnsafe(anchor), "others"),
  });

  it("splits the neighbours of a middle tab by side and never includes the tab itself", () => {
    expect(inScope(["a", "b", "c", "d"], "b")).toEqual({
      left: ["a"],
      right: ["c", "d"],
      others: ["a", "c", "d"],
    });
  });

  it("has nothing on the outer side of the first and last tab", () => {
    expect(inScope(["a", "b", "c"], "a")).toEqual({
      left: [],
      right: ["b", "c"],
      others: ["b", "c"],
    });
    expect(inScope(["a", "b", "c"], "c")).toEqual({
      left: ["a", "b"],
      right: [],
      others: ["a", "b"],
    });
  });

  it("has nothing to close around a lone tab or a tab that is no longer open", () => {
    expect(inScope(["a"], "a")).toEqual({ left: [], right: [], others: [] });
    expect(inScope(["a", "b"], "gone")).toEqual({ left: [], right: [], others: [] });
  });
});

describe("closeOpenThreadTabs", () => {
  // A route that follows successful navigations, unless a guard blocks leaving it.
  function harness(input: { active: string; blocked?: boolean }) {
    let route: string = input.active;
    const closeTabs = vi.fn();
    const openTab = vi.fn(async (threadId: string) => {
      if (!input.blocked) route = threadId;
    });
    const close = (closed: readonly string[], kept: string) =>
      closeOpenThreadTabs({
        closedThreadIds: closed.map((id) => ThreadId.makeUnsafe(id)),
        keptThreadId: ThreadId.makeUnsafe(kept),
        activeThreadId: ThreadId.makeUnsafe(input.active),
        closeTabs,
        openTab,
        readRouteThreadId: () => route,
      });
    return { close, closeTabs, openTab };
  }

  it("closes background tabs together without navigating", async () => {
    const { close, closeTabs, openTab } = harness({ active: "a" });

    await close(["b", "c"], "a");
    expect(openTab).not.toHaveBeenCalled();
    expect(closeTabs).toHaveBeenCalledExactlyOnceWith(["b", "c"]);
  });

  it("moves to the kept tab before closing the thread on screen", async () => {
    const { close, closeTabs, openTab } = harness({ active: "c" });

    await close(["b", "c"], "a");
    expect(openTab).toHaveBeenCalledExactlyOnceWith("a");
    expect(closeTabs).toHaveBeenCalledExactlyOnceWith(["b", "c"]);
    expect(openTab.mock.invocationCallOrder[0]).toBeLessThan(
      closeTabs.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the tab of a thread the route could not leave", async () => {
    const { close, closeTabs } = harness({ active: "c", blocked: true });

    await close(["b", "c"], "a");
    expect(closeTabs).toHaveBeenCalledExactlyOnceWith(["b"]);
  });
});

describe("createOpenThreadTabCloseQueue", () => {
  it("closes the successor when its X is clicked while the first close is still navigating", async () => {
    // Live app state: the persisted open ids and the route. A thread the route lands on
    // records itself as open again, as the chat surface does.
    const open = ["a", "b", "c"].map((id) => ThreadId.makeUnsafe(id));
    let route: ThreadId = ThreadId.makeUnsafe("a");
    const openTab = async (threadId: ThreadId) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      route = threadId;
      if (!open.includes(threadId)) open.push(threadId);
    };
    const renderedTabs = tabIds(["a", "b", "c"]);
    const enqueueClose = createOpenThreadTabCloseQueue();
    const close = (closed: string) =>
      enqueueClose(() =>
        closeOpenThreadTab({
          tabs: renderedTabs.filter((tab) => open.includes(tab.threadId)),
          closedThreadId: ThreadId.makeUnsafe(closed),
          activeThreadId: route,
          closeTab: (threadId) => open.splice(open.indexOf(threadId), 1),
          openTab,
          readRouteThreadId: () => route,
        }),
      );

    // Both X clicks land before the first navigation settles.
    await Promise.all([close("a"), close("b")]);

    expect(open).toEqual(["c"]);
    expect(route).toBe("c");
  });

  it("falls back from the last tab when an earlier queued close left only one", async () => {
    // The editor rail: two chat tabs, the terminal tab replacing the last one in place.
    const open = ["a", "b"].map((id) => ThreadId.makeUnsafe(id));
    let route: ThreadId = ThreadId.makeUnsafe("a");
    const replaceLastTab = vi.fn(async () => ({ ok: true as const, leavesRoute: false }));
    const enqueueClose = createOpenThreadTabCloseQueue();
    const close = (closed: string) =>
      enqueueClose(() =>
        closeOpenThreadTab({
          tabs: tabIds(["a", "b"]).filter((tab) => open.includes(tab.threadId)),
          closedThreadId: ThreadId.makeUnsafe(closed),
          activeThreadId: route,
          closeTab: (threadId) => open.splice(open.indexOf(threadId), 1),
          openTab: async (threadId) => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            route = threadId;
          },
          replaceLastTab,
          readRouteThreadId: () => route,
        }),
      );

    await Promise.all([close("a"), close("b")]);

    expect(replaceLastTab).toHaveBeenCalledOnce();
    expect(open).toEqual([]);
  });
});
