import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balancedShards } from './ci-shards.mjs';

test('balances expensive files without adding a runner', () => {
  const result = balancedShards(['a','b','c','d'], 2, {a:20,b:15,c:10,d:5});
  assert.deepEqual(result, [['a','d'], ['b','c']]);
});
test('runs every unknown/new/renamed file once; stale hints cannot add tests', () => {
  const files = ['new', 'renamed', 'known'];
  const result = balancedShards(files, 2, {deleted:1000, known:10});
  assert.deepEqual(result.flat().toSorted(), files.toSorted());
  assert.equal(new Set(result.flat()).size, files.length);
});
test('placement is independent of file discovery order', () => {
  const files = ['z','a','q','x','b'];
  assert.deepEqual(balancedShards(files,3), balancedShards(files.toReversed(),3));
});
test('empty suites and more shards than files keep exact inventory', () => {
  assert.deepEqual(balancedShards([],2), [[],[]]);
  assert.deepEqual(balancedShards(['a'],3), [['a'],[],[]]);
});
test('invalid duration hints affect no eligibility', () => {
  const files = ['a','b','c'];
  assert.deepEqual(balancedShards(files,2,{a:NaN,b:-1,c:Infinity}).flat().toSorted(), files);
});
test('invalid counts and duplicate inventories fail rather than silently skip', () => {
  for (const count of [0,-1,1.5,NaN]) assert.throws(() => balancedShards(['a'],count));
  assert.throws(() => balancedShards(['a','a'],2));
});
