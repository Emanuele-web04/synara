import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  detectHyprlandHeadersVersion,
  buildHyprlandPluginFromSource,
  hyprlandBuildToolingPresent,
  hyprlandInstallIsCurrent,
  hyprlandInstallStampPath,
  hyprlandPluginDirectory,
  hyprlandPluginSourceHash,
  provisionHyprlandPlugin,
  resolveHyprlandInstallScriptPath,
  resolveHyprlandSourceDirectory,
  retireSupersededHyprlandPlugins,
  type HyprlandProvisionDependencies,
} from "./hyprlandPluginProvisioning.ts";

const temp = () => mkdtemp(join(tmpdir(), "synara-hypr-provision-"));

/** A promise whose resolver the code under test can call when it gets there. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const disk =
  (...present: readonly string[]) =>
  (path: string) =>
    present.includes(path);

describe("paths", () => {
  it("resolves the plugin directory from the override, then XDG, then home", () => {
    expect(hyprlandPluginDirectory({ SYNARA_HYPRLAND_PLUGIN_DIR: "/opt/plugins" }, "/home/x")).toBe(
      "/opt/plugins",
    );
    expect(hyprlandPluginDirectory({ XDG_DATA_HOME: "/data" }, "/home/x")).toBe(
      "/data/synara/hyprland-computer-use/plugins",
    );
    expect(hyprlandPluginDirectory({}, "/home/x")).toBe(
      "/home/x/.local/share/synara/hyprland-computer-use/plugins",
    );
  });

  it("resolves the stamp path from the override, then XDG state, then home", () => {
    expect(hyprlandInstallStampPath({ SYNARA_HYPRLAND_STATE_ROOT: "/state" }, "/home/x")).toBe(
      "/state/install.stamp",
    );
    expect(hyprlandInstallStampPath({ XDG_STATE_HOME: "/xdg-state" }, "/home/x")).toBe(
      "/xdg-state/synara/hyprland-computer-use-plugin/install.stamp",
    );
    expect(hyprlandInstallStampPath({}, "/home/x")).toBe(
      "/home/x/.local/state/synara/hyprland-computer-use-plugin/install.stamp",
    );
  });
});

describe("build tooling probe", () => {
  const env = { PATH: "/usr/bin" };

  const TOOLS = ["/usr/bin/g++", "/usr/bin/make", "/usr/bin/pkg-config"];
  /** The Makefile's PKGS, where Arch installs them. */
  const MODULES = [
    "/usr/share/pkgconfig/hyprland.pc",
    "/usr/lib/pkgconfig/pixman-1.pc",
    "/usr/lib/pkgconfig/libdrm.pc",
    "/usr/lib/pkgconfig/sdbus-c++.pc",
    "/usr/lib/pkgconfig/cairo.pc",
    "/usr/lib/pkgconfig/xkbcommon.pc",
    "/usr/lib/pkgconfig/libturbojpeg.pc",
    "/usr/lib/pkgconfig/libpng.pc",
  ];

  it("needs every pkg-config module the Makefile uses and the whole toolchain together", () => {
    expect(hyprlandBuildToolingPresent(disk(...MODULES, ...TOOLS), env)).toBe(true);
    // Headers without a compiler, or a compiler without headers, both refuse.
    expect(hyprlandBuildToolingPresent(disk(...MODULES), env)).toBe(false);
    expect(hyprlandBuildToolingPresent(disk(...TOOLS), env)).toBe(false);
    expect(
      hyprlandBuildToolingPresent(disk(...MODULES, "/usr/bin/g++", "/usr/bin/make"), env),
    ).toBe(false);
  });

  it("says no when hyprland.pc is present but another module the Makefile needs is not", () => {
    // The old probe checked hyprland.pc alone, so a host without, say,
    // libturbojpeg's development files was reported buildable and then failed
    // in pkg-config --cflags.
    for (const missing of MODULES) {
      expect(
        hyprlandBuildToolingPresent(
          disk(...MODULES.filter((path) => path !== missing), ...TOOLS),
          env,
        ),
        missing,
      ).toBe(false);
    }
  });

  it("accepts the pkg-config files from any of their packaging locations", () => {
    const others = MODULES.filter((path) => !path.endsWith("/hyprland.pc"));
    for (const pc of [
      "/usr/lib/pkgconfig/hyprland.pc",
      "/usr/lib64/pkgconfig/hyprland.pc",
      "/usr/lib/x86_64-linux-gnu/pkgconfig/hyprland.pc",
      "/usr/local/share/pkgconfig/hyprland.pc",
    ]) {
      expect(hyprlandBuildToolingPresent(disk(pc, ...others, ...TOOLS), env)).toBe(true);
    }
    expect(
      hyprlandBuildToolingPresent(disk("/opt/hypr/pkgconfig/hyprland.pc", ...others, ...TOOLS), {
        ...env,
        PKG_CONFIG_PATH: "/opt/hypr/pkgconfig",
      }),
    ).toBe(true);
  });
});

