import { describe, expect, it } from "vitest";

import { createSessionHyprlandComputerDbus } from "./hyprlandPluginHost.ts";
import type { ComputerSessionBus, KWinComputerPluginApi } from "./kwinDbus.ts";
import type { HyprctlRunner } from "./hyprctl.ts";

const PLUGIN_DIR = "/home/user/.local/share/synara/hyprland-computer-use/plugins";

function fakeBus(healthJson?: () => Promise<unknown>): ComputerSessionBus {
  const api = { healthJson: healthJson ?? (() => Promise.reject(new Error("no plugin"))) };
  return {
    getProxyObject: () => Promise.reject(new Error("unused")),
    nameOwner: () => Promise.resolve(undefined),
    connectPlugin: () => Promise.resolve(api as unknown as KWinComputerPluginApi),
    onDisconnect: () => () => undefined,
    // The adapter under test passes both straight through to the engine; the
    // fake only has to exist for them.
    pingOwner: () => Promise.resolve(true),
    onServiceOwnerChanged: () => () => undefined,
    close: () => Promise.resolve(),
  };
}

function recordingRunner(replies: Record<string, string>) {
  const calls: string[] = [];
  const run: HyprctlRunner = (args) => {
    const key = args.join(" ");
    calls.push(key);
    const reply = replies[key];
    if (reply === undefined) return Promise.reject(new Error(`unexpected hyprctl ${key}`));
    return Promise.resolve(reply);
  };
  return { run, calls };
}

const LOADED_LIST = JSON.stringify([{ name: "synara-computer-use" }, { name: "hyprbars" }]);

