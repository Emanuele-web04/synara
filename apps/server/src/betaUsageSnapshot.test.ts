// FILE: betaUsageSnapshot.test.ts
// Purpose: Coverage for the beta-only usage snapshot writer — counts, atomic
//          file output, and the beta-bundle-id gate in server main.ts.
// Layer: Server maintenance tests

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { BETA_USAGE_SNAPSHOT_FILE_NAME, writeBetaUsageSnapshot } from "./betaUsageSnapshot";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-beta-usage-test-"));
  roots.push(root);
  return root;
}

const testLayer = Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer);

function run<A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem | Path.Path>,
) {
  return effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);
}

const nowIso = () => new Date().toISOString();
const hoursAgoIso = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, kind, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
            VALUES ('p1', 'project', 'One', '/tmp/one', '[]', ${nowIso()}, ${nowIso()}, NULL)`;
  yield* sql`INSERT INTO projection_projects (project_id, kind, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
            VALUES ('p2', 'project', 'Two', '/tmp/two', '[]', ${nowIso()}, ${nowIso()}, ${nowIso()})`;
  yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, provider_name, updated_at)
            VALUES ('t1', 'idle', 'claudeAgent', ${nowIso()}),
                   ('t2', 'idle', 'claudeAgent', ${nowIso()}),
                   ('th3', 'idle', NULL, ${nowIso()})`;
  // t1: 2 turns (1 error). t2: 1 completed + 1 interrupted (a user cancel, not
  // a failure) + 1 stale turn (excluded). th3 has no provider session and must
  // not appear in providers[].
  yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
            VALUES ('t1', 'u1', 'completed', ${nowIso()}, '[]'),
                   ('t1', 'u2', 'error', ${nowIso()}, '[]'),
                   ('t2', 'u3', 'completed', ${nowIso()}, '[]'),
                   ('t2', 'u4', 'interrupted', ${nowIso()}, '[]'),
                   ('t2', 'u6', 'completed', ${hoursAgoIso(30)}, '[]'),
                   ('th3', 'u5', 'completed', ${nowIso()}, '[]')`;
});

const turnRequest = (messageId: string, model: string, effort: string) =>
  JSON.stringify({
    threadId: "b1",
    messageId,
    modelSelection: { provider: "claudeAgent", model, options: { effort } },
    interactionMode: "plan",
    runtimeMode: "approval-required",
  });

describe("turn breakdown", () => {
  it("groups finished turns by fixed categories and keeps no user-defined names", async () => {
    const root = makeRoot();
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const at = nowIso();
        yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, provider_name, updated_at)
                  VALUES ('b1', 'idle', 'claudeAgent', ${at})`;
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
                  VALUES ('b1', 'bt1', 'm1', 'completed', ${at}, ${hoursAgoIso(0.01)}, ${at}, '[]'),
                         ('b1', 'bt2', 'm2', 'error', ${at}, NULL, NULL, '[]'),
                         ('b1', 'bt3', 'm3', 'running', ${at}, NULL, NULL, '[]')`;
        let sequence = 1;
        for (const [messageId, model, effort] of [
          ["m1", "claude-fable-5-1", "high"],
          ["m2", "my-private-finetune", "galaxy-brain"],
        ] as const) {
          yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
                    VALUES (${`ev-${messageId}`}, 'thread', 'b1', ${sequence++}, 'thread.turn-start-requested', ${at}, 'client', ${turnRequest(messageId, model, effort)}, '{}')`;
        }
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
                  VALUES ('a1', 'b1', 'bt1', 'info', 'turn.completed', 'done',
                          ${JSON.stringify({ modelUsage: { "secret-model-key": { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 2 } } })}, ${at})`;
        yield* writeBetaUsageSnapshot(root);
      }),
    );
    const snapshot = JSON.parse(
      readFileSync(join(root, "diagnostics", BETA_USAGE_SNAPSHOT_FILE_NAME), "utf8"),
    );
    const rows = snapshot.turnBreakdown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(
      expect.objectContaining({
        provider: "claudeAgent",
        model: "claude-fable-5-1",
        effort: "high",
        interactionMode: "plan",
        runtimeMode: "approval-required",
        origin: "user",
        outcome: "succeeded",
        turns: 1,
        durationSamples: 1,
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 2,
        tokenSamples: 1,
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ model: "other", effort: "default", outcome: "failed", turns: 1 }),
    );
    expect(JSON.stringify(snapshot)).not.toContain("secret-model-key");
    expect(JSON.stringify(snapshot)).not.toContain("my-private-finetune");
  });
});

describe("writeBetaUsageSnapshot", () => {
  it("writes last-24h counts atomically with private permissions", async () => {
    const root = makeRoot();
    await run(
      Effect.gen(function* () {
        yield* seed;
        yield* writeBetaUsageSnapshot(root);
      }),
    );
    const file = join(root, "diagnostics", BETA_USAGE_SNAPSHOT_FILE_NAME);
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    expect(snapshot.v).toBe(1);
    expect(typeof snapshot.generatedAt).toBe("string");
    expect(snapshot.providers).toEqual([
      { provider: "claudeAgent", threads: 2, turns: 4, turnsFailed: 1 },
    ]);
    expect(snapshot.projects).toBe(1); // deleted project excluded
    expect(snapshot.activeThreads).toBe(3); // stale turn's thread still counted
    // Atomic: no temp files left behind, private mode.
    expect(readdirSync(join(root, "diagnostics"))).toEqual([BETA_USAGE_SNAPSHOT_FILE_NAME]);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("succeeds on an empty database", async () => {
    const root = makeRoot();
    await run(writeBetaUsageSnapshot(root));
    const snapshot = JSON.parse(
      readFileSync(join(root, "diagnostics", BETA_USAGE_SNAPSHOT_FILE_NAME), "utf8"),
    );
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.projects).toBe(0);
    expect(snapshot.activeThreads).toBe(0);
  });
});

describe("bundle gate", () => {
  it("main.ts starts the snapshot job only for the Beta and Remote bundle ids", () => {
    const mainSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "main.ts"),
      "utf8",
    );
    // The job is invoked inside the Beta/Remote bundle-id branch, not
    // unconditionally. The gate sits in the few lines directly above the call
    // (a bundle-id gate also guards the earlier beta-import block, so anchor on
    // the call site itself).
    const callIndex = mainSource.lastIndexOf("startBetaUsageSnapshotJob");
    expect(callIndex).toBeGreaterThan(0);
    const gate = mainSource.slice(callIndex - 400, callIndex + 100);
    expect(gate).toContain("const desktopBundleId = process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV];");
    expect(gate).toContain(
      "desktopBundleId === SYNARA_BETA_BUNDLE_ID || desktopBundleId === SYNARA_REMOTE_BUNDLE_ID",
    );
  });
});
