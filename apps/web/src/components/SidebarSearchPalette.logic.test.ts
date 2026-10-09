import { assert, describe, it } from "vitest";
import { ProjectId, ThreadId } from "@synara/contracts";
import type { WorkspaceSession } from "../lib/hosts/workspaceSessions";

import {
  areSidebarSearchThreadListsEqual,
  buildSidebarSearchServerThreadMatches,
  matchSidebarSearchActions,
  matchSidebarSearchProjects,
  matchSidebarSearchThemes,
  matchSidebarSearchThreads,
  workspaceSidebarSearch,
  type SidebarSearchAction,
  type SidebarSearchProject,
  type SidebarSearchTheme,
  type SidebarSearchThread,
} from "./SidebarSearchPalette.logic";

const actions: SidebarSearchAction[] = [
  {
    id: "new-thread",
    label: "New thread",
    description: "Start a fresh chat",
    keywords: ["chat", "new"],
  },
  {
    id: "plugins",
    label: "Plugins",
    description: "Browse installed plugins",
    keywords: ["extensions"],
  },
  {
    id: "feedback",
    label: "Feedback Synara",
    description: "Send feedback or report an issue to the Synara team.",
    keywords: ["feedback", "bug", "issue", "report", "support"],
  },
  {
    id: "usage-settings",
    label: "Usage settings",
    description: "Open provider usage and remaining credits.",
    keywords: ["usage", "limits", "credits", "quota", "providers"],
    shortcutLabel: "⇧⌘U",
  },
];

const projects: SidebarSearchProject[] = [
  {
    id: "project-alpha",
    name: "Alpha Repo",
    remoteName: "Alpha Repo",
    folderName: "alpha-repo",
    localName: null,
    cwd: "/repos/alpha-repo",
    spaceName: "Work",
    updatedAt: "2026-04-09T10:00:00.000Z",
  },
  {
    id: "project-beta",
    name: "Docs",
    remoteName: "Beta Repo",
    folderName: "beta-repo",
    localName: "Docs",
    cwd: "/repos/beta-repo",
    spaceName: "Void",
    updatedAt: "2026-04-09T11:00:00.000Z",
  },
];

const themes: SidebarSearchTheme[] = [
  {
    id: "theme-mode-system",
    type: "mode",
    label: "System",
    description: "Match your OS appearance setting.",
    keywords: ["appearance", "theme", "mode", "os"],
    mode: "system",
    isActive: true,
  },
  {
    id: "theme-mode-dark",
    type: "mode",
    label: "Dark",
    description: "Always use the dark theme.",
    keywords: ["appearance", "theme", "mode", "night"],
    mode: "dark",
    isActive: false,
  },
  {
    id: "theme-codex-dark",
    type: "code-theme",
    label: "Codex",
    description: "Apply to the current dark theme slot.",
    keywords: ["appearance", "theme", "dark"],
    codeThemeId: "codex",
    variant: "dark",
    isActive: true,
  },
  {
    id: "theme-linear-dark",
    type: "code-theme",
    label: "Linear",
    description: "Apply to the current dark theme slot.",
    keywords: ["appearance", "theme", "dark"],
    codeThemeId: "linear",
    variant: "dark",
    isActive: false,
  },
];

const threads: SidebarSearchThread[] = [
  {
    id: "thread-alpha-composer",
    title: "Composer refactor",
    projectId: "project-alpha",
    projectName: "Alpha Repo",
    projectRemoteName: "Alpha Repo",
    spaceName: "Work",
    provider: "claudeAgent",
    createdAt: "2026-04-09T09:00:00.000Z",
    updatedAt: "2026-04-09T11:30:00.000Z",
    messages: [
      {
        text: "Need to clean up the composer shell and remove duplicated state.",
      },
    ],
  },
  {
    id: "thread-alpha-compose-prompt",
    title: "composePrompt follow-up",
    projectId: "project-alpha",
    projectName: "Alpha Repo",
    projectRemoteName: "Alpha Repo",
    spaceName: "Work",
    provider: "codex",
    createdAt: "2026-04-09T08:00:00.000Z",
    updatedAt: "2026-04-09T10:30:00.000Z",
    messages: [
      {
        text: "composePrompt still leaks prompt state after retries.",
      },
      {
        text: "Let's make composePrompt smaller before we move it.",
      },
    ],
  },
  {
    id: "thread-beta-settings",
    title: "Settings cleanup",
    projectId: "project-beta",
    projectName: "Docs",
    projectRemoteName: "Beta Repo",
    spaceName: "Void",
    provider: "claudeAgent",
    createdAt: "2026-04-09T07:00:00.000Z",
    updatedAt: "2026-04-09T09:00:00.000Z",
    messages: [
      {
        text: "Settings page should expose desktop notification toggles.",
      },
    ],
  },
];

