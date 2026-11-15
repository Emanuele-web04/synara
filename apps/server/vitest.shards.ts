import { relative, sep } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * CI runs the server suite as three serial `--shard=N/3` lanes. Vitest's native
 * split hashes file paths into equal file counts, which put the heaviest files
 * on one shard. These files are placed explicitly; every other file keeps its
 * native shard. Measurements: .github/CI.md. Guarded by
 * scripts/server-ci-shards.test.ts.
 */
export const PINNED_SERVER_SHARDS: Readonly<Record<number, Readonly<Record<string, number>>>> = {
  3: {
    // ~150 s and ~22 s of serial test time, both natively on shard 3.
    "src/orchestration/Layers/ProviderCommandReactor.test.ts": 2,
    "src/accountLiveActivityReporter.test.ts": 2,
  },
};

export class PinnedShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    const { index, count } = config.shard!;
    const pins = PINNED_SERVER_SHARDS[count] ?? {};
    const pinnedShard = (file: TestSpecification) =>
      pins[relative(config.root, file.moduleId).split(sep).join("/")];
    // Native slices partition the full list; removing every pinned file from
    // them and adding back only this shard's pins keeps that a partition.
    const native = await super.shard(files);
    return [
      ...native.filter((file) => pinnedShard(file) === undefined),
      ...files.filter((file) => pinnedShard(file) === index),
    ];
  }
}
