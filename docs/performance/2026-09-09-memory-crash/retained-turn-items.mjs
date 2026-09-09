// Historical experiment: this lossy policy was REMOVED from production because
// it discarded readThread history. Retained only to reproduce the old report.
// Run: node --expose-gc docs/performance/2026-09-09-memory-crash/retained-turn-items.mjs
import { randomBytes } from "node:crypto";
function releaseAllButLatestTurnItems(turns) {
  for (let index = 0; index < turns.length - 1; index += 1) {
    turns[index].items.length = 0;
    turns[index].toolItemIndexes?.clear();
  }
}

const turnCount = Number(process.argv[2] ?? 200);
const itemsPerTurn = Number(process.argv[3] ?? 4);
const itemBytes = Number(process.argv[4] ?? 64 * 1024);

function heapUsedAfterGc() {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

function simulate(release) {
  const turns = [];
  for (let index = 0; index < turnCount; index += 1) {
    const items = [];
    for (let item = 0; item < itemsPerTurn; item += 1) {
      // Fresh string per item so nothing is shared across turns.
      items.push({
        role: "user",
        content: [
          { type: "tool_result", content: randomBytes(Math.ceil(itemBytes / 2)).toString("hex") },
        ],
      });
    }
    turns.push({ id: `turn-${index}`, items, toolItemIndexes: new Map([[`call-${index}`, 0]]) });
    if (release) releaseAllButLatestTurnItems(turns);
  }
  return turns;
}

const baseline = heapUsedAfterGc();
const results = {};
for (const release of [false, true]) {
  const turns = simulate(release);
  const retained = heapUsedAfterGc() - baseline;
  const retainedItems = turns.reduce((sum, turn) => sum + turn.items.length, 0);
  results[release ? "withRelease" : "withoutRelease"] = {
    turns: turns.length,
    retainedItems,
    retainedHeapMiB: +(retained / 1048576).toFixed(2),
  };
  turns.length = 0;
}
console.log(JSON.stringify({ turnCount, itemsPerTurn, itemBytes, ...results }, null, 2));