describe("source and install script resolution", () => {
  it("finds the install script beside the module or falls back to the source tree", () => {
    const bundled = "/mod/computer-use-hyprland/scripts/install-and-load.sh";
    expect(resolveHyprlandInstallScriptPath("/mod", undefined, (path) => path === bundled)).toBe(
      bundled,
    );
    expect(
      resolveHyprlandInstallScriptPath("/repo/apps/server/src/computer", undefined, () => false),
    ).toBe("/repo/apps/server/native/computer-use-hyprland/scripts/install-and-load.sh");
    expect(
      resolveHyprlandInstallScriptPath("/mod", "/src-override", (path) =>
        path.startsWith("/src-override"),
      ),
    ).toBe("/src-override/scripts/install-and-load.sh");
  });

  it("finds the plugin sources beside the module, then in the source tree", () => {
    expect(
      resolveHyprlandSourceDirectory(
        "/mod",
        undefined,
        (path) => path === "/mod/computer-use-hyprland/Makefile",
      ),
    ).toBe("/mod/computer-use-hyprland");
    expect(
      resolveHyprlandSourceDirectory("/repo/apps/server/src/computer", undefined, () => false),
    ).toBe("/repo/apps/server/native/computer-use-hyprland");
  });
});

describe("hyprlandPluginSourceHash", () => {
  const writeSources = async (directory: string, body: string) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "Makefile"), "all:\n");
    await writeFile(join(directory, "synarahyprlandplugin.cpp"), body);
    await writeFile(join(directory, "capturetransform.h"), "#pragma once\n");
    await writeFile(join(directory, "sessionauth.h"), "#pragma once\n");
  };

  it("changes when any source changes and is undefined when the tree is not shipped", async () => {
    const directory = join(await temp(), "src");
    await writeSources(directory, "int a;");
    const first = await hyprlandPluginSourceHash(directory);
    await writeSources(directory, "int b;");
    const second = await hyprlandPluginSourceHash(directory);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(await hyprlandPluginSourceHash(join(await temp(), "absent"))).toBeUndefined();
  });
});

const stamp = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

