import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";
import waitOn from "wait-on";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";

const port = Number(process.env.ELECTRON_RENDERER_PORT ?? 5733);
const devServerUrl = `http://localhost:${port}`;
const requiredFiles = [
  "dist-electron/main.js",
  "dist-electron/preload.js",
  "../server/dist/index.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.js", "preload.js"]) },
  { directory: "../server/dist", files: new Set(["index.mjs"]) },
];
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;
const childTreeGracePeriodMs = 1_200;
const staleComputerUseGracePeriodMs = 300;

await waitOn({
  resources: [`tcp:${port}`, ...requiredFiles.map((filePath) => `file:${filePath}`)],
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
const watchers = [];

function killChildTreeByPid(pid, signal) {
  if (process.platform === "win32" || typeof pid !== "number") {
    return;
  }

  spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function cleanupStaleDevApps() {
  if (process.platform === "win32") {
    return;
  }

  spawnSync("pkill", ["-f", "--", `--t3code-dev-root=${desktopDir}`], { stdio: "ignore" });
}

function listStaleComputerUsePids() {
  if (process.platform === "win32") {
    return [];
  }

  const result = spawnSync("pgrep", ["-fal", "DP Code \\(Dev\\).*(computerUseMcp\\.mjs mcp)"], {
    encoding: "utf8",
  });
  const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const firstSpace = line.indexOf(" ");
      if (firstSpace <= 0) {
        return [];
      }

      const pid = Number(line.slice(0, firstSpace));
      const command = line.slice(firstSpace + 1);
      if (!Number.isInteger(pid) || pid <= 0) {
        return [];
      }

      // Leave the current worktree's helper alone and only reap stale runtimes
      // from other worktrees or abandoned dev sessions.
      if (command.includes(desktopDir)) {
        return [];
      }

      return [pid];
    });
}

function cleanupStaleComputerUseApps() {
  const stalePids = listStaleComputerUsePids();
  if (stalePids.length === 0) {
    return;
  }

  console.error(
    `[desktop-dev] Cleaning up ${stalePids.length} stale DP Code (Dev) Computer Use helper process${stalePids.length === 1 ? "" : "es"} from other worktrees.`,
  );

  for (const pid of stalePids) {
    spawnSync("kill", ["-TERM", String(pid)], { stdio: "ignore" });
  }

  spawnSync("sleep", [String(staleComputerUseGracePeriodMs / 1000)], { stdio: "ignore" });

  for (const pid of stalePids) {
    spawnSync("kill", ["-KILL", String(pid)], { stdio: "ignore" });
  }
}

function warnIfAlphaAppRunning() {
  if (process.platform === "win32") {
    return;
  }

  const result = spawnSync(
    "pgrep",
    ["-fal", "/Applications/DP Code \\(Alpha\\)\\.app/Contents/MacOS/DP Code \\(Alpha\\)"],
    { encoding: "utf8" },
  );
  const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!output) {
    return;
  }

  console.error(
    "[desktop-dev] DP Code (Alpha) is still running. Close it before testing voice in DP Code (Dev), or you may be looking at the wrong app/runtime.",
  );
  console.error(output);
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const app = spawn(
    resolveElectronPath(),
    [`--t3code-dev-root=${desktopDir}`, "dist-electron/main.js"],
    {
      cwd: desktopDir,
      env: {
        ...childEnv,
        VITE_DEV_SERVER_URL: devServerUrl,
      },
      stdio: "inherit",
    },
  );

  currentApp = app;

  app.once("error", () => {
    if (currentApp === app) {
      currentApp = null;
    }

    if (!shuttingDown) {
      scheduleRestart();
    }
  });

  app.once("exit", (code, signal) => {
    if (currentApp === app) {
      currentApp = null;
    }

    const exitedAbnormally = signal !== null || code !== 0;
    if (!shuttingDown && !expectedExits.has(app) && exitedAbnormally) {
      scheduleRestart();
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app);

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.once("exit", finish);
    app.kill("SIGTERM");
    killChildTreeByPid(app.pid, "TERM");

    setTimeout(() => {
      if (settled) {
        return;
      }

      app.kill("SIGKILL");
      killChildTreeByPid(app.pid, "KILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        if (!shuttingDown) {
          startApp();
        }
      });
  }, restartDebounceMs);
}

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = watch(
      join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !files.has(filename)) {
          return;
        }

        scheduleRestart();
      },
    );

    watchers.push(watcher);
  }
}

function killChildTree(signal) {
  if (process.platform === "win32") {
    return;
  }

  // Kill direct children as a final fallback in case normal shutdown leaves stragglers.
  spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], { stdio: "ignore" });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  await stopApp();
  killChildTree("TERM");
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  killChildTree("KILL");

  process.exit(exitCode);
}

startWatchers();
cleanupStaleDevApps();
cleanupStaleComputerUseApps();
warnIfAlphaAppRunning();
startApp();

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
