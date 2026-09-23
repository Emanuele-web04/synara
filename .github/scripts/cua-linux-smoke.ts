// Component smoke on a disposable Xvfb desktop, never a user's session.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, globalShortcut } from "electron";
import { cuaRequest, type CuaReply } from "../../packages/shared/src/cuaDriverProtocol";
import { createLinuxCuaDriverHost } from "../../apps/desktop/src/linuxCuaDriverHost";
import {
  LinuxEscapeKillSwitchMonitor,
  linuxEscapeSession,
} from "../../apps/desktop/src/linuxEscapeKillSwitchMonitor";
import release from "../../packages/shared/src/cuaDriverRelease.json";

app.on("window-all-closed", () => {});

async function eventually(check: () => boolean, description: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert(Date.now() < deadline, description);
    await delay(25);
  }
}

function successful(reply: CuaReply, name: string): Record<string, unknown> {
  assert(
    reply.ok &&
      !reply.result?.isError &&
      reply.result?.structuredContent?.status !== "refused" &&
      reply.result?.structuredContent?.effect !== "refused",
    name + ": " + JSON.stringify(reply),
  );
  return reply.result?.structuredContent ?? {};
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

async function main() {
  assert.equal(process.platform, "linux");
  const binary = process.env.CUA_LINUX_SMOKE_BINARY;
  assert(binary, "CUA_LINUX_SMOKE_BINARY is required");
  await app.whenReady();
  assert.equal(linuxEscapeSession(), "x11", "smoke requires a direct disposable X11 session");

  const root = await mkdtemp(join(tmpdir(), "synara-linux-smoke-"));
  await mkdir(join(root, "cua-driver"));
  await symlink(binary, join(root, "cua-driver", "cua-driver"));
  const capability = randomUUID() + randomUUID();
  const task = { threadId: "linux-smoke", turnId: "one" };
  let escaped = 0;
  let clicks = 0;
  let input = "";
  const page =
    "<!doctype html><title>Linux Cua smoke</title><button onclick=\"fetch('/clicked')\">Increment</button><input aria-label=\"Probe input\" oninput=\"fetch('/typed',{method:'POST',body:this.value})\">";
  const server = createServer((request, response) => {
    if (request.url === "/clicked") {
      clicks++;
      response.end("ok");
    } else if (request.url === "/typed") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        input = body;
        response.end("ok");
      });
    } else {
      response.setHeader("content-type", "text/html");
      response.end(page);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const url = "http://127.0.0.1:" + address.port + "/";
  const monitor = new LinuxEscapeKillSwitchMonitor({
    shortcutRegistry: globalShortcut,
    sessionType: linuxEscapeSession(),
    onEscape: () => {
      escaped++;
      host.emergencyStopInput();
    },
  });
  const host = createLinuxCuaDriverHost({
    isPackaged: true,
    resourcesPath: root,
    appRoot: root,
    bundleId: "test.synara.linux.smoke",
    capability,
    ownPids: () => new Set([process.pid]),
    inputMonitor: monitor,
  });
  let browserPid: number | undefined;
  try {
    const endpoint = await host.listen();
    const call = (name: string, args: Record<string, unknown>) =>
      cuaRequest<CuaReply>(
        endpoint,
        { method: "call", name, args, task, capability },
        { timeoutMs: 35_000 },
      );
    const preparedReply = await call("browser_prepare", {
      allow_launch: true,
      profile: { mode: "isolated_new" },
    });
    const prepared = successful(preparedReply, "prepare");
    assert.equal(preparedReply.driverNativeRevision, release.nativeRevision);
    assert.equal(preparedReply.driverBrowserInputControl, true);
    assert.equal(prepared.action, "launched_isolated_browser", JSON.stringify(preparedReply));
    assert.equal(typeof prepared.prepared_pid, "number");
    browserPid = prepared.prepared_pid as number;
    assert(monitor.state.ready && globalShortcut.isRegistered("Escape"));

    const bound = successful(await call("get_browser_state", { pid: browserPid }), "bind");
    assert.equal(bound.binding_route, "driver_owned_headless");
    const tabs = bound.tabs as Array<{ tab_id: string }>;
    assert(tabs?.[0]?.tab_id);
    const target = { target_id: bound.target_id, tab_id: tabs[0].tab_id };
    successful(await call("browser_navigate", { ...target, url }), "navigate");
    const state = successful(
      await call("get_browser_state", { ...target, snapshot_format: "semantic_v2" }),
      "snapshot",
    );
    const clickRef = findRef(state, "Increment");
    const inputRef = findRef(state, "Probe input");
    assert(
      clickRef && inputRef,
      "fixture controls need observed DOM refs: " + JSON.stringify(state),
    );
    successful(await call("browser_click", { ...target, ref: clickRef }), "click");
    await eventually(() => clicks === 1, "HTTP observer did not receive exactly one click");
    const refreshed = successful(
      await call("get_browser_state", { ...target, snapshot_format: "semantic_v2" }),
      "fresh input ref",
    );
    const freshInputRef = findRef(refreshed, "Probe input");
    assert(freshInputRef);
    successful(
      await call("browser_type", {
        ...target,
        ref: freshInputRef,
        text: "linux-cua-probe",
        mode: "insert_text",
      }),
      "type",
    );
    await eventually(() => input === "linux-cua-probe", "HTTP observer did not see typed input");

    const refusedNative = await call("click", { pid: browserPid, window_id: 1, x: 10, y: 10 });
    assert(refusedNative.result?.isError, "Linux must refuse native pointer control");
    const refusedVisible = await call("browser_prepare", {
      allow_launch: true,
      windowed: true,
      profile: { mode: "isolated_new" },
    });
    assert(refusedVisible.result?.isError, "Linux must refuse visible browser launch");

    execFileSync("xdotool", ["key", "Escape"]);
    await eventually(() => escaped > 0, "real X11 Escape shortcut did not fire");
    const paused = await call("browser_click", { ...target, ref: freshInputRef });
    assert(paused.result?.isError, "Escape must pause subsequent browser mutation");
    assert.equal(paused.result?.structuredContent?.code, "computer_input_paused");
    assert.equal(clicks, 1);
    await cuaRequest(endpoint, { method: "end_task", task, capability });
    await eventually(
      () => !globalShortcut.isRegistered("Escape"),
      "task end did not release Escape",
    );
    console.info(
      "LINUX_SMOKE_OK " +
        JSON.stringify({
          nativeRevision: release.nativeRevision,
          headlessBinding: true,
          clickObserved: clicks,
          textObserved: input === "linux-cua-probe",
          nativeInputRefused: true,
          visibleLaunchRefused: true,
          injectedX11Escape: escaped,
          pausedMutation: true,
          taskEndReleasedEscape: true,
        }),
    );
  } finally {
    await host.dispose();
    monitor.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  if (browserPid) {
    await eventually(() => {
      try {
        process.kill(browserPid!, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }, "driver-owned browser survived host disposal");
    console.info("LINUX_SMOKE_CLEANUP_OK");
  }
}

void main().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error);
    app.exit(1);
  },
);
