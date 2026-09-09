// Bounded SQLite query probe. Uses synthetic data, never a user's database.
// Run from the repository root: node --expose-gc <this-file> baseline|optimized
// Replays frozen SQL by default. --capture explicitly replaces SQL with the current source.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = import.meta.dirname;
const queryNames = [
  "listThreadMessageRows",
  "listThreadMessageRowsByThread",
  "listThreadActivityRows",
  "listThreadActivityRowsByThread",
];

function extractQueries() {
  const source = readFileSync(
    "apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts",
    "utf8",
  );
  const values = {
    threadId: "'thread-perf'",
    maxMessages: "2000",
    MAX_THREAD_MESSAGES: "2000",
    MAX_SNAPSHOT_THREAD_ACTIVITIES: "500",
    MAX_THREAD_DETAIL_ACTIVITIES: "2000",
    liveThreadScope:
      "thread_id IN (SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL)",
  };
  return Object.fromEntries(
    queryNames.map((name) => {
      const start = source.indexOf(`  const ${name} = `);
      if (start < 0) throw new Error(`Missing query ${name}`);
      const sqlStart = source.indexOf("sql`", start) + 4;
      const query = source
        .slice(sqlStart, source.indexOf("`", sqlStart))
        .replace(/\$\{([^}]+)\}/g, (_, key) => {
          if (!(key in values)) throw new Error(`Unsupported query parameter ${key}`);
          return values[key];
        });
      return [name, query];
    }),
  );
}

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = OFF;
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, deleted_at TEXT);
    INSERT INTO projection_threads VALUES ('thread-perf', NULL);
    CREATE TABLE projection_thread_messages (
      thread_id TEXT, message_id TEXT, turn_id TEXT, role TEXT, text TEXT,
      attachments_json TEXT, skills_json TEXT, mentions_json TEXT, dispatch_mode TEXT,
      dispatch_origin TEXT, is_streaming INTEGER, source TEXT, sequence INTEGER,
      created_at TEXT, updated_at TEXT, PRIMARY KEY(thread_id, message_id));
    CREATE INDEX idx_projection_thread_messages_thread_sequence ON projection_thread_messages(thread_id, sequence, message_id);
    CREATE INDEX idx_projection_thread_messages_thread_created_desc ON projection_thread_messages(thread_id, created_at DESC, message_id DESC);
    CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, tone TEXT,
      kind TEXT, summary TEXT, payload_json TEXT, sequence INTEGER, created_at TEXT);
    CREATE INDEX idx_projection_thread_activities_thread_rank_desc ON projection_thread_activities (
      thread_id, CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC, sequence DESC, created_at DESC, activity_id DESC);
    CREATE INDEX idx_projection_thread_activities_thread_sequence ON projection_thread_activities(thread_id, sequence);
    CREATE TABLE provider_runtime_events (event_id TEXT, thread_id TEXT, event_json TEXT);
    CREATE INDEX provider_events_identity ON provider_runtime_events(event_id, thread_id);
    BEGIN;
  `);
  const message = db.prepare(
    "INSERT INTO projection_thread_messages VALUES ('thread-perf', ?, ?, 'assistant', ?, NULL, NULL, NULL, NULL, NULL, 0, 'native', ?, ?, ?)",
  );
  const activity = db.prepare(
    "INSERT INTO projection_thread_activities VALUES (?, 'thread-perf', ?, 'info', 'tool.completed', 'tool output', ?, ?, ?)",
  );
  const text = "x".repeat(16 * 1024);
  const payload = JSON.stringify({ detail: text });
  for (let i = 0; i < 6000; i++) {
    const at = new Date(1_700_000_000_000 + i).toISOString();
    const turn = `turn-${Math.floor(i / 100)}`;
    message.run(`message-${i}`, turn, text, i, at, at);
    activity.run(`activity-${i}`, turn, payload, i, at);
  }
  db.exec("COMMIT;");
  db.close();
}

if (process.argv[2] === "worker") {
  const [, , , dbPath, queryFile, name] = process.argv;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA cache_size = -131072; PRAGMA mmap_size = 536870912;");
  const query = JSON.parse(readFileSync(queryFile, "utf8"))[name];
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .all()
    .map((row) => row.detail);
  // One warm-up per process. This isolates read performance from migration and seed costs.
  db.prepare(query).all();
  global.gc?.();
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const resourceBefore = process.resourceUsage();
  const start = performance.now();
  const rows = db.prepare(query).all();
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const resourceAfter = process.resourceUsage();
  const hash = createHash("sha256");
  for (const row of rows) hash.update(JSON.stringify(row));
  console.log(
    JSON.stringify({
      name,
      rows: rows.length,
      sha256: hash.digest("hex"),
      elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      memoryBefore,
      memoryAfter,
      peakRssKiB: resourceAfter.maxRSS,
      fsWriteOperations: resourceAfter.fsWrite - resourceBefore.fsWrite,
      plan,
    }),
  );
  db.close();
} else {
  const label = process.argv[2];
  if (!["baseline", "optimized"].includes(label)) throw new Error("Specify baseline or optimized");
  mkdirSync(directory, { recursive: true });
  const queryFile = join(directory, `${label}-queries.json`);
  if (process.argv.includes("--capture")) {
    writeFileSync(queryFile, JSON.stringify(extractQueries(), null, 2) + "\n");
  }
  const queries = JSON.parse(readFileSync(queryFile, "utf8"));
  for (const name of queryNames) {
    if (typeof queries[name] !== "string") throw new Error(`Missing frozen query ${name}`);
  }
  const temporary = mkdtempSync(join(tmpdir(), "synara-snapshot-memory-"));
  try {
    const dbPath = join(temporary, "synthetic.sqlite");
    seed(dbPath);
    const samples = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const name of repeat % 2 ? queryNames.toReversed() : queryNames) {
        const child = spawnSync(
          process.execPath,
          ["--expose-gc", import.meta.filename, "worker", dbPath, queryFile, name],
          { encoding: "utf8", timeout: 60_000 },
        );
        if (child.status !== 0) throw new Error(child.stderr || String(child.error));
        const sample = { repeat, ...JSON.parse(child.stdout) };
        samples.push(sample);
        console.log(
          JSON.stringify({
            repeat,
            name,
            elapsedMs: sample.elapsedMs,
            peakRssMiB: sample.peakRssKiB / 1024,
          }),
        );
      }
    }
    writeFileSync(
      join(directory, `${label}.json`),
      JSON.stringify(
        {
          node: process.version,
          sqlite: process.versions.sqlite,
          platform: process.platform,
          arch: process.arch,
          rowsPerTable: 6000,
          bodyBytes: 16384,
          warmupsPerProcess: 1,
          samples,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
