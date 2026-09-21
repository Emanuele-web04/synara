import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { appendFile, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverClaudeProjects, readClaudeImportMessageDates } from "./claudeProjectImport.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const SESSION_C = "33333333-3333-4333-8333-333333333333";
const CREATED_AT = "2026-09-01T10:00:00.000Z";
const UPDATED_AT = "2026-09-02T10:00:00.000Z";
const temporaryDirectories: string[] = [];

async function fixtureHome() {
  const directory = await mkdtemp(path.join(tmpdir(), "synara-claude-project-import-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function transcript(
  home: string,
  directory: string,
  id: string,
  entries: ReadonlyArray<unknown>,
) {
  const projectDir = path.join(home, "projects", directory);
  await mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, `${id}.jsonl`);
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

function session(id: string, overrides: Partial<SDKSessionInfo> = {}): SDKSessionInfo {
  return {
    sessionId: id,
    summary: "Native conversation",
    createdAt: Date.parse(CREATED_AT),
    lastModified: Date.parse(UPDATED_AT),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("discoverClaudeProjects", () => {
  it("groups visible sessions by stable cwd and preserves distinct worktree roots", async () => {
    const configDir = await fixtureHome();
    const root = path.join(configDir, "workspace");
    const worktree = path.join(configDir, "worktrees", "feature");
    await transcript(configDir, "lossy-workspace", SESSION_A, [
      { cwd: root, timestamp: CREATED_AT, entrypoint: "sdk-ts" },
    ]);
    await transcript(configDir, "lossy-workspace", SESSION_B, [
      { cwd: root, timestamp: CREATED_AT },
    ]);
    await transcript(configDir, "lossy-worktree", SESSION_C, [
      { cwd: worktree, timestamp: CREATED_AT },
    ]);

    const catalog = await discoverClaudeProjects({
      configDir,
      listSessions: async () => [
        session(SESSION_A, { cwd: root, customTitle: "Renamed session" }),
        session(SESSION_B, { cwd: root }),
        session(SESSION_C, { cwd: worktree }),
      ],
    });

    expect(catalog.sourceHome).toBe(configDir);
    expect(catalog.projects).toEqual(
      [
        { id: worktree, title: "feature", roots: [worktree] },
        { id: root, title: "workspace", roots: [root] },
      ].toSorted((a, b) => a.id.localeCompare(b.id)),
    );
    expect(catalog.sessions[0]).toEqual({
      id: SESSION_A,
      title: "Renamed session",
      cwd: root,
      projectId: root,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      archived: false,
    });
    expect(catalog.sessions).toHaveLength(3);
  });

  it("recovers metadata beyond the SDK head limit without decoding the folder name", async () => {
    const configDir = await fixtureHome();
    const root = path.join(configDir, "real-project_with-hyphens");
    const file = await transcript(configDir, "intentionally-not-a-path", SESSION_A, []);
    await writeFile(
      file,
      "{malformed}\n" +
        JSON.stringify({
          type: "user",
          message: { content: "x".repeat(180_000) },
          cwd: root,
          timestamp: CREATED_AT,
        }),
    );

    const metadata = session(SESSION_A);
    delete metadata.createdAt;
    const catalog = await discoverClaudeProjects({
      configDir,
      listSessions: async () => [metadata],
    });

    expect(catalog.sessions[0]).toMatchObject({ cwd: root, createdAt: CREATED_AT });
    expect(catalog.projects[0]?.roots).toEqual([root]);
  });

  it("keeps SDK relocation metadata instead of replacing it with an older cwd", async () => {
    const configDir = await fixtureHome();
    const oldRoot = path.join(configDir, "old");
    const relocatedRoot = path.join(configDir, "relocated");
    await transcript(configDir, "old", SESSION_A, [{ cwd: oldRoot, timestamp: CREATED_AT }]);

    const metadata = session(SESSION_A, { cwd: relocatedRoot });
    delete metadata.createdAt;
    const catalog = await discoverClaudeProjects({
      configDir,
      listSessions: async () => [metadata],
    });

    expect(catalog.sessions[0]).toMatchObject({ cwd: relocatedRoot, createdAt: CREATED_AT });
  });

  it("respects SDK visibility and never promotes nested subagents to main sessions", async () => {
    const configDir = await fixtureHome();
    const root = path.join(configDir, "workspace");
    await transcript(configDir, "project", SESSION_A, [{ cwd: root }]);
    await transcript(configDir, "project", SESSION_B, [
      { cwd: root },
      { type: "continued-in", continuedInSessionId: SESSION_A },
    ]);
    await transcript(configDir, path.join("project", SESSION_A, "subagents"), SESSION_C, [
      { cwd: root, isSidechain: true },
    ]);

    const catalog = await discoverClaudeProjects({
      configDir,
      listSessions: async () => [
        session(SESSION_A, { cwd: root }),
        session(SESSION_C, { cwd: root }),
      ],
    });

    expect(catalog.sessions.map((entry) => entry.id)).toEqual([SESSION_A]);
  });

  it("does not guess project paths for records without valid main-session metadata", async () => {
    const configDir = await fixtureHome();
    await transcript(configDir, "-a-plausible-project-path", SESSION_A, [
      { cwd: "relative-project", timestamp: CREATED_AT },
      { cwd: path.join(configDir, "child"), isSidechain: true },
    ]);

    const catalog = await discoverClaudeProjects({
      configDir,
      listSessions: async () => [session(SESSION_A)],
    });

    expect(catalog.projects).toEqual([]);
    expect(catalog.sessions).toEqual([]);
  });

  it("uses the newest transcript when a native session appears in multiple directories", async () => {
    const configDir = await fixtureHome();
    const root = path.join(configDir, "new");
    const newest = await transcript(configDir, "a-new", SESSION_A, [
      { cwd: root, timestamp: CREATED_AT },
    ]);
    const oldest = await transcript(configDir, "z-old", SESSION_A, [
      { cwd: path.join(configDir, "old"), timestamp: CREATED_AT },
    ]);
    await utimes(newest, new Date(UPDATED_AT), new Date(UPDATED_AT));
    await utimes(oldest, new Date(CREATED_AT), new Date(CREATED_AT));

    const catalog = await discoverClaudeProjects({
      configDir,
      listSessions: async () => [session(SESSION_A)],
    });

    expect(catalog.sessions).toHaveLength(1);
    expect(catalog.sessions[0]?.cwd).toBe(root);
  });

  it("returns an empty catalog without loading the SDK when no local sessions exist", async () => {
    const configDir = await fixtureHome();
    const listSessions = vi.fn(async () => []);

    expect(await discoverClaudeProjects({ configDir, listSessions })).toEqual({
      sourceHome: configDir,
      projects: [],
      sessions: [],
    });
    expect(listSessions).not.toHaveBeenCalled();
  });
});

describe("readClaudeImportMessageDates", () => {
  it("enriches remapped native UUIDs with original dates while ignoring malformed and sidechain records", async () => {
    const configDir = await fixtureHome();
    const file = await transcript(configDir, "project", SESSION_A, [
      {
        type: "user",
        uuid: "forked-user",
        message: { content: "x".repeat(150_000) },
        timestamp: CREATED_AT,
      },
      { type: "assistant", uuid: "forked-assistant", timestamp: UPDATED_AT },
      { type: "assistant", uuid: "subagent", timestamp: CREATED_AT, isSidechain: true },
      { type: "custom-title", uuid: "title" },
      { type: "user", uuid: "bad-date", timestamp: "invalid" },
    ]);
    await appendFile(file, "{incomplete");

    const dates = await readClaudeImportMessageDates({ configDir, sessionId: SESSION_A });

    expect([...dates]).toEqual([
      ["forked-user", CREATED_AT],
      ["forked-assistant", UPDATED_AT],
    ]);
  });

  it("returns no dates for a source that no longer exists", async () => {
    const configDir = await fixtureHome();
    expect((await readClaudeImportMessageDates({ configDir, sessionId: SESSION_A })).size).toBe(0);
  });
});