describe("hyprlandInstallIsCurrent", () => {
  const installed = ["SynaraComputerUsePluginV3.so"];
  const current = {
    plugin_id: "SynaraComputerUsePluginV3",
    hyprland_version: "0.56.2",
    source_hash: "abc",
  };

  it("accepts an install for this Hyprland built from these sources", () => {
    expect(hyprlandInstallIsCurrent(stamp(current), installed, "0.56.2", "abc")).toBe(true);
    // An unreadable running version cannot disprove the install on its own.
    expect(hyprlandInstallIsCurrent(stamp(current), installed, undefined, "abc")).toBe(true);
  });

  it("rejects a stamp whose plugin file is gone, or which predates either input", () => {
    expect(hyprlandInstallIsCurrent(undefined, installed, "0.56.2", "abc")).toBe(false);
    expect(hyprlandInstallIsCurrent(stamp(current), [], "0.56.2", "abc")).toBe(false);
    // A Hyprland upgrade: the installed plugin no longer loads into it.
    expect(hyprlandInstallIsCurrent(stamp(current), installed, "0.57.0", "abc")).toBe(false);
    // A Synara update rewrote the plugin sources; the old build is stale even
    // though the compositor has not moved.
    expect(hyprlandInstallIsCurrent(stamp(current), installed, "0.56.2", "def")).toBe(false);
    const legacy = stamp({ plugin_id: current.plugin_id, hyprland_version: "0.56.2" });
    expect(hyprlandInstallIsCurrent(legacy, installed, "0.56.2", "abc")).toBe(false);
    // Without local sources there is nothing to compare, and nothing to build
    // either, so the version check stands alone.
    expect(hyprlandInstallIsCurrent(legacy, installed, "0.56.2", undefined)).toBe(true);
  });
});

describe("retireSupersededHyprlandPlugins", () => {
  const withGenerations = async (...names: readonly string[]): Promise<string> => {
    const directory = join(await temp(), "plugins");
    await mkdir(directory, { recursive: true });
    for (const name of names) await writeFile(join(directory, name), "so");
    return directory;
  };

  it("unloads each superseded build before its file is deleted", async () => {
    const directory = await withGenerations(
      "SynaraComputerUsePluginV1.so",
      "SynaraComputerUsePluginV2.so",
      "SynaraComputerUsePluginV3.so",
      "notes.txt",
    );
    const order: string[] = [];

    const retired = await retireSupersededHyprlandPlugins({
      pluginDirectory: directory,
      keepPluginId: "SynaraComputerUsePluginV3",
      unload: async (path) => {
        // Hyprland matches the path against what is on disk, so a file deleted
        // before this call can never be unloaded again.
        expect((await readdir(directory)).includes(path.split("/").at(-1)!)).toBe(true);
        order.push(`unload ${path}`);
        return true;
      },
    });

    expect(order).toEqual([
      `unload ${join(directory, "SynaraComputerUsePluginV1.so")}`,
      `unload ${join(directory, "SynaraComputerUsePluginV2.so")}`,
    ]);
    expect(retired.removed).toHaveLength(2);
    expect((await readdir(directory)).toSorted()).toEqual([
      "SynaraComputerUsePluginV3.so",
      "notes.txt",
    ]);
  });

  it("keeps a build whose load state Hyprland would not answer for", async () => {
    const directory = await withGenerations(
      "SynaraComputerUsePluginV1.so",
      "SynaraComputerUsePluginV2.so",
    );

    const retired = await retireSupersededHyprlandPlugins({
      pluginDirectory: directory,
      keepPluginId: "SynaraComputerUsePluginV2",
      unload: async () => {
        throw new Error("something exploded");
      },
    });

    // Deleting it would strand a possibly-running generation with no path left
    // to address it by; it stays, and the next install tries again.
    expect(retired.stuck).toEqual([join(directory, "SynaraComputerUsePluginV1.so")]);
    expect(retired.removed).toEqual([]);
    expect((await readdir(directory)).toSorted()).toEqual([
      "SynaraComputerUsePluginV1.so",
      "SynaraComputerUsePluginV2.so",
    ]);
  });

  it("leaves builds newer than the loaded one alone", async () => {
    // A higher generation is not superseded by the one serving — it is the
    // install waiting to be loaded, and unloading or deleting it here would
    // throw away the very build the next connect is meant to pick up.
    const directory = await withGenerations(
      "SynaraComputerUsePluginV1.so",
      "SynaraComputerUsePluginV2.so",
      "SynaraComputerUsePluginV3.so",
    );
    const unloaded: string[] = [];

    await retireSupersededHyprlandPlugins({
      pluginDirectory: directory,
      keepPluginId: "SynaraComputerUsePluginV2",
      unload: async (path) => {
        unloaded.push(path);
        return true;
      },
    });

    expect(unloaded).toEqual([join(directory, "SynaraComputerUsePluginV1.so")]);
    expect((await readdir(directory)).toSorted()).toEqual([
      "SynaraComputerUsePluginV2.so",
      "SynaraComputerUsePluginV3.so",
    ]);
  });
});

