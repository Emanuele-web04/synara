import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { discoverCodexProjects, resolveCodexProjectImportHome } from "./codexProjectImport";

const homes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "synara-codex-project-import-"));
  homes.push(home);
  return home;
}

function createDatabase(home: string, version = 5): DatabaseSync {
  const database = new DatabaseSync(path.join(home, `state_${version}.sqlite`));
  database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, cwd TEXT, source TEXT, created_at INTEGER, updated_at INTEGER,
      created_at_ms INTEGER, updated_at_ms INTEGER, name TEXT, title TEXT, project_id TEXT,
      archived INTEGER DEFAULT 0, thread_source TEXT
    );
    CREATE TABLE thread_spawn_edges (child_thread_id TEXT PRIMARY KEY);
  `);
  return database;
}

function addThread(
  database: DatabaseSync,
  input: {
    id: string;
    cwd?: string;
    source?: string;
    projectId?: string;
    threadSource?: string;
    archived?: boolean;
  },
) {
  database
    .prepare(`INSERT INTO threads
    (id, cwd, source, created_at, updated_at, title, project_id, thread_source, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.cwd ?? "/missing/repository",
      input.source ?? "vscode",
      1_700_000_000,
      1_700_000_100,
      `Thread ${input.id}`,
      input.projectId ?? null,
      input.threadSource ?? null,
      input.archived ? 1 : 0,
    );
}

