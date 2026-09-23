import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectRunningHyprlandVersion,
  hyprlandInstanceEnvironment,
  hyprlandInstancePresent,
  hyprlandInstanceSignature,
  hyprlandSessionPresent,
  makeHyprctlRunner,
  socketAcceptsConnections,
  listLoadedHyprlandPlugins,
  loadHyprlandPlugin,
  resolveHyprlandInstance,
  resolveLiveHyprlandInstance,
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

const socket = (signature: string) => `/run/user/1000/hypr/${signature}/.socket.sock`;

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

  it("follows the instance that replaced a dead inherited one, and only an unambiguous one", async () => {
    const env = { HYPRLAND_INSTANCE_SIGNATURE: "old", XDG_RUNTIME_DIR: "/run/user/1000" };
    let live = new Set(["old"]);
    let listed = ["old"];
    const resolve = () =>
      resolveLiveHyprlandInstance({
        env,
        connects: (path) => [...live].some((signature) => socket(signature) === path),
        listInstances: async () => listed,
      });

    expect(await resolve()).toBe("old");
    // Hyprland restarted: the old directory lingers, a new instance is live.
    live = new Set(["new"]);
    listed = ["old", "new", "../escape"];
    expect(await resolve()).toBe("new");
    // Two candidates is a guess this module does not make, and not "none".
    live = new Set(["new", "other"]);
    listed = ["old", "new", "other"];
    expect(await resolve()).toBeUndefined();
    await expect(
      resolveHyprlandInstance({
        env,
        connects: (path) => [...live].some((signature) => socket(signature) === path),
        listInstances: async () => listed,
      }),
    ).resolves.toEqual({ kind: "ambiguous", candidates: ["new", "other"] });
    live = new Set();
    expect(await resolve()).toBeUndefined();

    // A pinned instance never falls back to another one.
    live = new Set(["new"]);
    listed = ["old", "new"];
    expect(
      await resolveLiveHyprlandInstance({
        env: { ...env, SYNARA_HYPRLAND_INSTANCE_SIGNATURE: "nested" },
        connects: (path) => path === socket("new"),
        listInstances: async () => listed,
      }),
    ).toBeUndefined();
    // Nor does a process that was never started inside a Hyprland session.
    expect(
      await resolveLiveHyprlandInstance({
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
        connects: () => true,
        listInstances: async () => listed,
      }),
    ).toBeUndefined();
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

/** Reads the named files, and fails like a missing file for any other path. */
function locks(files: Record<string, string>) {
  return async (path: string) => {
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return content;
  };
}

describe("hyprlandInstanceEnvironment", () => {
  const env = {
    XDG_RUNTIME_DIR: "/run/user/1000",
    HYPRLAND_INSTANCE_SIGNATURE: "old",
    WAYLAND_DISPLAY: "wayland-1",
    DISPLAY: ":0",
  };
  it("keeps the inherited display for the instance this process was started in", async () => {
    const read = locks({ "/run/user/1000/hypr/old/hyprland.lock": "1789\nwayland-1\n" });
    await expect(hyprlandInstanceEnvironment("old", env, read)).resolves.toEqual({
      HYPRLAND_INSTANCE_SIGNATURE: "old",
      WAYLAND_DISPLAY: "wayland-1",
    });
  });

  it("points at the socket of the instance that replaced it, and drops the dead Xwayland", async () => {
    const read = locks({ "/run/user/1000/hypr/new/hyprland.lock": "2042\nwayland-2\n" });
    await expect(hyprlandInstanceEnvironment("new", env, read)).resolves.toEqual({
      HYPRLAND_INSTANCE_SIGNATURE: "new",
      WAYLAND_DISPLAY: "wayland-2",
      DISPLAY: undefined,
    });
  });

  it("refuses another instance whose socket its lock does not name", async () => {
    // A pinned dev-test instance whose lock cannot be read: neither the
    // inherited socket nor none at all (a client without WAYLAND_DISPLAY
    // connects to wayland-0, usually the human's session), but a refusal.
    for (const read of [
      locks({}),
      locks({ "/run/user/1000/hypr/new/hyprland.lock": "1\n../x\n" }),
      locks({ "/run/user/1000/hypr/new/hyprland.lock": "1\n" }),
    ]) {
      await expect(hyprlandInstanceEnvironment("new", env, read)).rejects.toMatchObject({
        retryable: true,
        message: expect.stringContaining("could not be read"),
      });
    }
  });
});

describe("makeHyprctlRunner", () => {
  /** A stand-in `hyprctl` on PATH: the wiring under test is the argv it gets. */
  async function withFakeHyprctl<T>(body: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "synara-hyprctl-"));
    const script = join(directory, "hyprctl");
    // Exits 0 whatever it is asked, like the real one does for any reply.
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

  it("runs nothing when there is no instance to name", async () => {
    await withFakeHyprctl(async () => {
      // Left to hyprctl, an unnamed call goes to whichever instance its own
      // environment lookup finds, which can be the human's.
      await expect(makeHyprctlRunner({ env: {} })(["plugin", "list"])).rejects.toThrow(
        "no live Hyprland instance",
      );
      await expect(
        makeHyprctlRunner({ signature: () => undefined })(["plugin", "list"]),
      ).rejects.toThrow("was not run");
    });
  });

  it("asks a signature function on every call", async () => {
    await withFakeHyprctl(async () => {
      let current = "first";
      const run = makeHyprctlRunner({ signature: () => current });
      expect((await run(["version"])).split("\n")[1]).toBe("first");
      current = "second";
      expect((await run(["version"])).split("\n")[1]).toBe("second");
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
