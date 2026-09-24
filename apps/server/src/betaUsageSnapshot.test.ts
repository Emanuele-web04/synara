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
                   ('t3', 'idle', NULL, ${nowIso()})`;
  // t1: 2 turns (1 error). t2: 1 completed turn + 1 stale turn (excluded).
  // t3 has no provider session and must not appear in providers[].
  yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
            VALUES ('t1', 'u1', 'completed', ${nowIso()}, '[]'),
                   ('t1', 'u2', 'error', ${nowIso()}, '[]'),
                   ('t2', 'u3', 'completed', ${nowIso()}, '[]'),
                   ('t2', 'u4', 'interrupted', ${hoursAgoIso(30)}, '[]'),
                   ('t3', 'u5', 'completed', ${nowIso()}, '[]')`;
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
      { provider: "claudeAgent", threads: 2, turns: 3, turnsFailed: 1 },
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

describe("beta gate", () => {
  it("main.ts starts the snapshot job only for the beta bundle id", () => {
    const mainSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "main.ts"),
      "utf8",
    );
    // The job is invoked inside the SYNARA_DESKTOP_BUNDLE_ID_ENV ===
    // SYNARA_BETA_BUNDLE_ID branch, not unconditionally. The gate sits in the
    // few lines directly above the call (the same bundle-id gate also guards
    // the earlier beta-import block, so anchor on the call site itself).
    const callIndex = mainSource.lastIndexOf("startBetaUsageSnapshotJob");
    expect(callIndex).toBeGreaterThan(0);
    const gate = mainSource.slice(callIndex - 400, callIndex + 100);
    expect(gate).toContain("process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV] === SYNARA_BETA_BUNDLE_ID");
  });
});
