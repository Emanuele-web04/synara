// The Stable gate scenario: the same isolated Synara, started as the Stable desktop flavor with a
// local fake Account API (see fake-account.ts). Kept out of the default run:
//
//   npx e2e run --config e2e.stable.config.ts
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

const LOOPBACK = "127.0.0.1";

export default {
  tests: "stable-gate/**/*.e2e.ts",
  targets: [
    {
      name: "stable",
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: {
        url: `http://${LOOPBACK}:0`,
        command: {
          executable: process.execPath,
          args: ["start-app.ts", "{port}", "--stable"],
          inheritEnv: ["SYNBOT_SCENARIO_DIR"],
          startupTimeout: 300_000,
          log: ".e2e/app-stable.log",
        },
      },
    },
  ],
  workers: 1,
  timeout: 300_000,
  assertionTimeout: 20_000,
  video: "retain-on-failure",
  trace: "on",
  reporters: ["list", "markdown"],
} satisfies E2EConfig;
