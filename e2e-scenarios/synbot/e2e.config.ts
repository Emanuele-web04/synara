// SynBot scenarios: e2e tests against a real, isolated Synara whose only provider is a scripted
// fake agent. See README.md.
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

const LOOPBACK = "127.0.0.1";

const app = {
  url: `http://${LOOPBACK}:0`,
  command: {
    executable: process.execPath,
    args: ["start-app.ts", "{port}"],
    startupTimeout: 300_000,
    log: ".e2e/app.log",
  },
};

export default {
  tests: "scenarios/**/*.e2e.ts",
  targets: [{ name: "desktop", engine: web({ viewport: { width: 1440, height: 900 } }), app }],
  // One server holds every test's state.
  workers: 1,
  timeout: 300_000,
  assertionTimeout: 20_000,
  video: "retain-on-failure",
  trace: "on",
  reporters: ["list", "markdown"],
} satisfies E2EConfig;
