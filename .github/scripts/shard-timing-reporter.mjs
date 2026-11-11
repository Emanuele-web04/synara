// TEMPORARY measurement reporter (reverted before merge): prints per-file
// timings and an inventory digest at the end of a sharded Vitest run.
import { createHash } from "node:crypto";
import { relative } from "node:path";

export default class ShardTimingReporter {
  onInit(vitest) {
    this.root = vitest.config.root;
  }
  onTestRunEnd(testModules) {
    const rows = [];
    const ids = [];
    const states = {};
    let tests = 0;
    for (const module of testModules) {
      const file = relative(this.root, module.moduleId);
      const d = module.diagnostic();
      let count = 0;
      for (const test of module.children.allTests()) {
        const state = test.result().state;
        states[state] = (states[state] ?? 0) + 1;
        ids.push(`${file}\t${test.fullName}\t${state}`);
        count++;
      }
      tests += count;
      rows.push({
        file,
        count,
        run: d.duration,
        collect: d.collectDuration,
        prepare: d.prepareDuration,
      });
    }
    ids.sort();
    const digest = createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16);
    const sum = (key) => Math.round(rows.reduce((total, row) => total + row[key], 0));
    console.log(
      `ST-SUMMARY files=${rows.length} tests=${tests} states=${JSON.stringify(states)} digest=${digest}`,
    );
    console.log(`ST-SUMMARY run=${sum("run")} collect=${sum("collect")} prepare=${sum("prepare")}`);
    rows.sort((a, b) => b.run + b.collect - (a.run + a.collect));
    for (const row of rows.slice(0, 45))
      console.log(
        `ST\t${row.file}\t${Math.round(row.run)}\t${Math.round(row.collect)}\t${row.count}`,
      );
  }
}
