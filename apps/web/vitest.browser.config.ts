import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    // Prebundle direct hook dependencies so restored caches cannot reload tests mid-run.
    optimizeDeps: { include: ["react-dom/client", "zustand/vanilla/shallow"] },
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
      // Browser component tests share page-level mock infrastructure; run files serially
      // so one spec cannot steal another spec's WebSocket/native-API events.
      fileParallelism: false,
      maxWorkers: 1,
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
