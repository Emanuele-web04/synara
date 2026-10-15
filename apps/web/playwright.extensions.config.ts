import { defineConfig } from "playwright/test";
import editorConfig from "./playwright.editor.config";

const runtime = process.env.SYNARA_TEST_CODE_OSS_HOST;
if (!runtime)
  throw new Error(
    "Build the pinned Code-OSS host and set SYNARA_TEST_CODE_OSS_HOST before running extension application acceptance.",
  );
const servers = Array.isArray(editorConfig.webServer)
  ? editorConfig.webServer
  : editorConfig.webServer
    ? [editorConfig.webServer]
    : [];

export default defineConfig({
  ...editorConfig,
  testMatch: [
    "editorExtensions.e2e.ts",
    "editorExtensionDebug.e2e.ts",
    "editorExtensionVsix.e2e.ts",
  ],
  timeout: 180_000,
  reporter: [["list"], ["json", { outputFile: "test-results/extensions-acceptance.json" }]],
  webServer: servers.map((server) => ({
    ...server,
    env: { ...server.env, SYNARA_CODE_OSS_RUNTIME: runtime },
  })),
});
