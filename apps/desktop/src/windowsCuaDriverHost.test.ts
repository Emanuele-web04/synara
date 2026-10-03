import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cuaRequest, type CuaReply } from "@synara/shared/cuaDriverProtocol";

import type { CuaDriverHost } from "./cuaDriverHost";
import { createWindowsCuaDriverHost } from "./windowsCuaDriverHost";

const capability = "windows-host-test-authority-0000000000000000";
const hosts: CuaDriverHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

type WindowsHostOptions = Parameters<typeof createWindowsCuaDriverHost>[0];

function hostOptions(host: CuaDriverHost): {
  binaryPath: string;
  nativeRevision: number | null | undefined;
  inputMonitorState: () => { ready: boolean; error?: string };
} {
  return (host as unknown as { options: ReturnType<typeof hostOptions> }).options;
}

async function fixture(isPackaged = false, inputMonitor?: WindowsHostOptions["inputMonitor"]) {
  const missingRoot = join(tmpdir(), `synara-no-driver-${randomUUID()}`);
  const ownPids = new Set([process.pid]);
  const host = createWindowsCuaDriverHost({
    isPackaged,
    resourcesPath: missingRoot,
    appRoot: missingRoot,
    bundleId: "test.synara.windows",
    capability,
    ownPids: () => ownPids,
    ...(inputMonitor ? { inputMonitor } : {}),
  });
  hosts.push(host);
  return { host, endpoint: await host.listen(), ownPids };
}

describe("Windows desktop host startup", () => {
  it.each([false, true])(
    "points at the upstream cua-driver.exe artifact (packaged=%s)",
    (isPackaged) => {
      const root = join(tmpdir(), `synara-windows-driver-${randomUUID()}`);
      const ownPids = new Set([process.pid]);
      const host = createWindowsCuaDriverHost({
        isPackaged,
        resourcesPath: root,
        appRoot: root,
        bundleId: "test.synara.windows",
        capability,
        ownPids: () => ownPids,
      });
      hosts.push(host);
      const expected = isPackaged
        ? join(root, "cua-driver", "cua-driver.exe")
        : join(root, "apps/desktop/resources/cua-driver/cua-driver.exe");
      expect(hostOptions(host).binaryPath).toBe(expected);
    },
  );

  it("expects a provisioned upstream driver without a Synara native revision", () => {
    const root = join(tmpdir(), `synara-windows-driver-${randomUUID()}`);
    const ownPids = new Set([process.pid]);
    const host = createWindowsCuaDriverHost({
      isPackaged: false,
      resourcesPath: root,
      appRoot: root,
      bundleId: "test.synara.windows",
      capability,
      ownPids: () => ownPids,
    });
    hosts.push(host);
    expect(hostOptions(host).nativeRevision).toBeNull();
  });

  it("falls back to windows_global_escape_unavailable without an input monitor", () => {
    const root = join(tmpdir(), `synara-windows-driver-${randomUUID()}`);
    const ownPids = new Set([process.pid]);
    const host = createWindowsCuaDriverHost({
      isPackaged: false,
      resourcesPath: root,
      appRoot: root,
      bundleId: "test.synara.windows",
      capability,
      ownPids: () => ownPids,
    });
    hosts.push(host);
    expect(hostOptions(host).inputMonitorState()).toEqual({
      ready: false,
      error: "windows_global_escape_unavailable",
    });
  });

  it("connects task-scoped Escape activation and releases it after the final attributed task", async () => {
    let armed = false;
    const activate = vi.fn(async () => {
      armed = true;
    });
    const setArmed = vi.fn((value: boolean) => {
      armed = value;
    });
    const f = await fixture(false, {
      activate,
      setArmed,
      get state() {
        return { ready: armed };
      },
    });
    await cuaRequest<CuaReply>(f.endpoint, { method: "probe", capability });
    expect(activate).not.toHaveBeenCalled();
    expect(armed).toBe(false);
    for (const turnId of ["one", "two"]) {
      // The protected PID refuses before a missing driver could be spawned;
      // the request still exercises the host's attributed task lifecycle.
      await expect(
        cuaRequest<CuaReply>(f.endpoint, {
          method: "call",
          name: "browser_prepare",
          args: { pid: process.pid, allow_launch: true },
          task: { threadId: "windows-monitor-fixture", turnId },
          capability,
        }),
      ).resolves.toMatchObject({
        ok: true,
        result: { isError: true, structuredContent: { code: "browser_self_target" } },
      });
    }
    expect(activate).toHaveBeenCalledTimes(2);
    expect(armed).toBe(true);
    await cuaRequest<CuaReply>(f.endpoint, {
      method: "end_task",
      task: { threadId: "windows-monitor-fixture", turnId: "one" },
      capability,
    });
    expect(armed).toBe(true);
    await cuaRequest<CuaReply>(f.endpoint, {
      method: "end_task",
      task: { threadId: "windows-monitor-fixture", turnId: "two" },
      capability,
    });
    expect(armed).toBe(false);
    expect(setArmed).toHaveBeenLastCalledWith(false);
  });

  it.each([false, true])(
    "keeps the authenticated host available with an actionable missing-driver response (packaged=%s)",
    async (isPackaged) => {
      const f = await fixture(isPackaged);
      const result = await cuaRequest<CuaReply>(f.endpoint, { method: "probe", capability });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("provisioning") });
      // A missing optional Computer artifact must not reject desktop/server
      // startup or prevent the app from displaying its unavailable state.
      await expect(
        cuaRequest<CuaReply>(f.endpoint, { method: "probe", capability: "not-the-capability" }),
      ).resolves.toMatchObject({ ok: false });
    },
  );

  it("resolves setup without the macOS permission guide or Linux session guidance", async () => {
    const f = await fixture();
    await expect(
      cuaRequest<CuaReply>(f.endpoint, { method: "setup", capability }),
    ).resolves.toMatchObject({ ok: true });
  });
});
