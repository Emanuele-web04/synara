import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverDevinProjects, readDevinImportHistory } from "./devinProjectImport.ts";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function chatMessage(input: {
  messageId?: string | null;
  role: string;
  content?: string;
  isUserInput?: boolean;
  createdAt?: string | null;
}): string {
  return JSON.stringify({
    message_id: input.messageId === undefined ? crypto.randomUUID() : input.messageId,
    role: input.role,
    content: input.content ?? "",
    metadata: {
      is_user_input: input.isUserInput ?? null,
      created_at: input.createdAt ?? null,
    },
  });
}

interface SessionFixture {
  readonly id: string;
  readonly cwd?: string;
  readonly title?: string | null;
  readonly hidden?: number;
  readonly mainChainId?: number | null;
  readonly createdAt?: number;
  readonly lastActivityAt?: number;
}

function writeStore(
  sessions: ReadonlyArray<SessionFixture>,
  nodes: ReadonlyArray<{
    sessionId: string;
    nodeId: number;
    parentNodeId: number | null;
    message: string;
  }>,
  wal = false,
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "devin-import-"));
  temporaryDirectories.push(directory);
  const dbPath = path.join(directory, "sessions.db");
  const db = new DatabaseSync(dbPath);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
      model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
      cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT
    );
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
      created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id)
    );
  `);
  for (const session of sessions) {
    db.prepare(
      `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode,
        created_at, last_activity_at, title, main_chain_id, workspace_dirs, hidden)
       VALUES (?, ?, 'cli', 'adaptive', 'smart', ?, ?, ?, ?, '[]', ?)`,
    ).run(
      session.id,
      session.cwd ?? "/workspace/app",
      session.createdAt ?? 1_795_446_685,
      session.lastActivityAt ?? 1_795_447_628,
      session.title ?? null,
      session.mainChainId ?? null,
      session.hidden ?? 0,
    );
  }
  for (const node of nodes) {
    db.prepare(
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
       VALUES (?, ?, ?, ?, 1795446685)`,
    ).run(node.sessionId, node.nodeId, node.parentNodeId, node.message);
  }
  db.close();
  return dbPath;
}

describe("discoverDevinProjects", () => {
  it("groups visible sessions into projects by working directory, newest first", async () => {
    const dbPath = writeStore(
      [
        { id: "old", cwd: "/workspace/app", title: "Older", lastActivityAt: 1_795_400_000 },
        { id: "new", cwd: "/workspace/app", title: "Newer", lastActivityAt: 1_795_500_000 },
        { id: "other", cwd: "/workspace/tools", title: "Other repo" },
        { id: "secret", cwd: "/workspace/app", title: "Hidden", hidden: 1 },
      ],
      [],
    );

    const catalog = await discoverDevinProjects({ dbPath });

    expect(catalog.sourceHome).toBe(dbPath);
    expect(catalog.projects).toEqual([
      { id: "/workspace/app", title: "app", roots: ["/workspace/app"] },
      { id: "/workspace/tools", title: "tools", roots: ["/workspace/tools"] },
    ]);
    expect(catalog.sessions.map((session) => [session.id, session.title])).toEqual([
      ["new", "Newer"],
      ["other", "Other repo"],
      ["old", "Older"],
    ]);
    expect(catalog.sessions[0]?.createdAt).toBe(new Date(1_795_446_685_000).toISOString());
    expect(catalog.sessions[0]?.archived).toBe(false);
  });

  it("refuses to guess when the store is missing", async () => {
    await expect(
      discoverDevinProjects({
        dbPath: path.join(os.tmpdir(), "devin-missing-store", "sessions.db"),
      }),
    ).rejects.toThrow(/No Devin session store on this machine/u);
  });

  it("reports an unsupported store layout instead of importing nothing silently", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "devin-import-"));
    temporaryDirectories.push(directory);
    const dbPath = path.join(directory, "sessions.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, unexpected TEXT)`);
    db.exec(`CREATE TABLE message_nodes (session_id TEXT)`);
    db.close();

    await expect(discoverDevinProjects({ dbPath })).rejects.toThrow(/stores sessions differently/u);
  });
});

