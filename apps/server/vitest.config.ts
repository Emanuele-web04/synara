import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";
import TimedSequencer from "./vitest.sequencer";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Assignment only runs with --shard; local sort and serial workers stay unchanged.
      sequence: { sequencer: TimedSequencer },
      // Server integration tests exercise sqlite/git orchestration and can
      // legitimately exceed the default timeout when the full workspace suite
      // is running under CI load.
      testTimeout: 90_000,
      hookTimeout: 90_000,
    },
  }),
);
