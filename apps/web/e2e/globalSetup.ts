import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(WEB_DIR, ".playwright/electron-e2e");
const OUTPUT_PATH = resolve(OUTPUT_DIR, "visibleBrowserMain.cjs");

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
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  process.env.SYNARA_E2E_ELECTRON_MAIN = OUTPUT_PATH;
  return () => rmSync(OUTPUT_DIR, { recursive: true, force: true });
}
