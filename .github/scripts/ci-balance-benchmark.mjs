// Temporary paired benchmark; never operates on a developer checkout.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Ephemeral CI only');
const project = process.env.BENCH_PROJECT;
assert(['chat-follow', 'chat-workflows'].includes(project));
const path = 'apps/web/vitest.browser.ci.config.ts';
const original = readFileSync(path, 'utf8');
const candidate = original.replace('"restores streaming follow"', '"(?:restores streaming follow|project|worktree|Space|approval)"');
assert.notEqual(original, candidate);
const out = join(process.cwd(), 'benchmark-results');
mkdirSync(out, { recursive: true });
const records = [];
try {
  for (let sample = 0; sample < 3; sample++) {
    for (const variant of sample % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      writeFileSync(path, variant === 'candidate' ? candidate : original);
      const name = `${project}-${variant}-${sample}`;
      const start = performance.now();
      const result = spawnSync('bun', ['run', '--cwd', 'apps/web', 'test:browser:ci', '--', `--project=${project}`, '--reporter=default', '--reporter=json', `--outputFile=${join(out, `${name}.json`)}`], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
      const row = { name, seconds: (performance.now() - start) / 1000, status: result.status, error: result.error?.message ?? null };
      records.push(row);
      writeFileSync(join(out, `${name}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
      writeFileSync(join(out, 'results.json'), JSON.stringify(records, null, 2));
      console.log(`CI_BENCHMARK ${JSON.stringify(row)}`);
      console.log((result.stdout ?? '').slice(-1000));
    }
  }
} finally {
  writeFileSync(path, original);
}
if (records.some((r) => r.status !== 0)) process.exitCode = 1;
