import { defineConfig } from "playwright/test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Both processes use an isolated data home; never connect the harness to a running user's app.
const home = mkdtempSync(path.join(os.tmpdir(), "synara-editor-acceptance-"));
const serverPort = Number(process.env.SYNARA_EDITOR_TEST_SERVER_PORT ?? 48121);
const webPort = Number(process.env.SYNARA_EDITOR_TEST_WEB_PORT ?? 5734);
const webUrl = `http://127.0.0.1:${webPort}`;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "editorIntelligence.e2e.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/editor-acceptance.json" }]],
  use: {
    baseURL: webUrl,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "bun run ../server/src/index.ts",
      url: `http://127.0.0.1:${serverPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        SYNARA_HOME: home,
        SYNARA_MODE: "web",
        SYNARA_PORT: String(serverPort),
        SYNARA_HOST: "127.0.0.1",
        SYNARA_NO_BROWSER: "1",
        SYNARA_PATH_HYDRATED: "1",
        // The server must allow this exact development origin, as dev-runner does.
        VITE_DEV_SERVER_URL: webUrl,
        SYNARA_AUTH_TOKEN: "",
      },
    },
    {
      command: `bun run dev --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_WS_URL: `ws://127.0.0.1:${serverPort}`,
        VITE_DEV_SERVER_URL: webUrl,
        SYNARA_AUTH_TOKEN: "",
      },
    },
  ],
});
