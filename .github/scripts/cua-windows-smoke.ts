// Runs only on the disposable interactive Windows CI desktop.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app } from "electron";
import { cuaRequest, type CuaReply } from "../../packages/shared/src/cuaDriverProtocol";
import { createWindowsCuaDriverHost } from "../../apps/desktop/src/windowsCuaDriverHost";
import { EscapeKillSwitchMonitor } from "../../apps/desktop/src/escapeKillSwitchMonitor";
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
  assert(
    reply.ok &&
      !reply.result?.isError &&
      reply.result?.structuredContent?.status !== "refused" &&
      reply.result?.structuredContent?.effect !== "refused",
    name + ": " + JSON.stringify(reply),
  );
  return reply;
}
function findRef(value: unknown, name: string): string | undefined {
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (object.name === name && typeof object.ref === "string") return object.ref;
  for (const child of Object.values(object)) {
    const ref = findRef(child, name);
    if (ref) return ref;
  }
}
async function browserSmoke(
  call: (name: string, args: Record<string, unknown>, observation?: boolean) => Promise<CuaReply>,
  escape: () => Promise<void>,
) {
  let text = "";
  let presses = 0;
  let releases = 0;
  const server = createServer((request, response) => {
    if (request.url === "/down") {
      presses++;
      response.end("ok");
    } else if (request.url === "/up") {
      releases++;
      response.end("ok");
    } else if (request.url === "/text") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        text = body;
        response.end("ok");
      });
    } else {
      response.setHeader("content-type", "text/html");
      response.end(
        `<!doctype html><title>Windows Cua browser fixture</title><input aria-label="Probe input" onkeydown="fetch('/down')" onkeyup="fetch('/up')" oninput="fetch('/text',{method:'POST',body:this.value})">`,
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const prepared = successful(
      await call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } }),
      "prepare browser",
    ).result?.structuredContent;
    assert(prepared && typeof prepared.prepared_pid === "number", JSON.stringify(prepared));
    const bound = successful(
      await call("get_browser_state", { pid: prepared.prepared_pid }),
      "bind browser",
    ).result?.structuredContent;
    assert(bound);
    const tabs = bound.tabs as Array<{ tab_id: string }>;
    assert(tabs?.[0]?.tab_id);
    const target = { target_id: bound.target_id, tab_id: tabs[0].tab_id };
    successful(
      await call("get_browser_state", { ...target, snapshot_format: "semantic_v2" }, true),
      "observe prepared browser before navigation",
    );
    successful(
      await call("browser_navigate", { ...target, url: `http://127.0.0.1:${address.port}/` }),
      "navigate fixture",
    );
    const snapshot = successful(
      await call("get_browser_state", { ...target, snapshot_format: "semantic_v2" }, true),
      "observe browser",
    ).result?.structuredContent;
    const ref = findRef(snapshot, "Probe input");
    assert(ref, JSON.stringify(snapshot));
    const typing = call("browser_type", {
      ...target,
      ref,
      mode: "keystrokes",
      text: "z".repeat(1000),
    });
    await eventually(
      () => text.length > 0 && presses > 0,
      "real browser did not receive key input",
    );
    await escape();
    const interrupted = await typing;
    assert(
      !interrupted.ok || interrupted.result?.isError,
      "interrupted browser typing reported success",
    );
    await delay(ESCAPE_INPUT_COOLDOWN_MS + 150);
    const count = text.length;
    assert(count < 1000, "Escape did not stop browser typing early");
    await eventually(() => releases === presses, "browser key-down was not paired with key-up");
    await delay(100);
    assert.equal(text.length, count, "browser input continued after cleanup");
    const fresh = successful(
      await call("get_browser_state", { ...target, snapshot_format: "semantic_v2" }, true),
      "fresh browser observation",
    ).result?.structuredContent;
    const freshRef = findRef(fresh, "Probe input");
    assert(freshRef);
    successful(
      await call("browser_type", {
        ...target,
        ref: freshRef,
        text: "recovered",
        mode: "insert_text",
      }),
      "fresh browser input",
    );
    await eventually(() => text.includes("recovered"), "browser did not accept fresh input");
    console.info(
      "WINDOWS_BROWSER_SMOKE_OK " +
        JSON.stringify({ interruptedChars: count, presses, releases, recovered: true }),
    );
    return prepared.prepared_pid;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main() {
  assert.equal(process.platform, "win32");
  assert(process.env.CUA_WINDOWS_SMOKE_BINARY);
  await app.whenReady();
  // A cleanup deadlock must fail this disposable CI process, not consume the
  // entire job timeout and hide the original diagnostic from subsequent steps.
  const watchdog = setTimeout(() => {
    console.error("WINDOWS_HOST_SMOKE_TIMEOUT: input or teardown did not finish in 120 seconds");
    app.exit(1);
  }, 120_000);
  watchdog.unref();
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
  let task = { threadId: "windows-smoke", turnId: "one" };
  let escaped = 0;
  const monitor = new EscapeKillSwitchMonitor({
    helperPath: join(root, "cua-driver", "cua-driver.exe"),
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
    assert(monitor.state.ready);
    const typing = call("type_text", { ...target, text: "x".repeat(3000), delay_ms: 30 });
    await eventually(
      async () => ((await readState())?.text.length ?? 0) >= 3,
      "native text did not reach the target",
    );
    await writeFile(join(root, "command.txt"), "escape");
    await eventually(() => escaped > 0, "injected Windows Escape did not reach the native monitor");
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
    const revoked = await call("type_text", { ...target, text: "must not arrive" });
    assert(!revoked.ok && revoked.effect === "not-dispatched", "Stop did not revoke the turn");
    task = { ...task, turnId: "browser" };
    await browserSmoke(call, () => writeFile(join(root, "command.txt"), "escape"));
    await cuaRequest(endpoint, { method: "end_task", task, capability });
    await eventually(() => !monitor.state.ready, "task end did not release Escape");
    const disposalTask = { ...task, turnId: "disposal" };
    const disposalCall = (name: string, args: Record<string, unknown>, modelObservation = false) =>
      cuaRequest<CuaReply>(
        endpoint,
        { method: "call", name, args, task: disposalTask, capability, modelObservation },
        { timeoutMs: 35_000 },
      );
    successful(await disposalCall("get_window_state", target, true), "observe before disposal");
    const disposingDrag = disposalCall("drag", {
      ...target,
      from_x: 100,
      from_y: 100,
      to_x: 300,
      to_y: 150,
      duration_ms: 5000,
      steps: 200,
      delivery_mode: "foreground",
    });
    await eventually(async () => !!(await readState())?.left, "drag never began before disposal");
    await host.dispose();
    await disposingDrag;
    await eventually(
      async () => !(await readState())?.left,
      "host disposal left its mouse button held",
    );
    console.info(
      "WINDOWS_HOST_SMOKE_OK " +
        JSON.stringify({
          nativeRevision: release.nativeRevision,
          partialText: count,
          injectedEscape: escaped,
          freshInput: true,
          stopReleasedDrag: true,
          disposalReleasedDrag: true,
          taskReleasedEscape: true,
        }),
    );
  } catch (error) {
    console.error("WINDOWS_HOST_SMOKE_FAILURE", error);
    throw error;
  } finally {
    try {
      await host.dispose();
    } finally {
      monitor.dispose();
      await writeFile(join(root, "command.txt"), "close");
      await Promise.race([fixtureExited, delay(5000).then(() => fixture.kill())]);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      clearTimeout(watchdog);
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
