import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(WEB_DIR, ".playwright/electron-e2e");
const OUTPUT_PATH = resolve(OUTPUT_DIR, "visibleBrowserMain.cjs");
const ANNOTATION_PRELOAD_OUTPUT_PATH = resolve(OUTPUT_DIR, "browserAnnotationGuestPreload.cjs");
const FLOATING_CHROME_PRELOAD_OUTPUT_PATH = resolve(OUTPUT_DIR, "floatingBrowserChromePreload.cjs");
const FLOATING_HANDOFF_OUTPUT_PATH = resolve(OUTPUT_DIR, "floatingBrowserHandoff.cjs");

export default function globalSetup(): () => void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/visibleBrowserMain.ts",
      "--target=node",
      "--format=cjs",
      `--outfile=${OUTPUT_PATH}`,
      "--external=electron",
      "--external=betterwright",
      `--banner=module.paths.unshift(${JSON.stringify(resolve(WEB_DIR, "../desktop/node_modules"))});`,
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  execFileSync(
    "bun",
    [
      "build",
      "../desktop/src/browserAnnotations/guestPreload.ts",
      "--target=node",
      "--format=cjs",
      `--outfile=${ANNOTATION_PRELOAD_OUTPUT_PATH}`,
      "--external=electron",
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  execFileSync(
    "bun",
    [
      "build",
      "../desktop/src/floatingBrowserChromePreload.ts",
      "--target=node",
      "--format=cjs",
      `--outfile=${FLOATING_CHROME_PRELOAD_OUTPUT_PATH}`,
      "--external=electron",
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  process.env.SYNARA_E2E_ELECTRON_MAIN = OUTPUT_PATH;
  process.env.SYNARA_E2E_BROWSER_ANNOTATION_PRELOAD = ANNOTATION_PRELOAD_OUTPUT_PATH;
  process.env.SYNARA_E2E_FLOATING_CHROME_PRELOAD = FLOATING_CHROME_PRELOAD_OUTPUT_PATH;
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/floatingBrowserHandoff.ts",
      "--target=browser",
      "--format=cjs",
      `--outfile=${FLOATING_HANDOFF_OUTPUT_PATH}`,
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  process.env.SYNARA_E2E_FLOATING_HANDOFF_RENDERER = FLOATING_HANDOFF_OUTPUT_PATH;
  return () => rmSync(OUTPUT_DIR, { recursive: true, force: true });
}
