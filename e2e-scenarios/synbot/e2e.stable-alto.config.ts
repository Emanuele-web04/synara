// The Stable Alto lifecycle: the Stable flavor with the billing UI a Stable desktop build ships
// (Polar sandbox) and a switchable fake Account API (fake-account-switch.ts). Kept out of the
// default run, and out of the Stable gate run so neither sees the other's account state:
//
//   npx e2e run --config e2e.stable-alto.config.ts
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

const LOOPBACK = "127.0.0.1";

export default {
  tests: "stable-alto/**/*.e2e.ts",
  targets: [
    {
      name: "stable-alto",
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: {
        url: `http://${LOOPBACK}:0`,
        command: {
          executable: process.execPath,
          args: ["start-app.ts", "{port}", "--stable", "--alto-ui"],
          inheritEnv: ["SYNBOT_SCENARIO_DIR"],
          startupTimeout: 300_000,
          log: ".e2e/app-stable-alto.log",
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
