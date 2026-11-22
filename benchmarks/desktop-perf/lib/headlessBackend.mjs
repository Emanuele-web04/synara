// Starts only the backend of a source build (the Electron-as-Node runtime and bundle the
// desktop app spawns) in web mode on an isolated data home. It serves the production web
// bundle, so a headless browser can drive the real client without a desktop window.
import { spawn } from "node:child_process";
import { join } from "node:path";

import { sleep } from "./cdp.mjs";
import { assertIsolatedHome, freePort, resolveElectronBinary } from "./launch.mjs";

export async function bootHeadlessBackend(build, home, { extraArgs = [], extraEnv = {} } = {}) {
  assertIsolatedHome(home);
  const port = await freePort();
  const child = spawn(
    resolveElectronBinary(build.dir),
    [...extraArgs, join(build.dir, "apps/server/dist/index.mjs")],
    {
      cwd: join(build.dir, "apps/server"),
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        USER: process.env.USER,
        TMPDIR: process.env.TMPDIR,
        LANG: "en_US.UTF-8",
        ELECTRON_RUN_AS_NODE: "1",
        SYNARA_HOME: home,
        SYNARA_PORT: String(port),
        SYNARA_MODE: "web",
        SYNARA_NO_BROWSER: "1",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  const onData = (chunk) => (log += chunk);
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const state = { exited: false };
  child.on("exit", () => (state.exited = true));
  const startedAt = performance.now();
  let ready = false;
  while (!state.exited && performance.now() - startedAt < 120_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.startupReady !== false) {
          ready = true;
          break;
        }
      }
    } catch {
      // Not listening yet.
    }
    await sleep(50);
  }
  const stop = async () => {
    child.kill("SIGTERM");
    for (let index = 0; index < 100 && !state.exited; index += 1) await sleep(100);
    if (!state.exited) child.kill("SIGKILL");
  };
  if (!ready) {
    await stop();
    throw new Error(`backend did not become ready:\n${log.slice(-2000)}`);
  }
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop,
    log: () => log,
    bootMs: Math.round(performance.now() - startedAt),
  };
}