describe("SidebarSearchPalette.logic", () => {
  it("keeps suggested actions in source order for an empty query", () => {
    const result = matchSidebarSearchActions(actions, "");

    assert.deepEqual(
      result.map((action) => action.id),
      ["new-thread", "plugins", "feedback", "usage-settings"],
    );
  });

  it("hides requiresQuery actions from the empty palette but matches them once typed", () => {
    const withSpaceJump: SidebarSearchAction[] = [
      ...actions,
      {
        id: "switch-space-work",
        label: "Switch to Work",
        description: "Jump to this space.",
        keywords: ["space", "switch", "Work"],
        requiresQuery: true,
      },
    ];

    const emptyQuery = matchSidebarSearchActions(withSpaceJump, "");
    assert.equal(
      emptyQuery.some((action) => action.id === "switch-space-work"),
      false,
    );

    const typed = matchSidebarSearchActions(withSpaceJump, "work");
    assert.equal(typed[0]?.id, "switch-space-work");
  });

  it("matches command words across labels and keywords without admitting partial queries", () => {
    const commands: SidebarSearchAction[] = [
      { id: "go-inbox", label: "Go to Inbox", description: "Open Inbox.", keywords: ["navigate"] },
      { id: "go-kanban", label: "Go to Kanban", description: "Open Kanban.", keywords: ["board"] },
      {
        id: "new-automation",
        label: "New automation",
        description: "Schedule a recurring task.",
        keywords: ["create"],
      },
    ];
    assert.deepEqual(
      matchSidebarSearchActions(commands, "go inbox").map((action) => action.id),
      ["go-inbox"],
    );
    assert.deepEqual(
      matchSidebarSearchActions(commands, "kanban board").map((action) => action.id),
      ["go-kanban"],
    );
    assert.deepEqual(
      matchSidebarSearchActions(commands, "create automation").map((action) => action.id),
      ["new-automation"],
    );
    assert.deepEqual(matchSidebarSearchActions(commands, "go missing"), []);
  });

  it("matches themes by query relevance", () => {
    const result = matchSidebarSearchThemes(themes, "dark");

    assert.deepEqual(
      result.map((theme) => theme.id),
      ["theme-mode-dark", "theme-codex-dark", "theme-linear-dark"],
    );
  });

  it("matches projects by repo name before cwd fragments", () => {
    const result = matchSidebarSearchProjects(projects, "alpha");

    assert.lengthOf(result, 1);
    assert.equal(result[0]?.project.id, "project-alpha");
  });

  it("matches projects by original name when a local name override exists", () => {
    const result = matchSidebarSearchProjects(projects, "beta");

    assert.lengthOf(result, 1);
    assert.equal(result[0]?.project.id, "project-beta");
  });

  it("matches projects and threads through their space label", () => {
    assert.deepEqual(
      matchSidebarSearchProjects(projects, "work").map((match) => match.project.id),
      ["project-alpha"],
    );
    assert.deepEqual(
      matchSidebarSearchThreads(threads, "void").map((match) => match.thread.id),
      ["thread-beta-settings"],
    );
  });

  it("qualifies matching and recent result identities when computers share IDs", () => {
    const host = { environmentId: "mini", name: "Mac mini" };
    const localProject = projects[0]!;
    const localThread = threads[0]!;
    const projectMatches = matchSidebarSearchProjects(
      [localProject, { ...localProject, host }],
      "alpha",
    );
    assert.equal(new Set(projectMatches.map((match) => match.id)).size, 2);
    for (const query of ["", "composer"]) {
      const matches = matchSidebarSearchThreads([localThread, { ...localThread, host }], query);
      assert.equal(new Set(matches.map((match) => match.id)).size, 2);
    }
  });

  it("prefers thread title matches and then recency", () => {
    const result = matchSidebarSearchThreads(threads, "comp");

    assert.deepEqual(
      result.map((match) => match.thread.id),
      ["thread-alpha-composer", "thread-alpha-compose-prompt"],
    );
  });

  it("can match threads through the project name", () => {
    const result = matchSidebarSearchThreads(threads, "docs");

    assert.deepEqual(
      result.map((match) => match.thread.id),
      ["thread-beta-settings"],
    );
    assert.equal(result[0]?.matchKind, "project");
  });

  it("can match threads through the original project name", () => {
    const result = matchSidebarSearchThreads(threads, "beta");

    assert.deepEqual(
      result.map((match) => match.thread.id),
      ["thread-beta-settings"],
    );
    assert.equal(result[0]?.matchKind, "project");
  });

  it("can match message content and returns a snippet", () => {
    const result = matchSidebarSearchThreads(threads, "desktop notification");

    assert.lengthOf(result, 1);
    assert.equal(result[0]?.thread.id, "thread-beta-settings");
    assert.equal(result[0]?.matchKind, "message");
    assert.equal(result[0]?.messageMatchCount, 1);
    assert.include(result[0]?.snippet ?? "", "desktop notification toggles");
  });

  it("counts multiple message hits in the same thread", () => {
    const result = matchSidebarSearchThreads(threads, "composeprompt");

    assert.equal(result[0]?.thread.id, "thread-alpha-compose-prompt");
    assert.equal(result[0]?.matchKind, "title");
    assert.equal(result[0]?.messageMatchCount, 2);
  });

  it("uses server hits for threads whose messages are not loaded", () => {
    const unloaded = threads.map((thread) => ({ ...thread, messages: [] }));
    const serverMatches = new Map([
      [
        "thread-beta-settings",
        { excerpt: "Settings page should expose desktop notification toggles.", matchCount: 3 },
      ],
    ]);

    assert.deepEqual(matchSidebarSearchThreads(unloaded, "desktop notification"), []);
    const result = matchSidebarSearchThreads(unloaded, "desktop notification", 8, serverMatches);

    assert.equal(result[0]?.thread.id, "thread-beta-settings");
    assert.equal(result[0]?.matchKind, "message");
    assert.equal(result[0]?.messageMatchCount, 3);
    assert.include(result[0]?.snippet ?? "", "desktop notification toggles");
  });

  it("does not apply local server hits to a remote chat with the same id", () => {
    const local = { ...threads[0]!, messages: [] };
    const remote = { ...local, host: { environmentId: "other-mac", name: "Other Mac" } };
    const matches = new Map([[local.id, { excerpt: "unique persisted phrase", matchCount: 1 }]]);
    const results = matchSidebarSearchThreads(
      [local, remote],
      "unique persisted phrase",
      8,
      matches,
    );
    assert.lengthOf(results, 1);
    assert.isUndefined(results[0]?.thread.host);
  });

  it("keeps a server hit whose excerpt misses some query tokens", () => {
    const unloaded = threads.map((thread) => ({ ...thread, messages: [] }));
    const serverMatches = new Map([
      ["thread-beta-settings", { excerpt: "...expose desktop toggles", matchCount: 1 }],
    ]);

    const result = matchSidebarSearchThreads(unloaded, "desktop rollout", 8, serverMatches);

    assert.equal(result[0]?.thread.id, "thread-beta-settings");
    assert.equal(result[0]?.matchKind, "message");
  });
});

