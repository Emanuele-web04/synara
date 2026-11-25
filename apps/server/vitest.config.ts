import { availableParallelism } from "node:os";

import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";
import { PinnedShardSequencer } from "./vitest.shards";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Server integration tests exercise sqlite/git orchestration and can
      // legitimately exceed the default timeout when the full workspace suite
      // is running under CI load.
      testTimeout: 90_000,
      hookTimeout: 90_000,
      // One worker per core: Vitest's default leaves one core idle. Files run
      // in separate worker processes, each with its own temp dirs and SQLite
      // databases.
      maxWorkers: availableParallelism(),
      // Only changes which shard owns a file under --shard; order is unchanged.
      sequence: { sequencer: PinnedShardSequencer },
    },
  }),
);
