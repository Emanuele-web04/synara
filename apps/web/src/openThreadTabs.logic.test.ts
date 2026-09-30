import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  addOpenThreadTab,
  buildOpenThreadTabs,
  closeOpenThreadTab,
  createOpenThreadTabCloseQueue,
  replaceLastTabWithFreshChat,
  normalizeOpenThreadTabIds,
  type OpenThreadTabSource,
  resolveOpenThreadTabCloseTarget,
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
    draft: undefined,
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

  it("restores a persisted list without duplicates or malformed entries", () => {
    expect(normalizeOpenThreadTabIds(["a", " b ", "a", "", 3, null, "c"])).toEqual(["a", "b", "c"]);
    expect(normalizeOpenThreadTabIds({ threadIds: ["a"] })).toEqual([]);
  });
});

describe("buildOpenThreadTabs", () => {
  it("labels server threads by title and provider, drafts by placeholder", () => {
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
        {
          threadId: ThreadId.makeUnsafe("draft"),
          summary: undefined,
          draft: { projectId: projectA, entryPoint: "terminal", provider: "grok" },
          terminalEntryPoint: false,
        },
      ],
    });

    expect(tabs).toEqual([
      expect.objectContaining({ title: "Refactor rows", provider: "claudeAgent", isDraft: false }),
      expect.objectContaining({ threadId: "handed-off", provider: "cursor" }),
      expect.objectContaining({ threadId: "shell", isTerminal: true }),
      expect.objectContaining({
        title: "New terminal",
        provider: "grok",
        isTerminal: true,
        isDraft: true,
      }),
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
      if (input.freshChatError) return { ok: false as const, error: input.freshChatError };
      route = "fresh";
      return { ok: true as const, threadId: ThreadId.makeUnsafe("fresh") };
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
      enqueueClose(() => ({
        tabs: renderedTabs.filter((tab) => open.includes(tab.threadId)),
        closedThreadId: ThreadId.makeUnsafe(closed),
        activeThreadId: route,
        closeTab: (threadId) => open.splice(open.indexOf(threadId), 1),
        openTab,
        readRouteThreadId: () => route,
      }));

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
      enqueueClose(() => ({
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
      }));

    await Promise.all([close("a"), close("b")]);

    expect(replaceLastTab).toHaveBeenCalledOnce();
    expect(open).toEqual([]);
  });
});
