import assert from "node:assert/strict";
import { test } from "node:test";
import TimingReporter from "./ci-timing-reporter.mjs";

test("Timing reports include skipped cases without inventing execution time", () => {
  const reporter = new TimingReporter();
  reporter.onTestModuleEnd({
    relativeModuleId: "src/example.test.ts",
    state: () => "passed",
    diagnostic: () => ({ duration: 12, collectDuration: 3 }),
    children: {
      allTests: () => [
        {
          fullName: "passes",
          result: () => ({ state: "passed" }),
          diagnostic: () => ({ duration: 12 }),
        },
        { fullName: "skipped", result: () => ({ state: "skipped" }), diagnostic: () => undefined },
      ],
    },
  });
  assert.equal(reporter.modules.length, 1);
  assert.deepEqual(reporter.modules[0].tests, [
    { name: "passes", state: "passed", durationMs: 12 },
    { name: "skipped", state: "skipped", durationMs: 0 },
  ]);
});
