import { defineConfig } from "playwright/test";
import editorConfig from "./playwright.editor.config";

// Discovery and installation never require or start an extension host.
export default defineConfig({
  ...editorConfig,
  testMatch: ["editorMarketplace.e2e.ts"],
  timeout: 180_000,
  retries: 0,
});
