import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    // direct React roots in hook regressions must not trigger a mid-test reload
    optimizeDeps: { include: ["react-dom/client"] },
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    test: {
      include: [
        "src/components/**/*.browser.tsx",
        "src/hooks/**/*.browser.ts",
        "src/hooks/**/*.browser.tsx",
        "src/lib/**/*.browser.ts",
        "src/lib/**/*.browser.tsx",
      ],
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        headless: true,
        api: {
          // vitest's default 63315 falls inside common Windows/Hyper-V excluded-port ranges — IPv4 + overridable fallback
          host: process.env.VITEST_BROWSER_API_HOST ?? "127.0.0.1",
          port: Number(process.env.VITEST_BROWSER_API_PORT ?? 51_100),
        },
      },
      // the full desktop route graph can take >30s to compile on a cold Windows cache
      testTimeout: 90_000,
      hookTimeout: 90_000,
    },
  }),
);