describe("createSessionHyprlandComputerDbus", () => {
  it("maps the loaded plugin name onto its generation id via healthJson's modulePath", async () => {
    const { run } = recordingRunner({ "-j plugin list": LOADED_LIST });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () =>
        Promise.resolve(
          fakeBus(() =>
            Promise.resolve(
              JSON.stringify({
                ok: true,
                modulePath: `${PLUGIN_DIR}/SynaraComputerUsePluginV7.so`,
              }),
            ),
          ),
        ),
      fileExists: () => true,
    });

    // The foreign plugin passes through untouched; the base engine's id filter
    // ignores it.
    await expect(dbus.listLoadedPluginIds()).resolves.toEqual([
      "SynaraComputerUsePluginV7",
      "hyprbars",
    ]);
  });

  it("falls back to the versionless id when the loaded build cannot say what it is", async () => {
    // A bare id is generation 0, which every installed V<n> outranks — so the
    // engine plans a replace and the unknown build gets swapped for a current
    // one, which is the right recovery for a build too old or broken to answer.
    const { run } = recordingRunner({ "-j plugin list": LOADED_LIST });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () => Promise.resolve(fakeBus()),
      fileExists: () => false,
    });

    await expect(dbus.listLoadedPluginIds()).resolves.toEqual([
      "SynaraComputerUsePlugin",
      "hyprbars",
    ]);
  });

  it("also maps a dev build loaded from outside the plugin directory to the fallback id", async () => {
    const { run } = recordingRunner({ "-j plugin list": LOADED_LIST });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () =>
        Promise.resolve(
          fakeBus(() =>
            Promise.resolve(
              JSON.stringify({ modulePath: "/home/user/repo/SynaraComputerUseHyprland.so" }),
            ),
          ),
        ),
      fileExists: () => false,
    });

    await expect(dbus.listLoadedPluginIds()).resolves.toEqual([
      "SynaraComputerUsePlugin",
      "hyprbars",
    ]);
  });

  it("loads by path, keeps Hyprland's refusal text, and refuses a missing file locally", async () => {
    const target = `${PLUGIN_DIR}/SynaraComputerUsePluginV3.so`;
    const { run } = recordingRunner({
      [`plugin load ${target}`]: `Plugin ${target} could not be loaded: API version mismatch`,
    });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () => Promise.resolve(fakeBus()),
      fileExists: (path) => path === target,
    });

    await expect(dbus.loadPlugin("SynaraComputerUsePluginV3")).resolves.toBe(false);
    expect(dbus.lastLoadRefusal()).toContain("API version mismatch");

    await expect(dbus.loadPlugin("SynaraComputerUsePluginV4")).resolves.toBe(false);
    expect(dbus.lastLoadRefusal()).toContain("does not exist");
  });

  it("unloads by the path the loaded build reported, not by what is on disk now", async () => {
    // Provisioning prunes superseded .so files while Hyprland still has them
    // mapped; unload must address the loaded path string regardless.
    const stalePath = `${PLUGIN_DIR}/SynaraComputerUsePluginV2.so`;
    const { run, calls } = recordingRunner({
      "-j plugin list": JSON.stringify([{ name: "synara-computer-use" }]),
      [`plugin unload ${stalePath}`]: "ok",
    });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () =>
        Promise.resolve(fakeBus(() => Promise.resolve(JSON.stringify({ modulePath: stalePath })))),
      fileExists: () => false,
    });

    await dbus.listLoadedPluginIds();
    await expect(dbus.unloadPlugin("SynaraComputerUsePluginV2")).resolves.toBe(true);
    expect(calls).toContain(`plugin unload ${stalePath}`);
  });

  it("forwards the session bus's liveness ping and owner-change signal", async () => {
    // Both are optional on the engine's interface, so an adapter that drops
    // them compiles perfectly and silently costs Hyprland its stale-generation
    // detection — the plugin is replaced and the backend keeps talking to the
    // old proxy until a call happens to fail.
    const { run } = recordingRunner({});
    const pinged: string[] = [];
    const bus = fakeBus();
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () =>
        Promise.resolve({
          ...bus,
          pingOwner: (owner: string) => {
            pinged.push(owner);
            return Promise.resolve(true);
          },
        }),
      fileExists: () => false,
    });

    await expect(dbus.pingOwner?.(":1.7")).resolves.toBe(true);
    expect(pinged).toEqual([":1.7"]);
    expect(typeof dbus.onServiceOwnerChanged).toBe("function");
  });

  it("refuses to name a generation when two are loaded at once", async () => {
    // Only one of them owns the bus name, and healthJson answers for that one
    // alone — so resolving per entry hands the engine the same id twice, it
    // unloads that id twice, and the other generation keeps the service name
    // away from the build meant to replace it. The unidentifiable id sweeps.
    const twoLoaded = JSON.stringify([
      { name: "synara-computer-use" },
      { name: "synara-computer-use" },
      { name: "hyprbars" },
    ]);
    const { run, calls } = recordingRunner({
      "-j plugin list": twoLoaded,
      [`plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV6.so`]: "ok",
      [`plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV7.so`]: "ok",
    });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () =>
        Promise.resolve(
          fakeBus(() =>
            Promise.resolve(
              JSON.stringify({ modulePath: `${PLUGIN_DIR}/SynaraComputerUsePluginV7.so` }),
            ),
          ),
        ),
      fileExists: () => true,
      listPluginDirectory: () =>
        Promise.resolve(["SynaraComputerUsePluginV6.so", "SynaraComputerUsePluginV7.so"]),
    });

    await expect(dbus.listLoadedPluginIds()).resolves.toEqual([
      "SynaraComputerUsePlugin",
      "hyprbars",
    ]);
    await expect(dbus.unloadPlugin("SynaraComputerUsePlugin")).resolves.toBe(true);
    expect(calls).toContain(`plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV6.so`);
    expect(calls).toContain(`plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV7.so`);
  });

  it("sweeps a path it once loaded even after provisioning deleted the file", async () => {
    const pruned = `${PLUGIN_DIR}/SynaraComputerUsePluginV2.so`;
    const { run, calls } = recordingRunner({
      "-j plugin list": JSON.stringify([{ name: "synara-computer-use" }]),
      [`plugin unload ${pruned}`]: "ok",
    });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () =>
        Promise.resolve(fakeBus(() => Promise.resolve(JSON.stringify({ modulePath: pruned })))),
      fileExists: () => false,
      listPluginDirectory: () => Promise.resolve([]),
    });

    // Learn the path while the build still answers, then lose the ability to
    // identify it — the mapping is the only record Hyprland will accept.
    await dbus.listLoadedPluginIds();
    await expect(dbus.unloadPlugin("SynaraComputerUsePlugin")).resolves.toBe(true);
    expect(calls).toContain(`plugin unload ${pruned}`);
  });

  it("sweeps every installed generation when a fallback id has no known path", async () => {
    const { run, calls } = recordingRunner({
      [`plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV1.so`]: "plugin not loaded",
      [`plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV2.so`]: "ok",
    });
    const dbus = await createSessionHyprlandComputerDbus({
      pluginDirectory: PLUGIN_DIR,
      runHyprctl: run,
      openBus: () => Promise.resolve(fakeBus()),
      fileExists: () => false,
      listPluginDirectory: () =>
        Promise.resolve([
          "SynaraComputerUsePluginV1.so",
          "SynaraComputerUsePluginV2.so",
          "README.txt",
        ]),
    });

    await expect(dbus.unloadPlugin("SynaraComputerUsePlugin")).resolves.toBe(true);
    expect(calls).toEqual([
      `plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV1.so`,
      `plugin unload ${PLUGIN_DIR}/SynaraComputerUsePluginV2.so`,
    ]);
  });
});
