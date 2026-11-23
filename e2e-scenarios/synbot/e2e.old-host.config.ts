// SynBot against a host built before SynBot (a cross-version remote host): the same isolated
// Synara, with old-host-proxy.ts between the web app and the server. Kept out of the default run:
//
//   npx e2e run --config e2e.old-host.config.ts
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

const LOOPBACK = "127.0.0.1";

export default {
  tests: "old-host/**/*.e2e.ts",
  targets: [
    {
      name: "old-host",
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: {
        url: `http://${LOOPBACK}:0`,
        command: {
          executable: process.execPath,
          args: ["start-app.ts", "{port}", "--old-host"],
          inheritEnv: ["SYNBOT_SCENARIO_DIR"],
          startupTimeout: 300_000,
          log: ".e2e/app-old-host.log",
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
