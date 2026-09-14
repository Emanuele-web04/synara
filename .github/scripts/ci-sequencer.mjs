import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { BaseSequencer } from 'vitest/node';
import { balancedShards } from './ci-shards.mjs';

// Measured hints from run 34822416944. They are not a test allowlist.
const durations = JSON.parse(readFileSync(new URL('./server-test-timings.json', import.meta.url), 'utf8'));
export default class TimingSequencer extends BaseSequencer {
  async shard(specifications) {
    const { index, count } = this.ctx.config.shard;
    if (!Number.isInteger(index) || index < 1 || index > count) throw new Error('Invalid shard index');
    const pathFor = (spec) => relative(this.ctx.config.root, spec.moduleId).replaceAll('\\', '/');
    const paths = specifications.map(pathFor);
    const selected = new Set(balancedShards(paths, count, durations)[index - 1]);
    return specifications.filter((spec) => selected.has(pathFor(spec)));
  }
}
