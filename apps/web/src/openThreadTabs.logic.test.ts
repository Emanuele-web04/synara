import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  addOpenThreadTab,
  buildOpenThreadTabs,
  normalizeOpenThreadTabIds,
  type OpenThreadTabSource,
  resolveOpenThreadTabCloseTarget,
} from "./openThreadTabs.logic";
import type { SidebarThreadSummary } from "./types";

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
