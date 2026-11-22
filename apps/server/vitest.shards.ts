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
    // ~22 s of serial test time, natively on shard 3.
    "src/accountLiveActivityReporter.test.ts": 2,
    // The former single ~105 s ProviderCommandReactor.test.ts, split into seven
    // files of at most ~22 s so shard 2's four workers share it instead of one
    // file setting the shard's floor. They stay together on shard 2, where the
    // whole file ran; natively two would land on shard 1 (the slowest lane) and
    // four on shard 3. ProviderCommandReactor.skillMentions.test.ts keeps its
    // native shard.
    "src/orchestration/Layers/ProviderCommandReactor.test.ts": 2,
    "src/orchestration/Layers/ProviderCommandReactor.claudeCacheReview.test.ts": 2,
    "src/orchestration/Layers/ProviderCommandReactor.deliveryRecovery.test.ts": 2,
    "src/orchestration/Layers/ProviderCommandReactor.resumeAndEdits.test.ts": 2,
    "src/orchestration/Layers/ProviderCommandReactor.turnStart.test.ts": 2,
    "src/orchestration/Layers/ProviderCommandReactor.queueAndHandoff.test.ts": 2,
    "src/orchestration/Layers/ProviderCommandReactor.sessionLifecycle.test.ts": 2,
  },
};

export const PinnedShardSequencer = createPinnedShardSequencer(PINNED_SERVER_SHARDS);