describe("provisioning", () => {
  const baseDeps = async (
    overrides: Partial<HyprlandProvisionDependencies> = {},
  ): Promise<HyprlandProvisionDependencies> => {
    const dir = await temp();
    return {
      pluginDirectory: join(dir, "plugins"),
      listInstalled: async () => [],
      hyprlandVersion: async () => "0.56.2",
      isCurrent: async () => false,
      buildFromSource: async () => {
        const built = join(dir, "built.so");
        await writeFile(built, "from source");
        return built;
      },
      stateRoot: join(dir, "state"),
      sourceHash: async () => "source-hash",
      ...overrides,
    };
  };

  it("builds and installs the first generation", async () => {
    const deps = await baseDeps();

    const result = await provisionHyprlandPlugin(deps);

    expect(result.action).toBe("installed-from-source");
    expect(await readFile(join(deps.pluginDirectory, "SynaraComputerUsePluginV1.so"), "utf8")).toBe(
      "from source",
    );
  });

  it("asks for a Hyprland restart instead of building for headers the running one refuses", async () => {
    let built = 0;
    const deps = await baseDeps({
      headersVersion: async () => "0.57.0",
      buildFromSource: async () => {
        built += 1;
        return "unused";
      },
    });

    const result = await provisionHyprlandPlugin(deps);

    expect(result).toMatchObject({ requiresRelogin: true });
    expect(result.summary).toContain("Hyprland 0.56.2 is still running");
    expect(built).toBe(0);
    // Matching headers build as before.
    const matching = await provisionHyprlandPlugin(
      await baseDeps({ headersVersion: async () => "0.56.2" }),
    );
    expect(matching.action).toBe("installed-from-source");
  });

  it("reports each stage it reaches (R14)", async () => {
    const stages: string[] = [];
    await provisionHyprlandPlugin(await baseDeps({ onStage: (stage) => stages.push(stage) }));
    expect(stages).toEqual(["waiting-for-lock", "installing", "building"]);
  });

  it("does nothing when the stamp says the install is already current", async () => {
    let built = 0;
    const deps = await baseDeps({
      isCurrent: async () => true,
      buildFromSource: async () => {
        built += 1;
        return "unused";
      },
    });

    const result = await provisionHyprlandPlugin(deps);

    // Every failed connect asks provisioning again, and a source build is
    // minutes: without this gate a refusing compositor recompiles on a loop.
    expect(result.action).toBe("already-current");
    expect(built).toBe(0);
  });

  it("reinstalls anyway when forced, because current is not the same as loadable", async () => {
    const deps = await baseDeps({ isCurrent: async () => true, force: true });

    const result = await provisionHyprlandPlugin(deps);

    expect(result.action).toBe("installed-from-source");
    expect(result.pluginId).toBe("SynaraComputerUsePluginV1");
  });

  it("passes the version it read into the currency check", async () => {
    const seen: (string | undefined)[] = [];
    await provisionHyprlandPlugin(
      await baseDeps({
        hyprlandVersion: async () => "0.57.1",
        isCurrent: async (version) => {
          seen.push(version);
          return false;
        },
      }),
    );

    expect(seen).toEqual(["0.57.1"]);
  });

  it("outranks the installed generation and leaves it on disk for the backend", async () => {
    const deps = await baseDeps({ listInstalled: async () => ["SynaraComputerUsePluginV4.so"] });
    await mkdir(deps.pluginDirectory, { recursive: true });
    await writeFile(join(deps.pluginDirectory, "SynaraComputerUsePluginV4.so"), "old");
    await writeFile(join(deps.pluginDirectory, "keep-me.txt"), "unrelated");

    const result = await provisionHyprlandPlugin(deps);

    // Until the new build has loaded and passed its health check, the old file
    // is the one the user is running: it is retired by the backend afterwards,
    // never here.
    expect(result.pluginId).toBe("SynaraComputerUsePluginV5");
    expect(result.pluginDirectory).toBe(deps.pluginDirectory);
    expect((await readdir(deps.pluginDirectory)).toSorted()).toEqual(
      [
        ".synara-provision.lock",
        "SynaraComputerUsePluginV4.so",
        "SynaraComputerUsePluginV5.so",
        "keep-me.txt",
      ].toSorted(),
    );
  });

  it("never hands out an id the counter has already given away", async () => {
    // An uninstall empties the plugin directory; numbering from the files
    // present would start again at V1 and hand a live compositor an id it has
    // already mapped to a different library.
    const deps = await baseDeps();
    const first = await provisionHyprlandPlugin(deps);
    await rm(join(deps.pluginDirectory, `${first.pluginId!}.so`), { force: true });
    const second = await provisionHyprlandPlugin(deps);

    expect(first.pluginId).toBe("SynaraComputerUsePluginV1");
    expect(second.pluginId).toBe("SynaraComputerUsePluginV2");
  });

  it("records the Hyprland version and source hash it installed for", async () => {
    const deps = await baseDeps();
    await provisionHyprlandPlugin(deps);
    const stamp = await readFile(join(deps.stateRoot, "install.stamp"), "utf8");

    expect(stamp).toContain("plugin_id=SynaraComputerUsePluginV1");
    expect(stamp).toContain("hyprland_version=0.56.2");
    expect(stamp).toContain("source_hash=source-hash");
  });

  it("never asks for a relogin — hyprctl loads by path into the live compositor", async () => {
    const result = await provisionHyprlandPlugin(await baseDeps());
    expect(result.requiresRelogin).toBe(false);
    expect(result.summary).not.toMatch(/[Ll]og out/);
  });

  it("carries the build's abort signal, so a cancelled setup stops compiling", async () => {
    const controller = new AbortController();
    const started = deferred<AbortSignal | undefined>();
    const pending = provisionHyprlandPlugin(
      await baseDeps({
        signal: controller.signal,
        buildFromSource: (signal) =>
          new Promise((_resolve, reject) => {
            started.resolve(signal);
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      }),
    );
    // The build itself says when it started, so the cancellation lands inside
    // it rather than at whatever point a timer happened to fire.
    expect(await started.promise).toBeInstanceOf(AbortSignal);
    controller.abort(new Error("the user closed the panel"));

    await expect(pending).rejects.toThrow("the user closed the panel");
  });

  it("installs nothing when the abort lands between the build and the install", async () => {
    const controller = new AbortController();
    const deps = await baseDeps({
      signal: controller.signal,
      buildFromSource: async () => {
        controller.abort(new Error("cancelled mid-provision"));
        const built = join(await temp(), "built.so");
        await writeFile(built, "from source");
        return built;
      },
    });

    await expect(provisionHyprlandPlugin(deps)).rejects.toThrow("cancelled mid-provision");
    expect((await readdir(deps.pluginDirectory)).filter((name) => name.endsWith(".so"))).toEqual(
      [],
    );
  });

  it("allocates different on-disk generations for competing installers with stale discovery", async () => {
    const deps = await baseDeps({ listInstalled: async () => [] });
    const results = await Promise.all([
      provisionHyprlandPlugin(deps),
      provisionHyprlandPlugin(deps),
    ]);
    expect(results.map((result) => result.pluginId).toSorted()).toEqual([
      "SynaraComputerUsePluginV1",
      "SynaraComputerUsePluginV2",
    ]);
    expect(await readFile(join(deps.pluginDirectory, "SynaraComputerUsePluginV2.so"), "utf8")).toBe(
      "from source",
    );
  });
});

describe("buildHyprlandPluginFromSource", () => {
  /**
   * A stand-in installer script, because the contract between the server and
   * the script is exactly one line of text: `--build-only` logs whatever it
   * likes and prints the built path last.
   */
  const withScript = async <T>(body: string, run: () => Promise<T>): Promise<T> => {
    const directory = join(await temp(), "source");
    await mkdir(join(directory, "scripts"), { recursive: true });
    const script = join(directory, "scripts", "install-and-load.sh");
    await writeFile(script, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    await chmod(script, 0o755);
    const previous = process.env.SYNARA_HYPRLAND_SOURCE_DIR;
    process.env.SYNARA_HYPRLAND_SOURCE_DIR = directory;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.SYNARA_HYPRLAND_SOURCE_DIR;
      else process.env.SYNARA_HYPRLAND_SOURCE_DIR = previous;
    }
  };

  it("takes the built path from the last line, past every log line before it", async () => {
    await withScript(
      [
        '[[ "$1" == "--build-only" ]] || exit 64',
        'echo "[synara-hyprland-plugin] Building against Hyprland 0.56.2 ..."',
        'echo "/home/user/.cache/build/SynaraComputerUseHyprland.so"',
      ].join("\n"),
      async () => {
        await expect(buildHyprlandPluginFromSource(undefined)).resolves.toBe(
          "/home/user/.cache/build/SynaraComputerUseHyprland.so",
        );
      },
    );
  });

  it("fails with the script's own diagnosis when the build cannot proceed", async () => {
    await withScript(
      [
        'echo "[synara-hyprland-plugin] ERROR: Missing development package: sdbus-c++" >&2',
        "exit 1",
      ].join("\n"),
      async () => {
        await expect(buildHyprlandPluginFromSource(undefined)).rejects.toThrow(/sdbus-c\+\+/);
      },
    );
  });

  it("stops a build that is still running, and reports the cancellation not the kill", async () => {
    const controller = new AbortController();
    const directory = await temp();
    const marker = join(directory, "started");
    await withScript(`touch ${JSON.stringify(marker)}\nsleep 30\necho "/never"`, async () => {
      const pending = buildHyprlandPluginFromSource(controller.signal);
      // The script announces itself on disk; polling that is what makes the
      // abort land mid-compile without a timing assumption.
      while (!existsSync(marker)) await new Promise((resolve) => setImmediate(resolve));
      controller.abort(new Error("setup cancelled"));

      // Never "failed (exit 143)": the child died because the teardown
      // signalled it, so its exit is the cancellation, not a build failure.
      await expect(pending).rejects.toThrow("setup cancelled");
    });
  });
});

describe("detectHyprlandHeadersVersion", () => {
  it("keeps the pkg-config search path, so a Hyprland in a prefix is found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "synara-pkgconfig-"));
    // A stand-in pkg-config that only knows Hyprland through the custom path.
    await writeFile(
      join(directory, "pkg-config"),
      '#!/bin/sh\n[ "$PKG_CONFIG_PATH" = "/opt/hypr/lib/pkgconfig" ] && echo 0.56.0 && exit 0\nexit 1\n',
    );
    await chmod(join(directory, "pkg-config"), 0o755);
    const saved = { PATH: process.env.PATH, PKG_CONFIG_PATH: process.env.PKG_CONFIG_PATH };
    process.env.PATH = `${directory}:${saved.PATH ?? ""}`;
    process.env.PKG_CONFIG_PATH = "/opt/hypr/lib/pkgconfig";
    try {
      await expect(detectHyprlandHeadersVersion()).resolves.toBe("0.56.0");
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.PKG_CONFIG_PATH === undefined) delete process.env.PKG_CONFIG_PATH;
      else process.env.PKG_CONFIG_PATH = saved.PKG_CONFIG_PATH;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
