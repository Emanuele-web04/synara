import { defineConfig } from "playwright/test";
import editorConfig from "./playwright.editor.config";

export default defineConfig({
  ...editorConfig,
  testMatch: "editorPresentation.e2e.ts",
  use: { ...editorConfig.use, video: "on" },
  reporter: [["list"], ["json", { outputFile: "test-results/editor-presentation.json" }]],
});
