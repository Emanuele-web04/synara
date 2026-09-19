import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectRunningHyprlandVersion,
  hyprlandInstancePresent,
  hyprlandInstanceSignature,
  hyprlandSessionPresent,
  makeHyprctlRunner,
  socketAcceptsConnections,
  listLoadedHyprlandPlugins,
  loadHyprlandPlugin,
  unloadHyprlandPlugin,
  type HyprctlRunner,
} from "./hyprctl.ts";

function runner(replies: Record<string, string>): HyprctlRunner {
  return (args) => {
    const key = args.join(" ");
    const reply = replies[key];
    if (reply === undefined) return Promise.reject(new Error(`unexpected hyprctl ${key}`));
    return Promise.resolve(reply);
  };
}

describe("hyprlandSessionPresent", () => {
  it("refuses a stale socket inode left by a crashed compositor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "synara-socket-"));
    const path = join(directory, "socket");
    const child = spawn(process.execPath, [
      "-e",
      "require('node:net').createServer(s=>s.end()).listen(process.argv[1],()=>process.stdout.write('ready'))",
      path,
    ]);
    try {
      await once(child.stdout!, "data");
      expect(await socketAcceptsConnections(path)).toBe(true);
      const exited = once(child, "close");
      child.kill("SIGKILL");
      await exited;
      expect((await stat(path)).isSocket()).toBe(true);
      expect(await socketAcceptsConnections(path)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("needs the signature, the runtime dir, and the live socket together", async () => {
    const env = { HYPRLAND_INSTANCE_SIGNATURE: "sig1", XDG_RUNTIME_DIR: "/run/user/1000" };
    const socket = "/run/user/1000/hypr/sig1/.socket.sock";

    expect(await hyprlandSessionPresent(env, (path) => path === socket)).toBe(true);
    // The signature outlives a crashed compositor; the socket is the liveness check.
    expect(await hyprlandSessionPresent(env, () => false)).toBe(false);
    expect(await hyprlandSessionPresent({ XDG_RUNTIME_DIR: "/run/user/1000" }, () => true)).toBe(
      false,
    );
    expect(await hyprlandSessionPresent({ HYPRLAND_INSTANCE_SIGNATURE: "sig1" }, () => true)).toBe(
      false,
    );
  });

  it("follows the Synara override so dev-testing never lands on the inherited session", async () => {
    const env = {
      HYPRLAND_INSTANCE_SIGNATURE: "human",
      SYNARA_HYPRLAND_INSTANCE_SIGNATURE: "nested",
      XDG_RUNTIME_DIR: "/run/user/1000",
    };

    expect(hyprlandInstanceSignature(env)).toBe("nested");
    const probed: string[] = [];
    await hyprlandSessionPresent(env, (path) => {
      probed.push(path);
      return true;
    });
    expect(probed).toEqual(["/run/user/1000/hypr/nested/.socket.sock"]);
  });

  it("rejects a signature that could escape the runtime directory", async () => {
    const env = { XDG_RUNTIME_DIR: "/run/user/1000" };

    expect(
      hyprlandInstanceSignature({ ...env, HYPRLAND_INSTANCE_SIGNATURE: "../.." }),
    ).toBeUndefined();
    expect(await hyprlandInstancePresent("../../../etc", env, () => true)).toBe(false);
    expect(await hyprlandInstancePresent("a/b", env, () => true)).toBe(false);
    expect(await hyprlandInstancePresent("nested", env, () => true)).toBe(true);
  });
});

describe("makeHyprctlRunner", () => {
  /** A stand-in `hyprctl` on PATH: the wiring under test is the argv it gets. */
  async function withFakeHyprctl<T>(body: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "synara-hyprctl-"));
    const script = join(directory, "hyprctl");
    // Exits 0 whatever it is asked, exactly like the real one.
    await writeFile(script, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\nexit 0\n');
    await chmod(script, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ""}`;
    try {
      return await body(directory);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("addresses the named instance with -i before the command", async () => {
    await withFakeHyprctl(async () => {
      const run = makeHyprctlRunner({ signature: "nested-sig" });
      expect((await run(["-j", "version"])).split("\n").filter(Boolean)).toEqual([
        "-i",
        "nested-sig",
        "-j",
        "version",
      ]);
    });
  });

  it("takes the instance from the Synara override when no signature is passed", async () => {
    await withFakeHyprctl(async () => {
      const run = makeHyprctlRunner({
        env: { HYPRLAND_INSTANCE_SIGNATURE: "human", SYNARA_HYPRLAND_INSTANCE_SIGNATURE: "nested" },
      });
      expect((await run(["plugin", "list"])).split("\n").filter(Boolean)).toEqual([
        "-i",
        "nested",
        "plugin",
        "list",
      ]);
    });
  });

  it("lets hyprctl resolve the instance itself when the environment names none", async () => {
    await withFakeHyprctl(async () => {
      const run = makeHyprctlRunner({ env: {} });
      expect((await run(["plugin", "list"])).split("\n").filter(Boolean)).toEqual([
        "plugin",
        "list",
      ]);
    });
  });
});

describe("listLoadedHyprlandPlugins", () => {
  it("reads names out of the JSON plugin list", async () => {
    const run = runner({
      "-j plugin list": JSON.stringify([
        { name: "synara-computer-use", author: "Synara", handle: "0x1", version: "0.1" },
        { name: "hyprbars" },
      ]),
    });

    await expect(listLoadedHyprlandPlugins(run)).resolves.toEqual([
      { name: "synara-computer-use" },
      { name: "hyprbars" },
    ]);
  });

  it("treats an unparseable reply as an empty list rather than failing", async () => {
    const run = runner({ "-j plugin list": "no plugins loaded" });

    await expect(listLoadedHyprlandPlugins(run)).resolves.toEqual([]);
  });
});

describe("loadHyprlandPlugin", () => {
  it("succeeds only on the literal ok reply — hyprctl always exits 0", async () => {
    const path = "/home/user/plug.so";
    const okRun = runner({ [`plugin load ${path}`]: "ok\n" });
    const refusingRun = runner({
      [`plugin load ${path}`]: `Plugin ${path} could not be loaded: API version mismatch`,
    });

    await expect(loadHyprlandPlugin(okRun, path)).resolves.toEqual({ ok: true, message: "ok" });
    const refused = await loadHyprlandPlugin(refusingRun, path);
    expect(refused.ok).toBe(false);
    // Hyprland's own reason is the whole value of the reply; it must survive.
    expect(refused.message).toContain("API version mismatch");
  });
});

describe("unloadHyprlandPlugin", () => {
  it("maps ok and not-loaded onto the KWin unload contract", async () => {
    const path = "/home/user/plug.so";

    await expect(
      unloadHyprlandPlugin(runner({ [`plugin unload ${path}`]: "ok" }), path),
    ).resolves.toBe(true);
    await expect(
      unloadHyprlandPlugin(runner({ [`plugin unload ${path}`]: "plugin not loaded" }), path),
    ).resolves.toBe(false);
    await expect(
      unloadHyprlandPlugin(runner({ [`plugin unload ${path}`]: "something exploded" }), path),
    ).rejects.toThrow("something exploded");
  });
});

describe("detectRunningHyprlandVersion", () => {
  it("reads the version field and answers undefined for anything else", async () => {
    await expect(
      detectRunningHyprlandVersion(
        runner({ "-j version": '{"version":"0.56.2","tag":"v0.56.2"}' }),
      ),
    ).resolves.toBe("0.56.2");
    await expect(
      detectRunningHyprlandVersion(runner({ "-j version": "not json" })),
    ).resolves.toBeUndefined();
    await expect(detectRunningHyprlandVersion(runner({}))).resolves.toBeUndefined();
  });
});
