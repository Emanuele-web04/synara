import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      env: { SYNARA_REMOTE_CONNECTIONS: "1", SYNARA_DESKTOP_BUNDLE_ID: "" },
      hookTimeout: 90_000,
      testTimeout: 90_000,
    },
  }),
);