async function desktopState(home: string, state: unknown) {
  await fs.writeFile(path.join(home, ".codex-global-state.json"), JSON.stringify(state));
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("discoverCodexProjects", () => {
  it("reads current project roots, archived history and original dates without requiring directories", async () => {
    const home = await temporaryHome();
    const database = createDatabase(home);
    database.exec(`
      INSERT INTO projects VALUES ('multi', 'Two roots'), ('empty', 'Empty project');
      INSERT INTO project_roots VALUES ('multi', 1, '/repo/backend'), ('multi', 0, '/repo/frontend'),
        ('empty', 0, '/missing/empty');
    `);
    addThread(database, { id: "chat", projectId: "multi", archived: true });
    database.exec(
      "UPDATE threads SET name = 'Custom title', created_at_ms = 1700000000123, updated_at_ms = 1700000100456",
    );
    database.close();

    const result = await discoverCodexProjects({ homePath: home, env: {} });
    expect(result.projects).toEqual([
      { id: "multi", title: "Two roots", roots: ["/repo/frontend", "/repo/backend"] },
      { id: "empty", title: "Empty project", roots: ["/missing/empty"] },
    ]);
    expect(result.sessions).toEqual([
      {
        id: "chat",
        title: "Custom title",
        cwd: "/missing/repository",
        projectId: "multi",
        createdAt: "2023-11-14T22:13:20.123Z",
        updatedAt: "2023-11-14T22:15:00.456Z",
        archived: true,
      },
    ]);
  });

  it("recovers partial desktop migration assignments while keeping canonical assignments authoritative", async () => {
    const home = await temporaryHome();
    const database = createDatabase(home);
    database.exec(
      "INSERT INTO projects VALUES ('modern', 'Project'), ('other', 'Other'); INSERT INTO project_roots VALUES ('modern', 0, '/repo'), ('other', 0, '/other')",
    );
    addThread(database, { id: "legacy", cwd: "/deleted/worktree" });
    addThread(database, { id: "current", projectId: "other" });
    addThread(database, { id: "projectless" });
    addThread(database, { id: "remote" });
    database.close();
    await desktopState(home, {
      "local-projects": { old: { id: "old", name: "Previous name", rootPaths: ["/repo"] } },
      "app-server-project-id-by-legacy-project-id-by-host": {
        [`local:${home}`]: { old: "modern" },
      },
      "thread-project-assignments": {
        legacy: { projectKind: "local", projectId: "old" },
        current: { projectKind: "local", projectId: "old" },
        projectless: { projectKind: "local", projectId: "old" },
        remote: { projectKind: "remote", projectId: "old" },
      },
      "projectless-thread-ids": ["projectless"],
    });

    const result = await discoverCodexProjects({ homePath: home, env: {} });
    expect(result.projects.map((project) => project.id)).toEqual(["modern", "other"]);
    expect(result.sessions.map((session) => [session.id, session.projectId])).toEqual([
      ["legacy", "modern"],
      ["current", "other"],
      ["projectless", null],
      ["remote", null],
    ]);
    expect(result.sessions[0]?.cwd).toBe("/deleted/worktree");
  });

  it("supports older thread schemas and legacy-only empty projects", async () => {
    const home = await temporaryHome();
    const database = new DatabaseSync(path.join(home, "state_4.sqlite"));
    database.exec(
      "CREATE TABLE threads (id TEXT, cwd TEXT, source TEXT, created_at INTEGER, updated_at INTEGER, title TEXT); INSERT INTO threads VALUES ('old-chat', '/repo', 'cli', 1700000000, 1700000100, 'Old chat')",
    );
    database.close();
    await desktopState(home, {
      "local-projects": {
        old: { id: "old", name: "Legacy", rootPaths: ["/repo"] },
        empty: { name: "Empty", rootPaths: ["/empty"] },
      },
      "thread-project-assignments": { "old-chat": { projectKind: "local", projectId: "old" } },
    });
    const result = await discoverCodexProjects({ homePath: home, env: {} });
    expect(result.projects.map((project) => project.id)).toEqual(["old", "empty"]);
    expect(result.sessions[0]).toMatchObject({
      id: "old-chat",
      projectId: "old",
      archived: false,
      createdAt: "2023-11-14T22:13:20.000Z",
    });
  });

  it("excludes spawned and guardian internals while retaining user-created and automation chats", async () => {
    const home = await temporaryHome();
    const database = createDatabase(home);
    addThread(database, { id: "root", threadSource: "user" });
    addThread(database, { id: "created", threadSource: "agent_created_thread" });
    addThread(database, { id: "automation", threadSource: "automation" });
    addThread(database, {
      id: "guardian",
      source: JSON.stringify({ subagent: { other: "guardian" } }),
    });
    addThread(database, {
      id: "child",
      source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "root" } } }),
    });
    addThread(database, { id: "classified", threadSource: "subagent" });
    addThread(database, { id: "guardian-classified", threadSource: "guardian_review" });
    addThread(database, { id: "edge-only" });
    addThread(database, { id: "enum-source", source: "subAgentThreadSpawn" });
    database.exec("INSERT INTO thread_spawn_edges VALUES ('edge-only')");
    database.close();
    expect(
      (await discoverCodexProjects({ homePath: home, env: {} })).sessions.map(
        (session) => session.id,
      ),
    ).toEqual(["root", "created", "automation"]);
  });

  it("honors CODEX_SQLITE_HOME and resolves a shared desktop-state overlay to one source identity", async () => {
    const home = await temporaryHome();
    const overlay = await temporaryHome();
    const sqliteHome = await temporaryHome();
    const database = createDatabase(sqliteHome);
    addThread(database, { id: "external-db" });
    database.close();
    await desktopState(home, {
      "local-projects": { project: { name: "Project", rootPaths: ["/repo"] } },
    });
    await fs.symlink(
      path.join(home, ".codex-global-state.json"),
      path.join(overlay, ".codex-global-state.json"),
    );

    const result = await discoverCodexProjects({
      env: { CODEX_HOME: overlay, CODEX_SQLITE_HOME: sqliteHome },
    });
    expect(result.sourceHome).toBe(await fs.realpath(home));
    expect(await resolveCodexProjectImportHome({ homePath: overlay, env: {} })).toBe(
      result.sourceHome,
    );
    expect(result.projects[0]?.id).toBe("project");
    expect(result.sessions[0]?.id).toBe("external-db");
  });

  it("resolves home aliases without reading or creating a state database", async () => {
    const home = await temporaryHome();
    const parent = await temporaryHome();
    const alias = path.join(parent, "alias");
    await fs.symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await resolveCodexProjectImportHome({ homePath: alias, env: {} })).toBe(
      await fs.realpath(home),
    );
    const missingHome = path.join(parent, "missing");
    expect(await resolveCodexProjectImportHome({ homePath: missingHome, env: {} })).toBe(
      missingHome,
    );
    expect(await fs.readdir(home)).toEqual([]);
    await expect(fs.stat(missingHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads pending WAL metadata without writing the source database or WAL", async () => {
    const home = await temporaryHome();
    const database = createDatabase(home);
    try {
      database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      addThread(database, { id: "in-wal" });
      const databaseFile = path.join(home, "state_5.sqlite");
      const beforeDatabase = await fs.readFile(databaseFile);
      const beforeWal = await fs.readFile(`${databaseFile}-wal`);
      expect((await discoverCodexProjects({ homePath: home, env: {} })).sessions[0]?.id).toBe(
        "in-wal",
      );
      expect(await fs.readFile(databaseFile)).toEqual(beforeDatabase);
      expect(await fs.readFile(`${databaseFile}-wal`)).toEqual(beforeWal);
    } finally {
      database.close();
    }
  });

  it("returns an empty catalog for an absent installation without creating files", async () => {
    const home = path.join(await temporaryHome(), "not-installed");
    expect(await discoverCodexProjects({ homePath: home, env: {} })).toEqual({
      sourceHome: home,
      projects: [],
      sessions: [],
    });
    await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not silently use an old database when the newest schema is unsupported", async () => {
    const home = await temporaryHome();
    const oldDatabase = createDatabase(home);
    addThread(oldDatabase, { id: "outdated" });
    oldDatabase.close();
    const newest = new DatabaseSync(path.join(home, "state_6.sqlite"));
    newest.exec("CREATE TABLE threads (incompatible TEXT)");
    newest.close();
    await expect(discoverCodexProjects({ homePath: home, env: {} })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("reports unreadable databases and malformed desktop metadata separately from missing storage", async () => {
    const home = await temporaryHome();
    await fs.writeFile(path.join(home, "state_5.sqlite"), "not a database");
    await expect(discoverCodexProjects({ homePath: home, env: {} })).rejects.toMatchObject({
      code: "unreadable",
    });
    await fs.rm(path.join(home, "state_5.sqlite"));
    await fs.writeFile(path.join(home, ".codex-global-state.json"), "{");
    await expect(discoverCodexProjects({ homePath: home, env: {} })).rejects.toMatchObject({
      code: "unreadable",
    });
  });
});
