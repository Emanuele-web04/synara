// Exercises a fresh desktop launch and supervised backend recovery without user data.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import electronPath from "electron";

import { SYNARA_DESKTOP_SMOKE_USER_DATA_ENV } from "@synara/shared/desktopIdentity";
import { spawnSourceDesktop } from "./source-desktop-launch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const smokeHome = mkdtempSync(join(tmpdir(), "synara-desktop-smoke-"));
const environment = {
  ...process.env,
  ELECTRON_ENABLE_LOGGING: "1",
  SYNARA_HOME: smokeHome,
  SYNARA_DESKTOP_FLAVOR: "dev",
  [SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]: join(smokeHome, "electron-user-data"),
};
// Config.url rejects an empty string; the built UI needs this variable absent.
delete environment.VITE_DEV_SERVER_URL;
delete environment.SYNARA_AUTH_TOKEN;

console.log("\nLaunching Electron smoke test...");

const child = spawnSourceDesktop({
  desktopDirectory: desktopDir,
  electronPath,
  spawnProcess: spawn,
  stdio: ["pipe", "pipe", "pipe"],
  environment,
});

let output = "";
let forceExit;
let restartVerified = false;
let recoveryFailure;
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const timeout = setTimeout(() => {
  recoveryFailure = "Backend recovery did not finish before the smoke deadline";
  child.kill();
  // This fresh, empty profile never starts a provider turn or desktop input.
  // A modal startup error must not leave the unattended smoke run hanging.
  forceExit = setTimeout(() => child.kill("SIGKILL"), 5_000);
}, 45_000);

// Runtime metadata comes only from this fresh, isolated desktop's backend.
async function waitForReadyBackend(previousPid) {
  while (true) {
    let state;
    try {
      state = JSON.parse(readFileSync(join(smokeHome, "userdata/server-runtime.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (
      state &&
      Number.isSafeInteger(state.pid) &&
      state.pid > 1 &&
      state.pid !== process.pid &&
      state.pid !== child.pid &&
      state.pid !== previousPid
    ) {
      try {
        const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return state;
      } catch {
        // Metadata can be published before the HTTP listener is ready.
      }
    }
    await delay(200);
  }
}

void (async () => {
  const first = await waitForReadyBackend();
  process.kill(first.pid, "SIGTERM");
  const recovered = await waitForReadyBackend(first.pid);
  if (recovered.port !== first.port) {
    throw new Error(`Backend endpoint changed during recovery: ${first.port} -> ${recovered.port}`);
  }
  restartVerified = true;
  console.log("Backend restarted on the original endpoint.");
  child.kill();
})().catch((error) => {
  recoveryFailure = error.message;
  child.kill();
});

function finish(exitCode) {
  rmSync(smokeHome, { recursive: true, force: true });
  process.exit(exitCode);
}

child.on("error", (error) => {
  clearTimeout(timeout);
  clearTimeout(forceExit);
  console.error("Desktop smoke test failed to launch:", error);
  finish(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  clearTimeout(forceExit);

  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
    "StartupError:",
  ];
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));
  if (!output.includes("Synara running")) failures.push("Backend did not report readiness");
  if (!restartVerified) failures.push(recoveryFailure ?? "Backend recovery was not verified");
  if (code !== 0 && signal !== "SIGTERM")
    failures.push(`Unexpected exit: code=${code} signal=${signal}`);

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    finish(1);
  }

  console.log("Desktop smoke test passed.");
  finish(0);
});
