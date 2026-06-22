import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const electronBin = resolve(desktopDir, "node_modules/.bin/electron");
const mainJs = resolve(desktopDir, "dist-electron/main.js");

console.log("\nLaunching Electron smoke test...");

const canKillProcessGroup = process.platform !== "win32";
const child = spawn(electronBin, [mainJs], {
  detached: canKillProcessGroup,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "",
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

let finished = false;
let forceKillTimeout;

function isNoSuchProcessError(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function killChild(signal) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (canKillProcessGroup) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      throw error;
    }
  }
}

function finish() {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timeout);
  clearTimeout(forceKillTimeout);

  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ];
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    process.exit(1);
  }

  console.log("Desktop smoke test passed.");
  process.exit(0);
}

const timeout = setTimeout(() => {
  killChild("SIGTERM");
  forceKillTimeout = setTimeout(() => {
    killChild("SIGKILL");
    finish();
  }, 2_000);
}, 8_000);

child.on("exit", finish);
