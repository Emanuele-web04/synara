import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // integration tests can legitimately exceed the default timeout under CI load
      testTimeout: 90_000,
      hookTimeout: 90_000,
    },
  }),
);
