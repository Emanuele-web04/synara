import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cuaRequest, type CuaReply } from "@synara/shared/cuaDriverProtocol";

import type { CuaDriverHost } from "./cuaDriverHost";
import { createLinuxCuaDriverHost } from "./linuxCuaDriverHost";

const capability = "linux-host-test-authority-0000000000000000";
const hosts: CuaDriverHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

async function fixture(
  isPackaged = false,
  inputMonitor?: Parameters<typeof createLinuxCuaDriverHost>[0]["inputMonitor"],
) {
  const missingRoot = join(tmpdir(), `synara-no-driver-${randomUUID()}`);
  const ownPids = new Set([process.pid]);
  const host = createLinuxCuaDriverHost({
    isPackaged,
    resourcesPath: missingRoot,
    appRoot: missingRoot,
    bundleId: "test.synara.linux",
    capability,
    ownPids: () => ownPids,
    ...(inputMonitor ? { inputMonitor } : {}),
  });
  hosts.push(host);
  return { endpoint: await host.listen(), ownPids };
}

describe("Linux desktop host startup", () => {
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
          task: { threadId: "linux-monitor-fixture", turnId },
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
      task: { threadId: "linux-monitor-fixture", turnId: "one" },
      capability,
    });
    expect(armed).toBe(true);
    await cuaRequest<CuaReply>(f.endpoint, {
      method: "end_task",
      task: { threadId: "linux-monitor-fixture", turnId: "two" },
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

  it("keeps newly created Synara helper PIDs protected without starting a driver", async () => {
    const f = await fixture();
    const helperPid = process.pid + 10_000;
    f.ownPids.add(helperPid);
    await expect(
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "browser_prepare",
        args: { pid: helperPid },
        task: { threadId: "linux-host-fixture", turnId: "turn" },
        capability,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { isError: true, structuredContent: { code: "browser_self_target" } },
    });
  });

  it("gives Linux session guidance instead of invoking macOS permission helpers", async () => {
    const f = await fixture();
    await expect(
      cuaRequest<CuaReply>(f.endpoint, { method: "setup", capability }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Start Synara inside your Linux desktop session"),
    });
  });
});
