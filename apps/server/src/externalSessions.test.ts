import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { ProjectId, type ServerExternalSessionSummary } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildProjectCandidates,
  readCodexSessionHead,
  scanCodexExternalSessions,
} from "./externalSessions.ts";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(nodePath.join(tmpdir(), "synara-external-sessions-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function codexSessionLines(input: {
  id?: string;
  cwd?: string;
  timestamp?: string;
  firstPrompt?: string;
  leadingGarbage?: boolean;
}): string {
  const lines: string[] = [];
  if (input.leadingGarbage) {
    lines.push("{not json at all");
  }
  lines.push(
    JSON.stringify({
      timestamp: input.timestamp ?? "2026-08-01T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: input.id ?? "sess-1",
        timestamp: input.timestamp ?? "2026-08-01T10:00:00.000Z",
        ...(input.cwd ? { cwd: input.cwd } : {}),
      },
    }),
  );
  if (input.firstPrompt !== undefined) {
    lines.push(
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: input.firstPrompt },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function writeCodexSession(
  sessionsRoot: string,
  fileName: string,
  contents: string,
): Promise<string> {
  const now = new Date();
  const dayDir = nodePath.join(
    sessionsRoot,
    `${now.getFullYear()}`,
    `${String(now.getMonth() + 1).padStart(2, "0")}`,
    `${String(now.getDate()).padStart(2, "0")}`,
  );
  await mkdir(dayDir, { recursive: true });
  const filePath = nodePath.join(dayDir, fileName);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

function summary(
  overrides: Partial<ServerExternalSessionSummary> & { sessionId: string },
): ServerExternalSessionSummary {
  return {
    provider: "claudeAgent",
    title: overrides.sessionId,
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("readCodexSessionHead", () => {
  it("reads session meta and the first user message", async () => {
    const root = await createTempRoot();
    const filePath = nodePath.join(root, "rollout.jsonl");
    await writeFile(
      filePath,
      codexSessionLines({
        id: "sess-abc",
        cwd: "/Users/dev/project",
        firstPrompt: "  fix   the login bug  ",
      }),
      "utf8",
    );

    const head = await readCodexSessionHead(filePath);
    expect(head).not.toBeNull();
    expect(head?.provider).toBe("codex");
    expect(head?.sessionId).toBe("sess-abc");
    expect(head?.cwd).toBe("/Users/dev/project");
    expect(head?.createdAt).toBe("2026-08-01T10:00:00.000Z");
    expect(head?.firstPrompt).toBe("fix the login bug");
    expect(head?.title).toBe("fix the login bug");
    expect(typeof head?.fileSizeBytes).toBe("number");
  });

  it("returns a record without firstPrompt when no user message exists", async () => {
    const root = await createTempRoot();
    const filePath = nodePath.join(root, "rollout.jsonl");
    await writeFile(filePath, codexSessionLines({ id: "sess-meta-only" }), "utf8");

    const head = await readCodexSessionHead(filePath);
    expect(head?.sessionId).toBe("sess-meta-only");
    expect(head?.firstPrompt).toBeUndefined();
    expect(head?.title).toBe("sess-meta-only");
  });

  it("skips malformed lines and still finds session meta", async () => {
    const root = await createTempRoot();
    const filePath = nodePath.join(root, "rollout.jsonl");
    await writeFile(
      filePath,
      codexSessionLines({ id: "sess-after-garbage", leadingGarbage: true }),
      "utf8",
    );

    const head = await readCodexSessionHead(filePath);
    expect(head?.sessionId).toBe("sess-after-garbage");
  });

  it("returns null when no session meta is parseable", async () => {
    const root = await createTempRoot();
    const filePath = nodePath.join(root, "rollout.jsonl");
    await writeFile(filePath, "{broken\n{also broken\n", "utf8");

    expect(await readCodexSessionHead(filePath)).toBeNull();
  });

  it("returns null for a missing file", async () => {
    const root = await createTempRoot();
    expect(await readCodexSessionHead(nodePath.join(root, "missing.jsonl"))).toBeNull();
  });
});

describe("scanCodexExternalSessions", () => {
  it("returns an empty list when the sessions root is missing", async () => {
    const root = await createTempRoot();
    const sessions = await scanCodexExternalSessions({
      worktreesDir: nodePath.join(root, "worktrees"),
      homePath: nodePath.join(root, "no-such-codex-home"),
    });
    expect(sessions).toEqual([]);
  });

  it("excludes sessions whose cwd is inside the managed worktrees dir or a scratch workspace", async () => {
    const root = await createTempRoot();
    const codexHome = nodePath.join(root, "codex-home");
    const worktreesDir = nodePath.join(root, "worktrees");
    const sessionsRoot = nodePath.join(codexHome, "sessions");

    await writeCodexSession(
      sessionsRoot,
      "rollout-keep.jsonl",
      codexSessionLines({ id: "sess-keep", cwd: nodePath.join(root, "real-project") }),
    );
    await writeCodexSession(
      sessionsRoot,
      "rollout-worktree.jsonl",
      codexSessionLines({ id: "sess-worktree", cwd: nodePath.join(worktreesDir, "wt-1") }),
    );
    await writeCodexSession(
      sessionsRoot,
      "rollout-scratch.jsonl",
      codexSessionLines({
        id: "sess-scratch",
        cwd: nodePath.join(root, "synara-codex-workspaces", "thread-1"),
      }),
    );

    const sessions = await scanCodexExternalSessions({ worktreesDir, homePath: codexHome });
    expect(sessions.map((session) => session.sessionId)).toEqual(["sess-keep"]);
  });
});

describe("buildProjectCandidates", () => {
  const existingDirectories = new Set<string>();
  const directoryExists = (path: string) => Promise.resolve(existingDirectories.has(path));

  afterEach(() => {
    existingDirectories.clear();
  });

  it("groups sessions by normalized cwd, unions providers, and sorts by last activity", async () => {
    existingDirectories.add("/Users/dev/alpha");
    existingDirectories.add("/Users/dev/alpha/");
    existingDirectories.add("/Users/dev/beta");

    const result = await buildProjectCandidates({
      sessions: [
        summary({
          sessionId: "a1",
          cwd: "/Users/dev/alpha",
          updatedAt: "2026-08-01T10:00:00.000Z",
        }),
        summary({
          sessionId: "a2",
          provider: "codex",
          cwd: "/Users/dev/alpha/",
          updatedAt: "2026-08-03T10:00:00.000Z",
        }),
        summary({
          sessionId: "b1",
          cwd: "/Users/dev/beta",
          updatedAt: "2026-08-02T10:00:00.000Z",
        }),
        summary({ sessionId: "no-cwd", updatedAt: "2026-08-05T10:00:00.000Z" }),
      ],
      projects: [],
      directoryExists,
    });

    expect(result.candidates).toHaveLength(2);
    const [first, second] = result.candidates;
    expect(first?.workspaceRoot).toBe("/Users/dev/alpha/");
    expect(first?.sessionCount).toBe(2);
    expect([...(first?.providers ?? [])].toSorted()).toEqual(["claudeAgent", "codex"]);
    expect(first?.lastActiveAt).toBe("2026-08-03T10:00:00.000Z");
    expect(second?.workspaceRoot).toBe("/Users/dev/beta");
  });

  it("drops candidates whose directory no longer exists", async () => {
    existingDirectories.add("/Users/dev/alive");

    const result = await buildProjectCandidates({
      sessions: [
        summary({ sessionId: "alive", cwd: "/Users/dev/alive" }),
        summary({ sessionId: "dead", cwd: "/Users/dev/deleted" }),
      ],
      projects: [],
      directoryExists,
    });

    expect(result.candidates.map((candidate) => candidate.workspaceRoot)).toEqual([
      "/Users/dev/alive",
    ]);
  });

  it("marks candidates already covered by a project via normalized comparison", async () => {
    existingDirectories.add("/Users/dev/linked");
    const projectId = ProjectId.makeUnsafe("project-linked");

    const result = await buildProjectCandidates({
      sessions: [summary({ sessionId: "linked", cwd: "/Users/dev/linked" })],
      projects: [{ id: projectId, workspaceRoot: "/Users/dev/linked/" }],
      directoryExists,
    });

    expect(result.candidates[0]?.existingProjectId).toBe(projectId);
  });

  it("returns an empty result for no sessions", async () => {
    const result = await buildProjectCandidates({
      sessions: [],
      projects: [],
      directoryExists,
    });
    expect(result.candidates).toEqual([]);
  });
});