describe("readDevinImportHistory", () => {
  it("reads a checkpointed WAL-mode store after its writer closes", async () => {
    const dbPath = writeStore(
      [{ id: "closed", mainChainId: 1 }],
      [
        {
          sessionId: "closed",
          nodeId: 1,
          parentNodeId: null,
          message: chatMessage({ role: "assistant", content: "saved turn" }),
        },
      ],
      true,
    );
    expect(fs.existsSync(dbPath + "-wal")).toBe(false);
    const page = await readDevinImportHistory({
      dbPath,
      sessionId: "closed",
      importedAt: "2026-11-24T00:00:00.000Z",
    });
    expect(page.messages.map((message) => message.text)).toEqual(["saved turn"]);
  });

  it("reads the latest committed turn while it is still in the WAL", async () => {
    const dbPath = writeStore([{ id: "live", mainChainId: 1 }], [], true);
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec("PRAGMA wal_autocheckpoint = 0");
      writer
        .prepare(
          "INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, 1)",
        )
        .run("live", 1, chatMessage({ role: "assistant", content: "latest turn" }));
      expect(fs.statSync(dbPath + "-wal").size).toBeGreaterThan(32);
      const page = await readDevinImportHistory({
        dbPath,
        sessionId: "live",
        importedAt: "2026-11-24T00:00:00.000Z",
      });
      expect(page.messages.map((message) => message.text)).toEqual(["latest turn"]);
    } finally {
      writer.close();
    }
  });

  it("follows the main chain and keeps only user-visible text", async () => {
    const dbPath = writeStore(
      [{ id: "sess-1", cwd: "/workspace/app", mainChainId: 4 }],
      [
        {
          sessionId: "sess-1",
          nodeId: 0,
          parentNodeId: null,
          message: chatMessage({ role: "system", content: "policy" }),
        },
        {
          sessionId: "sess-1",
          nodeId: 1,
          parentNodeId: 0,
          message: chatMessage({
            messageId: "u1",
            role: "user",
            isUserInput: true,
            content: "<synara_host_context>policy</synara_host_context>\n\nfix the tests",
            createdAt: "2026-11-23T12:00:00.000Z",
          }),
        },
        {
          sessionId: "sess-1",
          nodeId: 2,
          parentNodeId: 1,
          message: chatMessage({ messageId: "a1", role: "assistant", content: "on it" }),
        },
        {
          sessionId: "sess-1",
          nodeId: 3,
          parentNodeId: 2,
          message: chatMessage({ messageId: "a2", role: "tool", content: "output" }),
        },
        {
          sessionId: "sess-1",
          nodeId: 4,
          parentNodeId: 3,
          message: chatMessage({ messageId: "a3", role: "assistant", content: "done" }),
        },
        {
          sessionId: "sess-1",
          nodeId: 9,
          parentNodeId: null,
          message: chatMessage({ messageId: "x1", role: "assistant", content: "abandoned branch" }),
        },
      ],
    );

    const page = await readDevinImportHistory({
      dbPath,
      sessionId: "sess-1",
      importedAt: "2026-11-24T00:00:00.000Z",
    });

    expect(page.nextCursor).toBe(null);
    expect(page.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "fix the tests"],
      ["assistant", "on it"],
      ["assistant", "done"],
    ]);
    expect(page.messages[0]?.createdAt).toBe("2026-11-23T12:00:00.000Z");
    // Without a timestamp in the record, the node row's own epoch seconds win.
    expect(page.messages[1]?.createdAt).toBe(new Date(1_795_446_685_000).toISOString());
  });

  it("gives repeated imports the same message identities and dedupes re-materialized nodes", async () => {
    const dbPath = writeStore(
      [{ id: "sess-1", cwd: "/workspace/app", mainChainId: 3 }],
      [
        {
          sessionId: "sess-1",
          nodeId: 1,
          parentNodeId: null,
          message: chatMessage({ messageId: "dupe", role: "assistant", content: "yes" }),
        },
        {
          sessionId: "sess-1",
          nodeId: 2,
          parentNodeId: 1,
          message: chatMessage({ messageId: "dupe", role: "assistant", content: "yes" }),
        },
        {
          sessionId: "sess-1",
          nodeId: 3,
          parentNodeId: 2,
          message: chatMessage({
            messageId: "same-text",
            role: "user",
            isUserInput: true,
            content: "yes",
          }),
        },
      ],
    );
    const input = { dbPath, sessionId: "sess-1", importedAt: "2026-11-24T00:00:00.000Z" };

    const first = await readDevinImportHistory(input);
    const second = await readDevinImportHistory(input);

    expect(first.messages).toHaveLength(2);
    expect(first.messages.map((message) => message.messageId)).toEqual(
      second.messages.map((message) => message.messageId),
    );
    expect(first.messages[0]?.messageId).not.toBe(first.messages[1]?.messageId);
  });

  it("skips hidden user inputs and empty assistant messages", async () => {
    const dbPath = writeStore(
      [{ id: "sess-1", cwd: "/workspace/app", mainChainId: 2 }],
      [
        {
          sessionId: "sess-1",
          nodeId: 1,
          parentNodeId: null,
          message: chatMessage({ role: "user", content: "injected", isUserInput: false }),
        },
        {
          sessionId: "sess-1",
          nodeId: 2,
          parentNodeId: 1,
          message: chatMessage({ role: "assistant", content: "   " }),
        },
      ],
    );

    const page = await readDevinImportHistory({
      dbPath,
      sessionId: "sess-1",
      importedAt: "2026-11-24T00:00:00.000Z",
    });

    expect(page.messages).toEqual([]);
  });
});
