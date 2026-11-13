#!/usr/bin/env node
// Bring a copied home into a steady state at its final path: one-time dialogs are keyed by the
// home path, so every copy shows the tour and announcements again. Launch, dismiss them, quit.
// usage: prep-home.mjs --app <worktree> --home <home> [--port 9350]
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { openSync, closeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const appDir = resolve(args.get("--app"));
const home = resolve(args.get("--home"));
const port = Number(args.get("--port") ?? "9350");
const desktopDir = join(appDir, "apps/desktop");
const electronPath = createRequire(join(desktopDir, "package.json"))("electron");
const { spawnSourceDesktop } = await import(join(desktopDir, "scripts/source-desktop-launch.mjs"));
const environment = {
  ...process.env,
  SYNARA_HOME: home,
  SYNARA_DESKTOP_FLAVOR: "dev",
  SYNARA_DESKTOP_SMOKE_USER_DATA: join(home, "electron-user-data"),
  SYNARA_DISABLE_AUTO_UPDATE: "1",
};
delete environment.VITE_DEV_SERVER_URL;
delete environment.SYNARA_AUTH_TOKEN;
delete environment.ELECTRON_RUN_AS_NODE;
const logFd = openSync(join(home, "prep.log"), "w");
const child = spawnSourceDesktop({
  desktopDirectory: desktopDir,
  electronPath,
  spawnProcess: (c, a, o) =>
    spawn(c, [...a, `--remote-debugging-port=${port}`], { ...o, detached: true }),
  stdio: ["ignore", logFd, logFd],
  environment,
});
closeSync(logFd);
let socket;
for (let i = 0; i < 400 && !socket; i += 1) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
    if (target) {
      socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((r) => socket.addEventListener("open", r, { once: true }));
    }
  } catch {}
  if (!socket) await delay(50);
}
let id = 0;
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const mine = ++id;
    const on = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== mine) return;
      socket.removeEventListener("message", on);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    };
    socket.addEventListener("message", on);
    socket.send(JSON.stringify({ id: mine, method, params }));
  });
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
const STATE = `(() => ({ editor: !!document.querySelector('[data-testid="composer-editor"]'), dialogs: [...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText.replace(/\\s+/g, " ").slice(0, 50)), hash: location.hash }))()`;
const CLICK = `(() => { const b = [...document.querySelectorAll("button")].find((b) => ["Skip intro", "Not now"].includes(b.textContent.trim())); b?.click(); return b ? b.textContent.trim() : null; })()`;
let quietSince = null,
  actions = [];
const start = performance.now();
while (performance.now() - start < 60000) {
  const state = await evaluate(STATE).catch(() => null);
  if (state?.editor && state.dialogs.length === 0) {
    if (quietSince === null) quietSince = performance.now();
    if (performance.now() - quietSince > 4000) break;
  } else if (state) {
    quietSince = null;
    if (state.dialogs.length > 0 || !state.editor) {
      const clicked = await evaluate(CLICK).catch(() => null);
      if (clicked) actions.push(clicked);
      else if (state.dialogs.length > 0) {
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        actions.push("Escape");
      }
    }
  }
  await delay(500);
}
const final = await evaluate(STATE);
socket.close();
await delay(1500);
process.kill(child.pid, "SIGTERM");
const alive = () => {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
};
for (let i = 0; i < 600 && alive(); i += 1) await delay(50);
console.log(
  JSON.stringify({
    home,
    actions,
    final,
    steady: final.editor && final.dialogs.length === 0,
    exitedCleanly: !alive(),
  }),
);
process.exitCode = final.editor && final.dialogs.length === 0 && !alive() ? 0 : 1;
