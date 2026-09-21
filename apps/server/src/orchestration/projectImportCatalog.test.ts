import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProjectId, type ProjectImportProvider } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeImportProject, NativeImportSession } from "../provider/projectImportTypes";
import { buildProjectImportCatalog } from "./projectImportCatalog";
import * as paths from "./projectImportPaths";

const temporaryDirectories: string[] = [];

async function fixtureDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-import-catalog-"));
  temporaryDirectories.push(directory);
  return fs.realpath(directory);
}

function session(id: string, cwd: string, projectId: string | null = null): NativeImportSession {
  return {
    id,
    title: id,
    cwd,
    projectId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    archived: false,
  };
}

function source(
  provider: ProjectImportProvider,
  home: string,
  sessions: ReadonlyArray<NativeImportSession>,
  projects: ReadonlyArray<NativeImportProject> = [],
) {
  return { provider, catalog: { sourceHome: path.join(home, provider), projects, sessions } };
}

function existing(id: string, workspaceRoot: string, title = "My project") {
  return { id: ProjectId.makeUnsafe(id), title, workspaceRoot, kind: "project", deletedAt: null };
}

async function worktreeFixture(home: string) {
  const root = path.join(home, "repository");
  const worktree = path.join(home, "worktree");
  await fs.mkdir(path.join(root, ".git", "worktrees", "test"), { recursive: true });
  await fs.mkdir(worktree);
  await fs.writeFile(
    path.join(worktree, ".git"),
    `gitdir: ${path.join(root, ".git", "worktrees", "test")}\n`,
  );
  return { root, worktree };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("buildProjectImportCatalog", () => {
  it("merges two providers at one physical root and keeps their native identities distinct", async () => {
    const home = await fixtureDirectory();
    const root = path.join(home, "repo");
    const alias = path.join(home, "repo-alias");
    await fs.mkdir(root);
    await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const projects = await buildProjectImportCatalog(
      [
        source(
          "codex",
          home,
          [session("same-id", root, "codex-project")],
          [{ id: "codex-project", title: "Native name", roots: [root] }],
        ),
        source(
          "claudeAgent",
          home,
          [session("same-id", alias, alias)],
          [{ id: alias, title: "Alias", roots: [alias] }],
        ),
      ],
      [existing("existing", alias, "Keep my Synara title")],
    );

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      title: "Keep my Synara title",
      workspaceRoot: root,
      directoryExists: true,
      existingProjectId: "existing",
      providers: ["claudeAgent", "codex"],
    });
    expect(projects[0]?.key).toBe(
      paths.projectImportKey("project", paths.importPathIdentity(root)),
    );
    expect(projects[0]?.threads.map((thread) => thread.cwd).toSorted()).toEqual(
      [root, alias].toSorted(),
    );
    expect(new Set(projects[0]?.threads.map((thread) => thread.key)).size).toBe(2);
  });

  it("keeps equal project names in different folders separate and includes empty projects", async () => {
    const home = await fixtureDirectory();
    const first = path.join(home, "first");
    const second = path.join(home, "second");
    const projects = await buildProjectImportCatalog(
      [
        source(
          "codex",
          home,
          [session("first-chat", first, "first")],
          [
            { id: "first", title: "Same name", roots: [first] },
            { id: "second", title: "Same name", roots: [second] },
          ],
        ),
      ],
      [],
    );
    expect(projects).toHaveLength(2);
    expect(projects.every((project) => !project.directoryExists)).toBe(true);
    expect(projects.find((project) => project.workspaceRoot === second)?.threads).toEqual([]);
    expect(new Set(projects.map((project) => project.key)).size).toBe(2);
  });

  it("keeps a deleted worktree's explicit single-root project assignment", async () => {
    const home = await fixtureDirectory();
    const root = path.join(home, "repo");
    const deletedWorktree = path.join(home, "deleted-worktree");
    const projects = await buildProjectImportCatalog(
      [
        source(
          "codex",
          home,
          [session("old-chat", deletedWorktree, "project")],
          [{ id: "project", title: "Project", roots: [root] }],
        ),
      ],
      [],
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]?.workspaceRoot).toBe(root);
    expect(projects[0]?.threads[0]?.cwd).toBe(deletedWorktree);
  });

  it("matches multi-root members through cwd and worktree origin, leaving unmatched members separate", async () => {
    const home = await fixtureDirectory();
    const { root, worktree } = await worktreeFixture(home);
    const backend = path.join(root, "backend");
    const frontend = path.join(root, "frontend");
    const unknown = path.join(home, "deleted-unmapped-worktree");
    await fs.mkdir(path.join(worktree, "backend", "src"), { recursive: true });
    const projects = await buildProjectImportCatalog(
      [
        source(
          "codex",
          home,
          [
            session("backend-chat", path.join(worktree, "backend", "src"), "multi"),
            session("frontend-chat", path.join(frontend, "src"), "multi"),
            session("unmatched-chat", unknown, "multi"),
          ],
          [{ id: "multi", title: "Multi-root", roots: [frontend, backend] }],
        ),
      ],
      [],
    );
    expect(projects).toHaveLength(3);
    expect(
      projects
        .find((project) => project.workspaceRoot === backend)
        ?.threads.map((thread) => thread.id),
    ).toEqual(["backend-chat"]);
    expect(
      projects
        .find((project) => project.workspaceRoot === frontend)
        ?.threads.map((thread) => thread.id),
    ).toEqual(["frontend-chat"]);
    expect(
      projects
        .find((project) => project.workspaceRoot === unknown)
        ?.threads.map((thread) => thread.id),
    ).toEqual(["unmatched-chat"]);
  });

  it("chooses the most specific assigned root when a multi-root project has nested roots", async () => {
    const home = await fixtureDirectory();
    const root = path.join(home, "repo");
    const subproject = path.join(root, "packages", "app");
    const projects = await buildProjectImportCatalog(
      [
        source(
          "codex",
          home,
          [session("nested", path.join(subproject, "src"), "multi")],
          [{ id: "multi", title: "Project", roots: [root, subproject] }],
        ),
      ],
      [],
    );
    expect(projects.find((project) => project.workspaceRoot === subproject)?.threads[0]?.id).toBe(
      "nested",
    );
    expect(projects.find((project) => project.workspaceRoot === root)?.threads).toEqual([]);
  });

  it("groups Claude cwd hints and unassigned worktree threads under the main checkout", async () => {
    const home = await fixtureDirectory();
    const { root, worktree } = await worktreeFixture(home);
    const cwd = path.join(worktree, "src");
    await fs.mkdir(cwd);
    const projects = await buildProjectImportCatalog(
      [
        source(
          "claudeAgent",
          home,
          [session("claude-chat", cwd, cwd)],
          [{ id: cwd, title: "src", roots: [cwd] }],
        ),
        source("codex", home, [session("codex-chat", worktree)]),
      ],
      [existing("main", root)],
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      workspaceRoot: root,
      existingProjectId: "main",
      title: "My project",
    });
    expect(projects[0]?.threads).toHaveLength(2);
    expect(projects[0]?.threads.some((thread) => thread.cwd === cwd)).toBe(true);
  });

  it("prefers a saved monorepo subproject, including its worktree equivalent, over the Git root", async () => {
    const home = await fixtureDirectory();
    const { root, worktree } = await worktreeFixture(home);
    const subproject = path.join(root, "apps", "api");
    const localCwd = path.join(subproject, "src");
    const worktreeCwd = path.join(worktree, "apps", "api", "src");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(worktreeCwd, { recursive: true });
    const projects = await buildProjectImportCatalog(
      [source("claudeAgent", home, [session("local", localCwd), session("worktree", worktreeCwd)])],
      [existing("repo", root, "Whole repository"), existing("api", subproject, "API project")],
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      workspaceRoot: subproject,
      title: "API project",
      existingProjectId: "api",
    });
    expect(projects[0]?.threads).toHaveLength(2);
  });

  it("ignores broader, deleted and non-project Synara containers when deriving a Git workspace", async () => {
    const home = await fixtureDirectory();
    const { root } = await worktreeFixture(home);
    const cwd = path.join(root, "src");
    await fs.mkdir(cwd);
    const projects = await buildProjectImportCatalog(
      [
        source(
          "claudeAgent",
          home,
          [session("chat", cwd, cwd)],
          [{ id: cwd, title: "src", roots: [cwd] }],
        ),
      ],
      [
        existing("parent", home),
        { ...existing("deleted", root), deletedAt: "2026-01-01T00:00:00.000Z" },
        { ...existing("chat", root), kind: "chat" },
      ],
    );
    expect(projects[0]).toMatchObject({
      workspaceRoot: root,
      existingProjectId: null,
      title: "repository",
    });
  });

  it("keeps explicit Codex root assignments authoritative over existing subproject inference", async () => {
    const home = await fixtureDirectory();
    const root = path.join(home, "repo");
    const subproject = path.join(root, "app");
    const projects = await buildProjectImportCatalog(
      [
        source(
          "codex",
          home,
          [session("chat", subproject, "native")],
          [{ id: "native", title: "Native root", roots: [root] }],
        ),
      ],
      [existing("app", subproject)],
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ workspaceRoot: root, existingProjectId: null });
  });

  it("uses explicit Codex subproject roots to group Claude chats before Synara has that project", async () => {
    const home = await fixtureDirectory();
    const { root, worktree } = await worktreeFixture(home);
    const subproject = path.join(root, "apps", "api");
    const worktreeCwd = path.join(worktree, "apps", "api", "src");
    await fs.mkdir(subproject, { recursive: true });
    await fs.mkdir(worktreeCwd, { recursive: true });
    // provider order must not turn the declared subproject into a whole-repository project
    const projects = await buildProjectImportCatalog(
      [
        source("claudeAgent", home, [
          session("claude-local", subproject, subproject),
          session("claude-worktree", worktreeCwd),
        ]),
        source(
          "codex",
          home,
          [session("codex", subproject, "api")],
          [{ id: "api", title: "Backend API", roots: [subproject] }],
        ),
      ],
      [],
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      workspaceRoot: subproject,
      title: "Backend API",
      existingProjectId: null,
    });
    expect(projects[0]?.threads).toHaveLength(3);
  });

  it("skips invalid paths without resolving them into the process directory", async () => {
    const home = await fixtureDirectory();
    expect(
      await buildProjectImportCatalog(
        [
          source(
            "codex",
            home,
            [
              session("empty", ""),
              session("relative", "relative/path"),
              session("nul", "/bad\0path"),
            ],
            [{ id: "bad", title: "Bad", roots: ["", "relative"] }],
          ),
        ],
        [],
      ),
    ).toEqual([]);
  });

  it("deduplicates native origins and caches repeated filesystem lookups within one scan", async () => {
    const home = await fixtureDirectory();
    const root = path.join(home, "repo");
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    const gitLookup = vi.spyOn(paths, "findImportGitWorkspace");
    const directoryLookup = vi.spyOn(paths, "importDirectoryExists");
    const canonicalLookup = vi.spyOn(paths, "canonicalImportPath");
    const chats = Array.from({ length: 300 }, (_, index) => session(`chat-${index}`, root));
    const nativeSource = source("codex", home, [...chats, chats[0]!]);
    const projects = await buildProjectImportCatalog([nativeSource, nativeSource], []);
    expect(projects[0]?.threads).toHaveLength(300);
    expect(gitLookup).toHaveBeenCalledTimes(1);
    expect(directoryLookup).toHaveBeenCalledTimes(1);
    expect(canonicalLookup.mock.calls.filter(([value]) => value === root)).toHaveLength(1);
    expect(projects[0]?.threads[0]?.key).toBe(
      paths.projectImportKey("codex", path.join(home, "codex"), projects[0]!.threads[0]!.id),
    );
  });
});