describe("buildSidebarSearchServerThreadMatches", () => {
  const result = {
    query: "desk",
    matches: [
      { threadId: "thread-a", excerpt: "desktop notifications", matchCount: 1 },
      { threadId: "thread-b", excerpt: "standing desk", matchCount: 2 },
    ],
  };

  it("keeps every hit for the current query", () => {
    assert.deepEqual(
      [...buildSidebarSearchServerThreadMatches(result, " Desk ").keys()],
      ["thread-a", "thread-b"],
    );
  });

  it("keeps only hits whose excerpt matches a newer query", () => {
    assert.deepEqual(
      [...buildSidebarSearchServerThreadMatches(result, "desktop").keys()],
      ["thread-a"],
    );
  });

  it("returns an empty map without a response", () => {
    assert.equal(buildSidebarSearchServerThreadMatches(undefined, "desk").size, 0);
  });
});

describe("workspaceSidebarSearch", () => {
  const remoteThread = {
    id: ThreadId.makeUnsafe("remote-thread"),
    projectId: ProjectId.makeUnsafe("remote-project"),
    title: "Fix login flow",
    modelSelection: { provider: "codex" as const, model: "fixture" },
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-09-28T00:00:00Z",
    latestUserMessageAt: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    status: null,
  };
  const session: WorkspaceSession = {
    host: {
      hostId: "host-mini",
      hostName: "Mac mini",
      wsPath: "/ws/remote/mini",
      executionScope: {
        environmentId: "mini",
        accountAuthority: "https://account.example",
        userId: "alice",
        organizationId: "org",
        channel: "beta",
      },
    },
    summary: {
      state: "open",
      path: "/",
      projects: [
        {
          id: remoteThread.projectId,
          kind: "project",
          section: "projects",
          name: "Dashboard",
          cwd: "/work/dashboard",
          createdAt: remoteThread.createdAt,
        },
      ],
      threads: [remoteThread],
    },
    navigation: {
      navigate() {},
      newChat: async () => "",
      createChat: async () => {},
      openTerminal() {},
      browseFolders: async () => ({ parentPath: "/", entries: [] }),
      createProject: async () => "",
      openProject: async () => "",
      recover() {},
    },
  };

  it.each([
    ["ready", session, false],
    [
      "closed transport",
      { ...session, summary: { ...session.summary!, state: "closed" as const } },
      true,
    ],
    ["no navigation", { ...session, navigation: undefined }, true],
    ["failed", { ...session, error: "Disconnected" }, true],
  ] as const)(
    "keeps %s metadata searchable with its current availability",
    (_label, current, unavailable) => {
      const result = workspaceSidebarSearch([current]);
      const foundThread = matchSidebarSearchThreads(result.threads, "mac mini")[0];
      const foundProject = matchSidebarSearchProjects(result.projects, "mac mini")[0];
      assert.equal(foundThread?.thread.id, remoteThread.id);
      assert.equal(foundProject?.project.id, remoteThread.projectId);
      assert.equal(foundThread?.thread.host?.unavailable, unavailable);
      assert.equal(foundProject?.project.host?.unavailable, unavailable);
      assert.deepEqual(foundThread?.thread.messages, []);
    },
  );

  it("applies the same flat search visibility as local threads", () => {
    const result = workspaceSidebarSearch([
      {
        ...session,
        summary: {
          ...session.summary!,
          threads: [
            remoteThread,
            {
              ...remoteThread,
              id: ThreadId.makeUnsafe("archived"),
              archivedAt: remoteThread.createdAt,
            },
            {
              ...remoteThread,
              id: ThreadId.makeUnsafe("subagent"),
              parentThreadId: remoteThread.id,
            },
            {
              ...remoteThread,
              id: ThreadId.makeUnsafe("sidechat"),
              sidechatSourceThreadId: remoteThread.id,
            },
          ],
        },
      },
    ]);
    assert.deepEqual(
      result.threads.map((thread) => thread.id),
      [remoteThread.id],
    );
  });
});

