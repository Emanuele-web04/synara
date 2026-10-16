import { defineConfig } from "playwright/test";
import editorConfig from "./playwright.editor.config";

export default defineConfig({
  ...editorConfig,
  testMatch: "editorToolsRail.e2e.ts",
  timeout: 120_000,
  reporter: [["list"], ["json", { outputFile: "test-results/editor-tools.json" }]],
  use: { ...editorConfig.use, video: "on" },
});
