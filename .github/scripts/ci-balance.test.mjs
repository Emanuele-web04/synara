import assert from "node:assert/strict";
import { test } from "node:test";
import { balance } from "./ci-balance.ts";

const key = (item) => item;
test("Timing sharding is a disjoint cover including new and renamed files", () => {
  const files = Array.from({ length: 417 }, (_, index) => `file-${index}.test.ts`);
  for (const count of [1, 2, 3, 7]) {
    const buckets = balance(files, count, key, { "file-4.test.ts": 20_000, deleted: 90_000 }, 301);
    assert.equal(buckets.length, count);
    assert.deepEqual(buckets.flat().sort(), [...files].sort());
    assert.equal(new Set(buckets.flat()).size, files.length);
    assert.deepEqual(
      balance([...files].reverse(), count, key, { "file-4.test.ts": 20_000, deleted: 90_000 }, 301),
      buckets,
    );
  }
});
test("Longest-first placement balances heavy files without extra runners", () => {
  const weights = { a: 10, b: 9, c: 3, d: 2 };
  const buckets = balance(Object.keys(weights), 2, key, weights, 1);
  assert.deepEqual(
    buckets.map((files) => files.reduce((sum, file) => sum + weights[file], 0)),
    [12, 12],
  );
});
test("Absent, invalid and stale timing hints cannot remove tests", () => {
  const files = ["a", "b", "c", "new"];
  for (const weights of [{}, { a: -1, b: NaN, c: Infinity, deleted: 100 }]) {
    assert.deepEqual(balance(files, 2, key, weights, NaN).flat().sort(), files);
  }
  assert.deepEqual(balance([], 2, key, {}, 1), [[], []]);
  assert.throws(() => balance(files, 0, key, {}, 1), /Invalid shard count/);
});
