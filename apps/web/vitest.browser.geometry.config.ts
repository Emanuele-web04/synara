import { defineConfig, mergeConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config";

export default mergeConfig(
  browserConfig,
  defineConfig({
    test: {
      testNamePattern: /\[geometry:linux\]/,
      browser: {
        fileParallelism: false,
      },
    },
  }),
);
