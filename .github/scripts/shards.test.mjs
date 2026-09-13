import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { balance } from "../../apps/server/scripts/ci/balance.ts";

const key = (file) => file.id;
const estimate = (file) => file.seconds;

test("schedules long files first without adding runners", () => {
  const files = [8, 7, 6, 5, 4].map((seconds, i) => ({ id: String(i), seconds }));
  const bins = balance(files, 2, key, estimate);
  assert.deepEqual(
    bins.map((bin) => bin.reduce((n, file) => n + file.seconds, 0)),
    [17, 13],
  );
});

test("all input files appear exactly once for every count, including empty and small suites", () => {
  for (let size = 0; size < 50; size++) {
    const files = Array.from({ length: size }, (_, i) => ({ id: `file-${i}`, seconds: i % 7 }));
    for (let count = 1; count <= 8; count++) {
      const bins = balance(files, count, key, estimate);
      assert.equal(bins.length, count);
      assert.equal(bins.flat().length, size);
      assert.deepEqual(new Set(bins.flat()), new Set(files));
    }
  }
});

test("assignment is independent of discovery order and input is not mutated", () => {
  const files = Array.from({ length: 25 }, (_, i) => ({ id: `file-${i}`, seconds: i % 5 }));
  const original = [...files];
  const bins = balance(files, 3, key, estimate);
  assert.deepEqual(balance(files.toReversed(), 3, key, estimate), bins);
  assert.deepEqual(balance([...files.slice(8), ...files.slice(0, 8)], 3, key, estimate), bins);
  assert.deepEqual(files, original);
});

test("duplicate keys preserve both input specifications", () => {
  const files = [
    { id: "same", seconds: 0 },
    { id: "same", seconds: 0 },
  ];
  const bins = balance(files, 2, key, estimate);
  assert.equal(bins.flat().length, 2);
  assert.deepEqual(new Set(bins.flat()), new Set(files));
});

test("new tests absent from the timing inventory are still assigned", () => {
  const data = JSON.parse(
    readFileSync(new URL("../../apps/server/scripts/ci/durations.json", import.meta.url)),
  );
  assert.ok(Number.isFinite(data.defaultSeconds) && data.defaultSeconds > 0);
  const paths = [...Object.keys(data.seconds), "src/new-regression.test.ts"];
  const bins = balance(
    paths,
    2,
    (path) => path,
    (path) => data.seconds[path] ?? data.defaultSeconds,
  );
  assert.deepEqual(bins.flat().toSorted(), paths.toSorted());
});

test("invalid inputs reject instead of silently losing a partition", () => {
  for (const count of [0, -1, 1.5, NaN]) assert.throws(() => balance([], count, key, estimate));
  for (const seconds of [-1, NaN, Infinity, undefined]) {
    assert.throws(() => balance([{ id: "a", seconds }], 2, key, estimate));
  }
});
