import { assert, describe, it } from "vitest";

import {
  areSidebarSearchThreadListsEqual,
  buildSidebarSearchServerThreadMatches,
  matchSidebarSearchActions,
  matchSidebarSearchProjects,
  matchSidebarSearchThemes,
  matchSidebarSearchThreads,
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
    branch: null,
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
    branch: null,
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
    branch: null,
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

describe("areSidebarSearchThreadListsEqual", () => {
  const thread = (overrides: Partial<SidebarSearchThread> = {}): SidebarSearchThread => ({
    id: "thread-1",
    title: "Title",
    projectId: "project-1",
    projectName: "Project",
    projectRemoteName: "org/project",
    spaceName: "Global",
    provider: "codex",
    branch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: undefined,
    messages: [],
    ...overrides,
  });

  it("treats rebuilt lists with identical fields and message references as equal", () => {
    const messages = [{ text: "hello" }];
    assert.isTrue(areSidebarSearchThreadListsEqual([thread({ messages })], [thread({ messages })]));
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
  });
});
