import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // Wandy enablement is derived from the host env (the desktop app exports
      // DPCODE_MODE=desktop to spawned shells). Pin it off so suites behave
      // like CI everywhere; tests that exercise Wandy pass explicit envs.
      // Tests that temporarily set this on process.env rely on vitest's
      // default per-file process isolation (pool: "forks", isolate: true) —
      // don't disable isolation without revisiting them.
      SYNARA_ENABLE_WANDY: "0",
    },
  },
  resolve: {
    alias: [
      {
        find: /^@t3tools\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "./packages/contracts/src/index.ts"),
      },
      // The web app's `~` alias (only workspace that defines one), so its
      // modules stay importable from tests without rewriting to relative paths.
      {
        find: /^~\//,
        replacement: `${path.resolve(import.meta.dirname, "./apps/web/src")}/`,
      },
    ],
  },
});