describe("areSidebarSearchThreadListsEqual", () => {
  const thread = (overrides: Partial<SidebarSearchThread> = {}): SidebarSearchThread => ({
    id: "thread-1",
    title: "Title",
    projectId: "project-1",
    projectName: "Project",
    projectRemoteName: "org/project",
    spaceName: "Global",
    provider: "codex",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: undefined,
    messages: [],
    ...overrides,
  });

  it("treats rebuilt lists with identical fields and message references as equal", () => {
    const messages = [{ text: "hello" }];
    const host = { environmentId: "mini", name: "Mac mini", unavailable: false };
    assert.isTrue(
      areSidebarSearchThreadListsEqual(
        [thread({ messages, host })],
        [thread({ messages, host: { ...host } })],
      ),
    );
  });

  it("detects a changed field, a changed message array, or a different length", () => {
    const messages = [{ text: "hello" }];
    assert.isFalse(
      areSidebarSearchThreadListsEqual(
        [thread({ messages })],
        [thread({ messages, title: "Renamed" })],
      ),
    );
    assert.isFalse(
      areSidebarSearchThreadListsEqual(
        [thread({ messages })],
        [thread({ messages: [{ text: "hello" }] })],
      ),
    );
    assert.isFalse(areSidebarSearchThreadListsEqual([thread()], [thread(), thread()]));
    const host = { environmentId: "mini", name: "Mac mini", unavailable: false };
    for (const changedHost of [
      { ...host, environmentId: "other" },
      { ...host, name: "Renamed computer" },
      { ...host, unavailable: true },
    ]) {
      assert.isFalse(
        areSidebarSearchThreadListsEqual(
          [thread({ messages, host })],
          [thread({ messages, host: changedHost })],
        ),
      );
    }
  });
});
