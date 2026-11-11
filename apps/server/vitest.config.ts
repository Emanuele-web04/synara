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
      // Only changes which shard owns a file under --shard; order is unchanged.
      sequence: { sequencer: PinnedShardSequencer },
    },
  }),
);
