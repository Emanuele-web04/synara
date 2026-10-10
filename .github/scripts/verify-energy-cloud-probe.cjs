const assert = require("node:assert/strict");
const fs = require("node:fs");
const [logPath, repeatsArg, durationArg] = process.argv.slice(2);
const repeats = Number(repeatsArg);
const durationMs = Number(durationArg);
assert.ok(Number.isSafeInteger(repeats) && repeats > 0);
assert.ok(Number.isSafeInteger(durationMs) && durationMs > 0);
const lines = fs.readFileSync(logPath, "utf8").split("\n");
const rows = lines
  .filter((line) => line.startsWith("ROW "))
  .map((line) => JSON.parse(line.slice(4)));
const summaries = lines.filter((line) => line.startsWith("SUMMARY "));
assert.equal(rows.length, repeats * 4, "Benchmark did not complete all paired scenarios");
assert.equal(summaries.length, 1, "Benchmark must emit one final summary");
const summary = JSON.parse(summaries[0].slice(8));
const keys = [
  "hidden-clock:baseline",
  "hidden-clock:candidate",
  "synthetic-240hz-stepper:baseline",
  "synthetic-240hz-stepper:candidate",
];
assert.deepEqual(Object.keys(summary).sort(), keys.toSorted());
for (const key of keys) {
  const group = rows.filter((row) => `${row.scenario}:${row.variant}` === key);
  assert.equal(group.length, repeats);
  assert.equal(summary[key].runs, repeats);
  assert.deepEqual(
    group.map((row) => row.repeat).sort((a, b) => a - b),
    Array.from({ length: repeats }, (_, i) => i),
  );
  for (const row of group) {
    assert.equal(row.durationMs, durationMs);
    assert.ok(Number.isFinite(row.totalCpuSeconds) && row.totalCpuSeconds >= 0);
    assert.ok(Number.isFinite(row.averageCorePercent) && row.averageCorePercent >= 0);
    if (row.scenario === "hidden-clock") assert.equal(row.visibility, "hidden");
    if (key === "synthetic-240hz-stepper:candidate") {
      assert.equal(row.emitted, 100);
      assert.equal(row.timerActive, false);
    }
  }
}
console.log(`Verified ${rows.length} measurement rows across ${keys.length} paired groups.`);
