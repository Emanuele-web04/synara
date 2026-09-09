// Measures WAL bytes written by the streaming-delta projection pattern
// (`text = text || ?` per delta) versus coalesced flushes, using node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const messageBytes = Number(process.argv[2] ?? 200_000);
const chunkBytes = Number(process.argv[3] ?? 40);
const flushEvery = Number(process.argv[4] ?? 1); // deltas per UPDATE

const dir = mkdtempSync(join(tmpdir(), "synara-delta-bench-"));
const dbPath = join(dir, "bench.sqlite");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0;");
db.exec(`CREATE TABLE projection_thread_messages (thread_id TEXT, message_id TEXT, text TEXT, updated_at TEXT, PRIMARY KEY (thread_id, message_id));
CREATE TABLE message_text_segments (thread_id TEXT, message_id TEXT, sequence INTEGER, text TEXT, ended_at TEXT, PRIMARY KEY (thread_id, message_id, sequence));
CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_json TEXT);`);
db.prepare("INSERT INTO projection_thread_messages VALUES ('t','m','', '')").run();
db.prepare("INSERT INTO message_text_segments VALUES ('t','m',1,'','')").run();
const upMsg = db.prepare(
  "UPDATE projection_thread_messages SET text = text || ?, updated_at = ? WHERE thread_id='t' AND message_id='m'",
);
const upSeg = db.prepare(
  "UPDATE message_text_segments SET text = text || ?, ended_at = ? WHERE thread_id='t' AND message_id='m' AND sequence = (SELECT MAX(sequence) FROM message_text_segments WHERE thread_id='t' AND message_id='m')",
);
const insEvt = db.prepare("INSERT INTO orchestration_events (event_json) VALUES (?)");
const chunk = "x".repeat(chunkBytes);
const deltas = Math.ceil(messageBytes / chunkBytes);
const walPath = dbPath + "-wal";
const walSize = () => {
  try {
    return statSync(walPath).size;
  } catch {
    return 0;
  }
};
const t0 = performance.now();
let pending = "";
let updates = 0;
for (let i = 1; i <= deltas; i++) {
  pending += chunk;
  if (i % flushEvery === 0 || i === deltas) {
    db.exec("BEGIN");
    insEvt.run(
      JSON.stringify({
        type: "thread.message-sent",
        payload: { threadId: "t", messageId: "m", text: pending, streaming: true },
      }),
    );
    upMsg.run(pending, new Date().toISOString());
    upSeg.run(pending, new Date().toISOString());
    db.exec("COMMIT");
    updates += 1;
    pending = "";
  }
}
const elapsedMs = performance.now() - t0;
const wal = walSize();
const finalLen = db.prepare("SELECT length(text) AS n FROM projection_thread_messages").get().n;
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(
  JSON.stringify({
    messageBytes,
    chunkBytes,
    flushEvery,
    deltas,
    updates,
    finalLen,
    walBytes: wal,
    walMiB: +(wal / 1048576).toFixed(2),
    amplification: +(wal / messageBytes).toFixed(1),
    elapsedMs: +elapsedMs.toFixed(1),
    msPerDelta: +(elapsedMs / deltas).toFixed(3),
  }),
);
