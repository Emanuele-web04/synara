// Runs only on the disposable interactive Windows CI desktop.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, globalShortcut } from "electron";
import { cuaRequest, type CuaReply } from "../../packages/shared/src/cuaDriverProtocol";
import { createWindowsCuaDriverHost } from "../../apps/desktop/src/windowsCuaDriverHost";
import { WindowsEscapeKillSwitchMonitor } from "../../apps/desktop/src/windowsEscapeKillSwitchMonitor";
import { ESCAPE_INPUT_COOLDOWN_MS } from "../../apps/desktop/src/cuaDriverHost";
import release from "../../packages/shared/src/cuaDriverRelease.json";

app.on("window-all-closed", () => {});
type State = { pid: number; window_id: number; text: string; left: boolean; shift: boolean };
async function eventually(check: () => Promise<boolean> | boolean, description: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    assert(Date.now() < deadline, description);
    await delay(25);
  }
}
function successful(reply: CuaReply, name: string) {
  assert(reply.ok && !reply.result?.isError, name + ": " + JSON.stringify(reply));
  return reply;
}
async function main() {
  assert.equal(process.platform, "win32");
  assert(process.env.CUA_WINDOWS_SMOKE_BINARY);
  await app.whenReady();
  const root = await mkdtemp(join(tmpdir(), "synara-windows-smoke-"));
  await mkdir(join(root, "cua-driver"));
  await copyFile(process.env.CUA_WINDOWS_SMOKE_BINARY, join(root, "cua-driver", "cua-driver.exe"));
  const fixture = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-STA",
      "-File",
      resolve(".github/scripts/cua-windows-fixture.ps1"),
      "-Directory",
      root,
    ],
    { stdio: "inherit" },
  );
  const fixtureExited = new Promise<void>((resolve) => fixture.once("exit", () => resolve()));
  let state: State | undefined;
  const readState = async () => {
    try {
      state = JSON.parse(await readFile(join(root, "state.json"), "utf8")) as State;
    } catch {
      /* The fixture may be replacing its snapshot. */
    }
    return state;
  };
  const capability = randomUUID() + randomUUID();
  const task = { threadId: "windows-smoke", turnId: "one" };
  let escaped = 0;
  const monitor = new WindowsEscapeKillSwitchMonitor({
    shortcutRegistry: globalShortcut,
    onEscape: () => {
      escaped++;
      host.emergencyStopInput();
    },
  });
  const host = createWindowsCuaDriverHost({
    isPackaged: true,
    resourcesPath: root,
    appRoot: root,
    bundleId: "test.synara.windows.smoke",
    capability,
    ownPids: () => new Set([process.pid]),
    inputMonitor: monitor,
  });
  try {
    await eventually(
      async () => !!(await readState())?.window_id,
      "WinForms fixture did not start",
    );
    assert(state);
    const target = { pid: state.pid, window_id: state.window_id };
    const endpoint = await host.listen();
    const call = (name: string, args: Record<string, unknown>, modelObservation = false) =>
      cuaRequest<CuaReply>(
        endpoint,
        { method: "call", name, args, task, capability, modelObservation },
        { timeoutMs: 35_000 },
      );
    const observation = successful(
      await call("get_window_state", target, true),
      "initial native observation",
    );
    assert.equal(observation.driverNativeRevision, release.nativeRevision);
    assert(monitor.state.ready && globalShortcut.isRegistered("Escape"));
    const typing = call("type_text", { ...target, text: "x".repeat(3000), delay_ms: 30 });
    await eventually(
      async () => ((await readState())?.text.length ?? 0) >= 3,
      "native text did not reach the target",
    );
    await writeFile(join(root, "command.txt"), "escape");
    await eventually(
      () => escaped > 0,
      "injected Windows Escape did not reach Electron globalShortcut",
    );
    const interrupted = await typing;
    assert(
      !interrupted.ok || interrupted.result?.isError,
      "interrupted text was reported successful",
    );
    const paused = await call("press_key", { ...target, key: "a" });
    assert.equal(paused.result?.structuredContent?.code, "computer_input_paused");
    await delay(ESCAPE_INPUT_COOLDOWN_MS + 100);
    const count = (await readState())!.text.length;
    assert(count < 3000, "Escape did not stop typing early");
    await delay(150);
    assert.equal((await readState())!.text.length, count, "input continued after Escape cleanup");
    successful(await call("get_window_state", target, true), "fresh observation after Escape");
    successful(await call("type_text", { ...target, text: "fresh", delay_ms: 10 }), "fresh typing");
    await eventually(
      async () => !!(await readState())?.text.includes("fresh"),
      "fresh input did not reach the fixture",
    );

    const drag = call("drag", {
      ...target,
      from_x: 100,
      from_y: 100,
      to_x: 300,
      to_y: 150,
      duration_ms: 5000,
      steps: 200,
      delivery_mode: "foreground",
    });
    await eventually(
      async () => !!(await readState())?.left,
      "native drag never pressed its button",
    );
    successful(await cuaRequest<CuaReply>(endpoint, { method: "stop", task, capability }), "Stop");
    const stopped = await drag;
    assert(!stopped.ok || stopped.result?.isError, "stopped drag was reported successful");
    await eventually(async () => {
      const value = await readState();
      return !!value && !value.left && !value.shift;
    }, "Stop left mouse or modifier held");
    await cuaRequest(endpoint, { method: "end_task", task, capability });
    await eventually(
      () => !globalShortcut.isRegistered("Escape"),
      "task end did not release Escape",
    );
    console.info(
      "WINDOWS_HOST_SMOKE_OK " +
        JSON.stringify({
          nativeRevision: release.nativeRevision,
          partialText: count,
          injectedEscape: escaped,
          freshInput: true,
          stopReleasedDrag: true,
          taskReleasedEscape: true,
        }),
    );
  } finally {
    try {
      await host.dispose();
    } finally {
      monitor.dispose();
      await writeFile(join(root, "command.txt"), "close");
      await Promise.race([fixtureExited, delay(5000).then(() => fixture.kill())]);
      await rm(root, { recursive: true, force: true });
    }
  }
}
void main().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error);
    app.exit(1);
  },
);
