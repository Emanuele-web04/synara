import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderHistoryError } from "@synara/contracts";

import { listDevinLocalSessions, readDevinLocalSession } from "./devinLocalHistory.ts";

const tmpDirs: Array<string> = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function chatMessage(input: {
  messageId?: string;
  role: string;
  content?: string;
  isUserInput?: boolean;
  createdAt?: string;
}): string {
  return JSON.stringify({
    message_id: input.messageId ?? crypto.randomUUID(),
    role: input.role,
    content: input.content ?? "",
    metadata: { is_user_input: input.isUserInput ?? null, created_at: input.createdAt ?? null },
  });
}

function makeStore(input: {
  sessions?: Array<{ id: string; mainChainId?: number | null; hidden?: number }>;
  nodes?: Array<{
    sessionId: string;
    nodeId: number;
    parentNodeId: number | null;
    chatMessage: string;
  }>;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-store-"));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, "sessions.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      working_directory TEXT NOT NULL,
      backend_type TEXT NOT NULL,
      model TEXT NOT NULL,
      agent_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      title TEXT,
      main_chain_id INTEGER,
      cogs_json TEXT,
      workspace_dirs TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    );
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      node_id INTEGER NOT NULL,
      parent_node_id INTEGER,
      chat_message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      metadata TEXT,
      UNIQUE(session_id, node_id)
    );
  `);
  for (const session of input.sessions ?? [
    { id: "sess-1", mainChainId: 4 },
    { id: "sess-2", mainChainId: 1, hidden: 0 },
  ]) {
    db.prepare(
      `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode,
        created_at, last_activity_at, title, main_chain_id, workspace_dirs, hidden)
       VALUES (?, '/tmp/ws-${session.id}', 'windsurf', 'swe-2-medium', 'smart',
        1795446685, 1795447628, 'Title ${session.id}', ?, '["/tmp/ws-${session.id}"]', ?)`,
    ).run(session.id, session.mainChainId ?? null, session.hidden ?? 0);
  }
  for (const node of input.nodes ?? [
    {
      sessionId: "sess-1",
      nodeId: 0,
      parentNodeId: null,
      chatMessage: chatMessage({ role: "system", content: "sys" }),
    },
    {
      sessionId: "sess-1",
      nodeId: 1,
      parentNodeId: 0,
      chatMessage: chatMessage({
        role: "user",
        content: "hello",
        isUserInput: true,
        createdAt: "2026-11-23T12:00:00Z",
        messageId: "m-user-1",
      }),
    },
    {
      sessionId: "sess-1",
      nodeId: 2,
      parentNodeId: 1,
      chatMessage: chatMessage({ role: "assistant", content: "hi there", messageId: "m-assist-1" }),
    },
    {
      sessionId: "sess-1",
      nodeId: 3,
      parentNodeId: 2,
      chatMessage: chatMessage({ role: "assistant", content: "hi there", messageId: "m-assist-1" }),
    },
    {
      sessionId: "sess-1",
      nodeId: 4,
      parentNodeId: 3,
      chatMessage: chatMessage({ role: "tool", content: "output", messageId: "m-tool-1" }),
    },
    // Side branch off node 1, not on the main chain.
    {
      sessionId: "sess-1",
      nodeId: 5,
      parentNodeId: 1,
      chatMessage: chatMessage({
        role: "assistant",
        content: "abandoned branch",
        messageId: "m-branch",
      }),
    },
  ]) {
    db.prepare(
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
       VALUES (?, ?, ?, ?, 1795446685)`,
    ).run(node.sessionId, node.nodeId, node.parentNodeId, node.chatMessage);
  }
  db.close();
  return dbPath;
}

describe("listDevinLocalSessions", () => {
  it("lists all workspaces' sessions with metadata", async () => {
    const dbPath = makeStore({});
    const sessions = await listDevinLocalSessions({ dbPath });
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["sess-1", "sess-2"]);
    const first = sessions.find((s) => s.sessionId === "sess-1");
    expect(first?.model).toBe("swe-2-medium");
    expect(first?.agentMode).toBe("smart");
    expect(first?.workspaceDirs).toEqual(["/tmp/ws-sess-1"]);
    expect(first?.createdAt).toBe(new Date(1795446685 * 1000).toISOString());
  });

  it("fails with not-found for a missing store", async () => {
    await expect(
      listDevinLocalSessions({ dbPath: "/nonexistent/devin/sessions.db" }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("fails with unsupported-version when schema columns are missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-store-bad-"));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, "sessions.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE message_nodes (session_id TEXT)");
    db.close();
    await expect(listDevinLocalSessions({ dbPath })).rejects.toBeInstanceOf(ProviderHistoryError);
    await expect(listDevinLocalSessions({ dbPath })).rejects.toMatchObject({
      code: "unsupported-version",
    });
  });
});

describe("readDevinLocalSession", () => {
  it("walks the main chain only, preserving node order", async () => {
    const dbPath = makeStore({});
    const { session, messages } = await readDevinLocalSession({
      dbPath,
      sessionId: "sess-1",
    });
    expect(session.title).toBe("Title sess-1");
    // Chain = 0→1→2→3→4 (tip main_chain_id=4); side branch node 5 excluded.
    expect(messages.map((m) => m.nodeId)).toEqual([0, 1, 2, 3, 4]);
    expect(messages.find((m) => m.nodeId === 1)?.isUserInput).toBe(true);
  });

  it("fails with not-found for an unknown session", async () => {
    const dbPath = makeStore({});
    await expect(readDevinLocalSession({ dbPath, sessionId: "nope" })).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("falls back to the highest node tip when main_chain_id is missing", async () => {
    const dbPath = makeStore({
      sessions: [{ id: "sess-1", mainChainId: null }],
    });
    const { messages } = await readDevinLocalSession({ dbPath, sessionId: "sess-1" });
    // Tip = node 5 (side branch) — deterministic choice.
    expect(messages.map((m) => m.nodeId)).toEqual([0, 1, 5]);
  });
});
