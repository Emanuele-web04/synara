import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type { OrchestrationCommand } from "@synara/contracts";

import { ExternalHistoryRepository } from "../persistence/Services/ExternalHistory.ts";
import { ExternalHistoryRepositoryLive } from "../persistence/Layers/ExternalHistory.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeExternalHistoryService } from "./externalHistoryService.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";

const tmpDirs: Array<string> = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-hist-"));
  tmpDirs.push(dir);
  return dir;
}

function chatMessage(input: {
  messageId?: string;
  role: string;
  content?: string;
  isUserInput?: boolean;
}): string {
  return JSON.stringify({
    message_id: input.messageId ?? crypto.randomUUID(),
    role: input.role,
    content: input.content ?? "",
    metadata: { is_user_input: input.isUserInput ?? null },
  });
}

function makeStore(dir: string): string {
  const dbPath = path.join(dir, "sessions.db");
  const db = new DatabaseSync(dbPath);
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
  db.prepare(
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode,
      created_at, last_activity_at, title, main_chain_id, workspace_dirs, hidden)
     VALUES ('sess-1', '/tmp/ws', 'windsurf', 'swe-2-medium', 'smart', 1795446685,
      1795447628, 'Fix bug', 3, '["/tmp/ws"]', 0)`,
  ).run();
  const nodes: Array<[number, number | null, string]> = [
    [0, null, chatMessage({ role: "system", content: "sys" })],
    [1, 0, chatMessage({ role: "user", content: "hello", isUserInput: true, messageId: "u1" })],
    [2, 1, chatMessage({ role: "assistant", content: "hi", messageId: "a1" })],
    [3, 2, chatMessage({ role: "assistant", content: "more", messageId: "a2" })],
  ];
  for (const [nodeId, parentId, msg] of nodes) {
    db.prepare(
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
       VALUES ('sess-1', ?, ?, ?, 1795446685)`,
    ).run(nodeId, parentId, msg as string);
  }
  db.close();
  return dbPath;
}

function fakeEngine(dispatched: Array<OrchestrationCommand>): OrchestrationEngineShape {
  return {
    dispatch: (command: OrchestrationCommand) => {
      dispatched.push(command);
      return Effect.succeed({ sequence: dispatched.length });
    },
  } as unknown as OrchestrationEngineShape;
}

const layer = it.layer(
  ExternalHistoryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ExternalHistoryService", (it) => {
  it.effect("lists the local store and ATIF sources", () =>
    Effect.gen(function* () {
      const dir = makeTmpDir();
      const dispatched: Array<OrchestrationCommand> = [];
      const service = makeExternalHistoryService({
        repository: yield* ExternalHistoryRepository,
        orchestrationEngine: fakeEngine(dispatched),
        homeDir: dir,
        devinStorePath: makeStore(dir),
        devinCredentialsPath: path.join(dir, "no-credentials.toml"),
      });
      const { sources } = yield* service.listSources();
      const kinds = sources.map((s) => s.kind).sort();
      assert.deepStrictEqual(kinds, ["devin-atif", "devin-local"]);
    }),
  );

  it.effect("lists sessions and reads a normalized transcript", () =>
    Effect.gen(function* () {
      const dir = makeTmpDir();
      const service = makeExternalHistoryService({
        repository: yield* ExternalHistoryRepository,
        orchestrationEngine: fakeEngine([]),
        homeDir: dir,
        devinStorePath: makeStore(dir),
        devinCredentialsPath: path.join(dir, "no-credentials.toml"),
      });
      const { sessions } = yield* service.listSessions({ sourceId: "devin-local" });
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0]?.externalSessionId, "sess-1");
      const { messages } = yield* service.readHistory({
        sourceId: "devin-local",
        externalSessionId: "sess-1",
      });
      assert.deepStrictEqual(
        messages.map((m) => [m.upstreamMessageId, m.role]),
        [
          ["u1", "user"],
          ["a1", "assistant"],
          ["a2", "assistant"],
        ],
      );
    }),
  );

  it.effect("imports a session once: thread + deterministic batches; re-import adds nothing", () =>
    Effect.gen(function* () {
      const dir = makeTmpDir();
      const dispatched: Array<OrchestrationCommand> = [];
      const repository = yield* ExternalHistoryRepository;
      const service = makeExternalHistoryService({
        repository,
        orchestrationEngine: fakeEngine(dispatched),
        homeDir: dir,
        devinStorePath: makeStore(dir),
        devinCredentialsPath: path.join(dir, "no-credentials.toml"),
      });
      const input = {
        sourceId: "devin-local",
        externalSessionId: "sess-1",
        projectId: "proj-1" as never,
        modelSelection: { provider: "devin", model: "swe-2-medium" } as never,
      };
      const first = yield* service.importHistory(input);
      assert.strictEqual(first.importedCount, 3);
      assert.strictEqual(first.alreadyStagedCount, 0);
      const types = dispatched.map((c) => c.type);
      assert.deepStrictEqual(types, ["thread.create", "thread.messages.import"]);
      const importCmd = dispatched[1];
      assert.ok(importCmd !== undefined && "commandId" in importCmd);
      assert.strictEqual(String(importCmd.commandId).startsWith("ext-hist-import-ehb-"), true);

      const second = yield* service.importHistory(input);
      assert.strictEqual(second.importedCount, 0);
      assert.strictEqual(second.alreadyStagedCount, 3);
      assert.strictEqual(second.threadId, first.threadId);
      // No new dispatch happened on re-import.
      assert.strictEqual(dispatched.length, 2);

      const link = yield* repository.getLink({
        sourceId: "devin-local",
        externalSessionId: "sess-1",
      });
      assert.strictEqual(link._tag, "Some");
      if (link._tag === "Some") {
        assert.strictEqual(link.value.historyStatus, "complete");
        assert.strictEqual(link.value.threadId, first.threadId);
        // DHI-07: a local-store import keeps the native resume descriptor so the
        // first send reloads the upstream session through `session/load`.
        assert.deepStrictEqual(link.value.nativeResumeDescriptor, {
          kind: "devin-acp",
          sessionId: "sess-1",
          model: "swe-2-medium",
        });
      }
    }),
  );
});
