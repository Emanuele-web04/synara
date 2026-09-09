// Isolates the removed OpenCode history store, not the full SDK/event pipeline.
// node --expose-gc docs/performance/2026-09-09-memory-crash/opencode-retention.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const mode = process.argv[2];
if (mode === "baseline" || mode === "optimized") {
  if (!global.gc) throw new Error("Run with --expose-gc");
  const original = readFileSync(
    join(import.meta.dirname, "baseline-opencode-retention.txt"),
    "utf8",
  );
  const append = new Function(`${stripTypeScriptTypes(original)}; return appendTurnItem;`)();
  const context = { turns: [], partById: new Map() };
  global.gc();
  const before = process.memoryUsage();
  const started = performance.now();
  for (let update = 1; update <= 256; update++) {
    // Materialize each cumulative snapshot as a provider JSON response would.
    const part = JSON.parse(
      JSON.stringify({
        id: "tool-1",
        messageID: "message-1",
        type: "tool",
        state: { status: "running", output: "x".repeat(update * 1024) },
      }),
    );
    context.partById.set(part.id, part);
    if (mode === "baseline") append(context, "turn-1", part);
  }
  const elapsedMs = performance.now() - started;
  global.gc();
  const after = process.memoryUsage();
  // Access after GC so the retained owner remains live throughout measurement.
  const retainedSnapshots = context.turns.reduce((total, turn) => total + turn.items.length, 0);
  console.log(
    JSON.stringify({
      mode,
      updates: 256,
      finalOutputBytes: 256 * 1024,
      retainedSnapshots,
      latestPartCount: context.partById.size,
      before,
      after,
      retainedHeapDeltaBytes: after.heapUsed - before.heapUsed,
      elapsedMs,
    }),
  );
} else {
  const samples = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const mode of repeat % 2 ? ["optimized", "baseline"] : ["baseline", "optimized"]) {
      const child = spawnSync(process.execPath, ["--expose-gc", import.meta.filename, mode], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (child.status !== 0) throw new Error(child.stderr || String(child.error));
      samples.push({ repeat, ...JSON.parse(child.stdout) });
    }
  }
  const result = { node: process.version, platform: process.platform, arch: process.arch, samples };
  writeFileSync(
    join(import.meta.dirname, "opencode-retention.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      samples.map(({ mode, retainedSnapshots, retainedHeapDeltaBytes }) => ({
        mode,
        retainedSnapshots,
        retainedHeapMiB: retainedHeapDeltaBytes / 1024 / 1024,
      })),
      null,
      2,
    ),
  );
}
