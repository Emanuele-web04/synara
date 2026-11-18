import { createPinnedShardSequencer } from "../../vitest.shards";

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

export const PinnedShardSequencer = createPinnedShardSequencer(PINNED_SERVER_SHARDS);
