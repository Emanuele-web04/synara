import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { HostToolchainReaders } from "./provisioning/hostToolchain.ts";
import {
  ENV_SCRIPT_NAME,
  describePrebuiltHost,
  ensureEnvScript,
  envScriptPath,
  allocatePluginId,
  highestInstalledPluginNumber,
  installPluginBytes,
  installStampPath,
  pluginIdCounterPath,
  pluginIdNumber,
  pruneSupersededPlugins,
  provisionKWinPlugin,
  readPrebuiltManifest,
  renderEnvScript,
  resolveInstallTarget,
  selectPrebuilt,
  readVerifiedPrebuilt,
  sessionSeesPluginRoot,
  verifyPrebuiltBytes,
  writeInstallStamp,
  type PrebuiltHost,
  type ProvisionDependencies,
} from "./kwinPluginProvisioning.ts";

const temp = () => mkdtemp(join(tmpdir(), "synara-provision-"));

/** The candidate list every caller passes: both spellings, in preference order. */
const SYSTEM_QT_ROOTS = ["/usr/lib64/qt6/plugins", "/usr/lib/qt6/plugins"];
const onDisk =
  (...present: readonly string[]) =>
  (path: string) =>
    present.includes(path);
/** No SYNARA_KWIN_PLUGIN_DIR: the tests below decide from the disk alone. */
const cleanEnv = {};

describe("install target", () => {
  it("follows the system Qt's lib64/lib split rather than guessing it", () => {
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk("/usr/lib64/qt6/plugins"), cleanEnv)
        .qtPluginRoot,
    ).toBe("/home/x/.local/lib64/qt6/plugins");
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk("/usr/lib/qt6/plugins"), cleanEnv)
        .qtPluginRoot,
    ).toBe("/home/x/.local/lib/qt6/plugins");
  });

  /**
   * The regression that mattered: every caller hands over both spellings, so a
   * decision made by reading the list rather than the disk answered lib64 on
   * Debian and Arch too, and installed the plugin into a directory the env
   * script never put on QT_PLUGIN_PATH.
   */
  it("reads the split off the disk, not off the candidate list", () => {
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk("/usr/lib/qt6/plugins"), cleanEnv)
        .qtPluginRoot,
    ).toBe("/home/x/.local/lib/qt6/plugins");
    // Neither present: the script's `else` branch, which is lib.
    expect(resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk(), cleanEnv).qtPluginRoot).toBe(
      "/home/x/.local/lib/qt6/plugins",
    );
  });

  it("puts the plugin where KWin scans, under the root it will be told about", () => {
    const target = resolveInstallTarget(
      SYSTEM_QT_ROOTS,
      "/home/x",
      onDisk("/usr/lib64/qt6/plugins"),
      cleanEnv,
    );
    expect(target.pluginDirectory).toBe(`${target.qtPluginRoot}/kwin/plugins`);
  });

  it("honours SYNARA_KWIN_PLUGIN_DIR exactly as the installer script does", () => {
    // The script's PLUGIN_DIR is the value verbatim; the env script needs the
    // Qt root above kwin/plugins.
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk("/usr/lib64/qt6/plugins"), {
        SYNARA_KWIN_PLUGIN_DIR: "/opt/synara/qt6/plugins/kwin/plugins",
      }),
    ).toEqual({
      pluginDirectory: "/opt/synara/qt6/plugins/kwin/plugins",
      qtPluginRoot: "/opt/synara/qt6/plugins",
    });
    // A directory that is not a kwin/plugins subpath is its own root.
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk(), {
        SYNARA_KWIN_PLUGIN_DIR: "/opt/elsewhere/",
      }),
    ).toEqual({ pluginDirectory: "/opt/elsewhere", qtPluginRoot: "/opt/elsewhere" });
    // Unset or empty: the normal decision.
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk(), { SYNARA_KWIN_PLUGIN_DIR: "" })
        .qtPluginRoot,
    ).toBe("/home/x/.local/lib/qt6/plugins");
  });

  it("never leaves the home directory, which is the whole point of not needing sudo", () => {
    for (const present of [["/usr/lib64/qt6/plugins"], ["/usr/lib/qt6/plugins"], []]) {
      expect(
        resolveInstallTarget(
          SYSTEM_QT_ROOTS,
          "/home/x",
          onDisk(...present),
          cleanEnv,
        ).pluginDirectory.startsWith("/home/x/"),
      ).toBe(true);
    }
  });
});

describe("session env script", () => {
  it("lands where the Plasma session sources it", () => {
    expect(envScriptPath({ XDG_CONFIG_HOME: "/c" }, "/home/x")).toBe(
      `/c/plasma-workspace/env/${ENV_SCRIPT_NAME}`,
    );
    expect(envScriptPath({}, "/home/x")).toBe(
      `/home/x/.config/plasma-workspace/env/${ENV_SCRIPT_NAME}`,
    );
  });

  it("is safe to source twice and keeps any path the user already had", async () => {
    const script = renderEnvScript("/home/x/.local/lib64/qt6/plugins");
    const dir = await temp();
    const path = join(dir, "env.sh");
    await writeFile(path, script);

    const { execFile } = await import("node:child_process");
    const run = (existing: string): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(
          "sh",
          [
            "-c",
            `QT_PLUGIN_PATH='${existing}'; . '${path}'; . '${path}'; printf '%s' "$QT_PLUGIN_PATH"`,
          ],
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });

    expect(await run("")).toBe("/home/x/.local/lib64/qt6/plugins");
    // Sourced twice, listed once, and the pre-existing entry survives.
    expect(await run("/opt/other")).toBe("/home/x/.local/lib64/qt6/plugins:/opt/other");
  });

  it("rewrites only when the content actually changed", async () => {
    const dir = await temp();
    const path = join(dir, "nested", "env.sh");
    const contents = renderEnvScript("/root");

    expect(await ensureEnvScript(path, contents)).toBe("written");
    expect(await ensureEnvScript(path, contents)).toBe("unchanged");
    expect(await ensureEnvScript(path, renderEnvScript("/other"))).toBe("written");
    expect(await readFile(path, "utf8")).toContain("/other");
    // Sourced by the session, so it has to be executable.
    expect((await stat(path)).mode & 0o111).toBeTruthy();
  });

  it("preserves shell metacharacters in the plugin root as literal path characters", () => {
    const root =
      "/home/$SYNARA_AUDIT_VARIABLE `printf substituted` $(printf substituted) \"double\" 'single' \\.local/qt6/plugins";
    const script = renderEnvScript(root);
    const result = execFileSync(
      "sh",
      ["-c", `${script}\n${script}\nprintf '%s' "$QT_PLUGIN_PATH"`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SYNARA_AUDIT_VARIABLE: "expanded",
          QT_PLUGIN_PATH: "/opt/existing",
        },
      },
    );
    expect(result).toBe(`${root}:/opt/existing`);
  });
});

describe("what the running compositor can see", () => {
  it("reads the session's own QT_PLUGIN_PATH, exact entries only", () => {
    const root = "/home/x/.local/lib64/qt6/plugins";
    expect(sessionSeesPluginRoot(root, { QT_PLUGIN_PATH: `/a:${root}:/b` })).toBe(true);
    expect(sessionSeesPluginRoot(root, { QT_PLUGIN_PATH: "" })).toBe(false);
    expect(sessionSeesPluginRoot(root, {})).toBe(false);
    // A prefix is not the directory: /home/x/.local/lib64/qt6/plugins-old is a
    // different place, and treating it as a match would report a plugin as ready
    // to load when KWin has never scanned for it.
    expect(sessionSeesPluginRoot(root, { QT_PLUGIN_PATH: `${root}-old` })).toBe(false);
  });
});

/** Readers over an in-memory /usr, for describing a host without touching this machine's. */
const fakeDisk = (files: Record<string, string>): HostToolchainReaders => ({
  readFile: (path) => files[path],
  listDirectory: (path) =>
    Object.keys(files)
      .filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/"))
      .map((file) => file.slice(path.length + 1)),
});
const noToolchain = fakeDisk({});
/** A host as `selectPrebuilt` sees it, defaulting to "none of the matrix, toolchain unknown". */
const host = (overrides: Partial<PrebuiltHost> = {}): PrebuiltHost => ({
  builtOn: undefined,
  likeBuiltOn: [],
  qtVersion: undefined,
  kfVersion: undefined,
  ...overrides,
});
/** A derivative that tracks Arch's packages verbatim. */
const endeavour = () => ({ id: "endeavouros", versionId: "rolling", idLike: ["arch"] });

describe("prebuilt selection", () => {
  const toolchain = { qtVersion: "6.9.1", kfVersion: "6.17.0" };
  const manifest = {
    builds: [
      {
        kwinVersion: "6.7.3",
        arch: "x64",
        builtOn: "fedora-43" as const,
        file: "fedora.so",
        sha256: "aa",
        ...toolchain,
      },
      {
        kwinVersion: "6.7.3",
        arch: "x64",
        builtOn: "debian-trixie" as const,
        file: "debian.so",
        sha256: "bb",
        ...toolchain,
      },
      {
        kwinVersion: "6.7.3",
        arch: "arm64",
        builtOn: "fedora-43" as const,
        file: "arm.so",
        sha256: "cc",
        ...toolchain,
      },
      {
        kwinVersion: "6.7.3",
        arch: "x64",
        builtOn: "arch" as const,
        file: "arch.so",
        sha256: "dd",
        ...toolchain,
      },
      {
        kwinVersion: "6.7.3",
        arch: "x64",
        builtOn: "opensuse-tumbleweed" as const,
        file: "suse-legacy.so",
        sha256: "ee",
        // A manifest written before the toolchain was recorded.
      },
    ],
  };
  it("takes the host's own distribution build outright", () => {
    expect(selectPrebuilt(manifest, "6.7.3", "x64", host({ builtOn: "fedora-43" }))?.file).toBe(
      "fedora.so",
    );
    expect(selectPrebuilt(manifest, "6.7.3", "x64", host({ builtOn: "debian-trixie" }))?.file).toBe(
      "debian.so",
    );
    expect(selectPrebuilt(manifest, "6.7.3", "arm64", host({ builtOn: "fedora-43" }))?.file).toBe(
      "arm.so",
    );
    // Even without a readable toolchain, and even over a parent's build.
    expect(
      selectPrebuilt(
        manifest,
        "6.7.3",
        "x64",
        host({ builtOn: "debian-trixie", likeBuiltOn: ["arch"] }),
      )?.file,
    ).toBe("debian.so");
  });

  it("never settles for a near miss on KWin or architecture, which fails at load with no reason", () => {
    const fedora = host({ builtOn: "fedora-43", ...toolchain });
    expect(selectPrebuilt(manifest, "6.7.4", "x64", fedora)).toBeUndefined();
    expect(selectPrebuilt(manifest, "6.7", "x64", fedora)).toBeUndefined();
    expect(selectPrebuilt(manifest, "6.7.3", "riscv64", fedora)).toBeUndefined();
  });

  it("crosses distributions only when both Qt and KF match the build exactly", () => {
    // Fedora 44: not in this manifest, so it is a cross-distro host here.
    expect(
      selectPrebuilt(manifest, "6.7.3", "x64", host({ builtOn: "fedora-44", ...toolchain })),
    ).toBeDefined();
    expect(
      selectPrebuilt(manifest, "6.7.3", "x64", host({ ...toolchain, qtVersion: "6.9.2" })),
    ).toBeUndefined();
    expect(
      selectPrebuilt(manifest, "6.7.3", "x64", host({ ...toolchain, kfVersion: "6.18.0" })),
    ).toBeUndefined();
    // Unreadable toolchain on the host: no cross-distro guess at all.
    expect(selectPrebuilt(manifest, "6.7.3", "x64", host())).toBeUndefined();
    expect(selectPrebuilt(manifest, "6.7.3", "x64", host({ qtVersion: "6.9.1" }))).toBeUndefined();
  });

  it("never crosses onto a build that recorded no toolchain", () => {
    const onlyLegacy = {
      builds: manifest.builds.filter((build) => build.file === "suse-legacy.so"),
    };
    expect(selectPrebuilt(onlyLegacy, "6.7.3", "x64", host({ ...toolchain }))).toBeUndefined();
    expect(
      selectPrebuilt(
        onlyLegacy,
        "6.7.3",
        "x64",
        host({ ...toolchain, likeBuiltOn: ["opensuse-tumbleweed"] }),
      ),
    ).toBeUndefined();
    // Its own distribution still gets it.
    expect(
      selectPrebuilt(onlyLegacy, "6.7.3", "x64", host({ builtOn: "opensuse-tumbleweed" }))?.file,
    ).toBe("suse-legacy.so");
  });

  it("prefers a parent named in ID_LIKE among the compatible cross-distro builds", () => {
    // EndeavourOS: ID_LIKE=arch, same packages as Arch.
    expect(
      selectPrebuilt(manifest, "6.7.3", "x64", host({ likeBuiltOn: ["arch"], ...toolchain }))?.file,
    ).toBe("arch.so");
    // Without the hint, the first compatible build in manifest order.
    expect(selectPrebuilt(manifest, "6.7.3", "x64", host({ ...toolchain }))?.file).toBe(
      "fedora.so",
    );
    // A parent whose build does not pass the toolchain check is not taken on
    // the hint alone.
    expect(
      selectPrebuilt(
        manifest,
        "6.7.3",
        "x64",
        host({ likeBuiltOn: ["arch"], qtVersion: "6.9.1", kfVersion: "6.16.0" }),
      ),
    ).toBeUndefined();
  });

  it("keeps the recorded toolchain from the manifest and tolerates its absence", async () => {
    const dir = await temp();
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        builds: [
          {
            kwinVersion: "6.7.3",
            arch: "x64",
            builtOn: "fedora-43",
            file: "a.so",
            sha256: "0".repeat(64),
            qtVersion: "6.9.1",
            kfVersion: "6.17.0",
            glibcVersion: "2.41",
          },
          {
            kwinVersion: "6.7.3",
            arch: "x64",
            builtOn: "arch",
            file: "b.so",
            sha256: "1".repeat(64),
            qtVersion: "",
            kfVersion: 6,
          },
        ],
      }),
    );
    expect((await readPrebuiltManifest(join(dir, "manifest.json")))?.builds).toEqual([
      {
        kwinVersion: "6.7.3",
        arch: "x64",
        builtOn: "fedora-43",
        file: "a.so",
        sha256: "0".repeat(64),
        qtVersion: "6.9.1",
        kfVersion: "6.17.0",
        glibcVersion: "2.41",
      },
      { kwinVersion: "6.7.3", arch: "x64", builtOn: "arch", file: "b.so", sha256: "1".repeat(64) },
    ]);
  });

  it("treats a missing or corrupt manifest as no prebuilts, not as a failure", async () => {
    const dir = await temp();
    expect(await readPrebuiltManifest(join(dir, "absent.json"))).toBeUndefined();
    await writeFile(join(dir, "bad.json"), "{ not json");
    expect(await readPrebuiltManifest(join(dir, "bad.json"))).toBeUndefined();
    await writeFile(join(dir, "null.json"), "null");
    expect(await readPrebuiltManifest(join(dir, "null.json"))).toBeUndefined();

    await writeFile(
      join(dir, "legacy.json"),
      JSON.stringify({
        builds: [
          {
            kwinVersion: "6.7.3",
            arch: "x64",
            file: "old.so",
            sha256: "0".repeat(64),
          },
        ],
      }),
    );
    expect(await readPrebuiltManifest(join(dir, "legacy.json"))).toBeUndefined();
  });
});

describe("host description", () => {
  it("reads Qt and KF from the cmake package version files, whichever lib root has them", () => {
    const host = describePrebuiltHost(
      { id: "endeavouros", versionId: "rolling", idLike: ["arch"] },
      fakeDisk({
        "/usr/lib/cmake/Qt6/Qt6ConfigVersion.cmake":
          '# generated\nset(PACKAGE_VERSION "6.9.1")\nif(PACKAGE_FIND_VERSION_RANGE)\n',
        "/usr/lib/cmake/KF6WindowSystem/KF6WindowSystemConfigVersion.cmake":
          'set(PACKAGE_VERSION "6.17.0")\n',
      }),
    );
    expect(host).toEqual({
      builtOn: undefined,
      likeBuiltOn: ["arch"],
      qtVersion: "6.9.1",
      kfVersion: "6.17.0",
    });
  });

  it("falls back to the versioned soname when the development packages are absent", () => {
    const host = describePrebuiltHost(
      { id: "fedora", versionId: "43" },
      fakeDisk({
        "/usr/lib64/libQt6Core.so.6": "",
        "/usr/lib64/libQt6Core.so.6.9.1": "",
        "/usr/lib64/libKF6WindowSystem.so.6.17.0": "",
        "/usr/lib64/cmake/KWin/KWinConfigVersion.cmake": 'set(PACKAGE_VERSION "6.7.3")',
      }),
    );
    expect(host).toEqual({
      builtOn: "fedora-43",
      likeBuiltOn: [],
      qtVersion: "6.9.1",
      kfVersion: "6.17.0",
    });
  });

  it("reports an unreadable toolchain as unknown rather than guessing", () => {
    expect(
      describePrebuiltHost({ id: "nobara", versionId: "43", idLike: ["fedora"] }, noToolchain),
    ).toEqual({
      builtOn: undefined,
      likeBuiltOn: ["fedora-43"],
      qtVersion: undefined,
      kfVersion: undefined,
    });
  });
});

describe("checksum", () => {
  it("hands back the bytes it hashed, and nothing for anything else", async () => {
    const dir = await temp();
    const path = join(dir, "plugin.so");
    await writeFile(path, "binary");
    const wrong = "9d0e05e02e0e5e37f52d5c4c1d1b0d2f0b8f6e0e1a58ba2e6f3e0b2f7bd9b7e2";
    expect(await readVerifiedPrebuilt(path, wrong)).toBeUndefined();
    const { createHash } = await import("node:crypto");
    const real = createHash("sha256").update("binary").digest("hex");
    expect((await readVerifiedPrebuilt(path, real))?.toString()).toBe("binary");
    expect(await readVerifiedPrebuilt(join(dir, "absent.so"), real)).toBeUndefined();
    expect(verifyPrebuiltBytes(Buffer.from("binary"), real)).toBe(true);
    expect(verifyPrebuiltBytes(Buffer.from("binar"), real)).toBe(false);
  });
});

describe("plugin id", () => {
  it("outranks every installed version, because KWin pins the file it loaded", async () => {
    const stateRoot = join(await temp(), "state");
    expect(await allocatePluginId({ stateRoot, existingFiles: [] })).toBe(
      "SynaraComputerUsePluginV1",
    );
    expect(
      await allocatePluginId({
        stateRoot,
        existingFiles: ["SynaraComputerUsePluginV3.so", "SynaraComputerUsePluginV11.so"],
      }),
    ).toBe("SynaraComputerUsePluginV12");
    expect(highestInstalledPluginNumber(["notes.txt", "SynaraComputerUsePlugin.so"])).toBe(0);
    expect(pluginIdNumber("SynaraComputerUsePluginV12")).toBe(12);
    expect(pluginIdNumber("SynaraComputerUsePlugin")).toBe(0);
  });

  /**
   * The regression: uninstall empties the plugin directory, the next install
   * numbers from the files it sees and starts over at V1, and KWin - which
   * pinned V1 to the library it loaded earlier this session - serves the
   * uninstalled build under the new name.
   */
  it("never reuses a number after the files are gone, because KWin pins ids for the session", async () => {
    const stateRoot = join(await temp(), "state");
    expect(
      await allocatePluginId({ stateRoot, existingFiles: ["SynaraComputerUsePluginV4.so"] }),
    ).toBe("SynaraComputerUsePluginV5");
    // Uninstalled: nothing on disk.
    expect(await allocatePluginId({ stateRoot, existingFiles: [] })).toBe(
      "SynaraComputerUsePluginV6",
    );
    expect((await readFile(pluginIdCounterPath(stateRoot), "utf8")).trim()).toBe("6");
  });

  it("takes the higher of the counter and the files, so a foreign install still gets outranked", async () => {
    const stateRoot = join(await temp(), "state");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(pluginIdCounterPath(stateRoot), "3\n");
    expect(
      await allocatePluginId({ stateRoot, existingFiles: ["SynaraComputerUsePluginV9.so"] }),
    ).toBe("SynaraComputerUsePluginV10");
    expect(await allocatePluginId({ stateRoot, existingFiles: [] })).toBe(
      "SynaraComputerUsePluginV11",
    );
  });

  it("treats a garbled counter as zero rather than failing the install", async () => {
    const stateRoot = join(await temp(), "state");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(pluginIdCounterPath(stateRoot), "not a number");
    expect(await allocatePluginId({ stateRoot, existingFiles: [] })).toBe(
      "SynaraComputerUsePluginV1",
    );
    expect((await readdir(stateRoot)).toSorted()).toEqual(["plugin-id.counter"]);
  });
});

describe("provisioning", () => {
  const baseDeps = async (
    overrides: Partial<ProvisionDependencies> = {},
  ): Promise<ProvisionDependencies> => {
    const dir = await temp();
    return {
      target: {
        qtPluginRoot: join(dir, "plugins"),
        pluginDirectory: join(dir, "plugins", "kwin", "plugins"),
      },
      env: { XDG_CONFIG_HOME: join(dir, "config") },
      stateRoot: join(dir, "state"),
      listInstalled: async () => [],
      kwinVersion: async () => "6.7.3",
      runningKwinVersion: async () => "6.7.3",
      arch: "x64",
      linuxDistribution: () => ({ id: "fedora", versionId: "43" }),
      hostToolchain: noToolchain,
      buildFromSource: async () => {
        const built = join(dir, "built.so");
        await writeFile(built, "from source");
        return built;
      },
      isCurrent: async () => false,
      ...overrides,
    };
  };

  it("installs a matching prebuilt without ever invoking the compiler", async () => {
    const dir = await temp();
    const prebuiltRoot = join(dir, "prebuilt");
    await mkdir(prebuiltRoot, { recursive: true });
    await writeFile(join(prebuiltRoot, "p.so"), "prebuilt bytes");
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update("prebuilt bytes").digest("hex");
    await writeFile(
      join(prebuiltRoot, "manifest.json"),
      JSON.stringify({
        builds: [{ kwinVersion: "6.7.3", arch: "x64", builtOn: "fedora-43", file: "p.so", sha256 }],
      }),
    );

    let built = false;
    const deps = await baseDeps({
      prebuiltRoot,
      buildFromSource: async () => {
        built = true;
        return "unused";
      },
    });
    const result = await provisionKWinPlugin(deps);

    expect(result.action).toBe("installed-prebuilt");
    expect(built).toBe(false);
    expect(
      await readFile(join(deps.target.pluginDirectory, "SynaraComputerUsePluginV1.so"), "utf8"),
    ).toBe("prebuilt bytes");
  });

  it("builds from source when no prebuilt matches this KWin", async () => {
    const deps = await baseDeps({ kwinVersion: async () => "6.9.9" });
    const result = await provisionKWinPlugin(deps);

    expect(result.action).toBe("installed-from-source");
    expect(
      await readFile(join(deps.target.pluginDirectory, "SynaraComputerUsePluginV1.so"), "utf8"),
    ).toBe("from source");
  });

  it("reports each stage it reaches (R14)", async () => {
    const stages: string[] = [];
    await provisionKWinPlugin(
      await baseDeps({
        kwinVersion: async () => "6.9.9",
        onStage: (stage) => stages.push(stage),
      }),
    );
    expect(stages).toEqual(["waiting-for-lock", "installing", "building"]);
  });

  it("builds from source rather than using another distro's matching KWin", async () => {
    const dir = await temp();
    const prebuiltRoot = join(dir, "prebuilt");
    await mkdir(prebuiltRoot, { recursive: true });
    await writeFile(join(prebuiltRoot, "debian.so"), "debian bytes");
    const { createHash } = await import("node:crypto");
    await writeFile(
      join(prebuiltRoot, "manifest.json"),
      JSON.stringify({
        builds: [
          {
            kwinVersion: "6.7.3",
            arch: "x64",
            builtOn: "debian-trixie",
            file: "debian.so",
            sha256: createHash("sha256").update("debian bytes").digest("hex"),
          },
        ],
      }),
    );

    const result = await provisionKWinPlugin(await baseDeps({ prebuiltRoot }));
    expect(result.action).toBe("installed-from-source");
  });

  it("installs a parent distribution's build on a derivative whose toolchain matches it", async () => {
    const dir = await temp();
    const prebuiltRoot = join(dir, "prebuilt");
    await mkdir(prebuiltRoot, { recursive: true });
    await writeFile(join(prebuiltRoot, "arch.so"), "arch bytes");
    const { createHash } = await import("node:crypto");
    await writeFile(
      join(prebuiltRoot, "manifest.json"),
      JSON.stringify({
        builds: [
          {
            kwinVersion: "6.7.3",
            arch: "x64",
            builtOn: "arch",
            file: "arch.so",
            sha256: createHash("sha256").update("arch bytes").digest("hex"),
            qtVersion: "6.9.1",
            kfVersion: "6.17.0",
          },
        ],
      }),
    );
    const disk = fakeDisk({
      "/usr/lib/cmake/Qt6/Qt6ConfigVersion.cmake": 'set(PACKAGE_VERSION "6.9.1")',
      "/usr/lib/cmake/KF6WindowSystem/KF6WindowSystemConfigVersion.cmake":
        'set(PACKAGE_VERSION "6.17.0")',
    });
    const matched = await provisionKWinPlugin(
      await baseDeps({ prebuiltRoot, linuxDistribution: endeavour, hostToolchain: disk }),
    );
    expect(matched.action).toBe("installed-prebuilt");

    // Same derivative, KF one release ahead of the build: no guess, a source build.
    const drifted = fakeDisk({
      "/usr/lib/cmake/Qt6/Qt6ConfigVersion.cmake": 'set(PACKAGE_VERSION "6.9.1")',
      "/usr/lib/cmake/KF6WindowSystem/KF6WindowSystemConfigVersion.cmake":
        'set(PACKAGE_VERSION "6.18.0")',
    });
    const rebuilt = await provisionKWinPlugin(
      await baseDeps({ prebuiltRoot, linuxDistribution: endeavour, hostToolchain: drifted }),
    );
    expect(rebuilt.action).toBe("installed-from-source");
  });

  it("builds from source on an unrecognized host", async () => {
    const deps = await baseDeps({
      linuxDistribution: () => ({ id: "nobara", versionId: "43" }),
    });
    expect((await provisionKWinPlugin(deps)).action).toBe("installed-from-source");
  });

  it("refuses a prebuilt whose bytes do not match the manifest", async () => {
    const dir = await temp();
    const prebuiltRoot = join(dir, "prebuilt");
    await mkdir(prebuiltRoot, { recursive: true });
    await writeFile(join(prebuiltRoot, "p.so"), "tampered");
    await writeFile(
      join(prebuiltRoot, "manifest.json"),
      JSON.stringify({
        builds: [
          {
            kwinVersion: "6.7.3",
            arch: "x64",
            builtOn: "fedora-43",
            file: "p.so",
            // Well-formed but wrong: this is the mismatch case, not the
            // malformed-entry case.
            sha256: "0".repeat(64),
          },
        ],
      }),
    );

    // Not silently downgraded to a source build: a checksum failure means the
    // shipped file is wrong, and that is worth stopping over.
    await expect(provisionKWinPlugin(await baseDeps({ prebuiltRoot }))).rejects.toThrow(
      /failed its checksum/,
    );
  });

  it("says a login is needed only when the running session cannot see the directory", async () => {
    const deps = await baseDeps();
    const first = await provisionKWinPlugin(deps);
    expect(first.requiresRelogin).toBe(true);
    expect(first.summary).toMatch(/Log out and back in/);

    const seen = await provisionKWinPlugin({
      ...deps,
      env: { ...deps.env, QT_PLUGIN_PATH: deps.target.qtPluginRoot },
    });
    expect(seen.requiresRelogin).toBe(false);
    expect(seen.summary).not.toMatch(/Log out/);
  });

  it("never asks for a login when the backend vouches for the compositor's view", async () => {
    // The nested backend spawns its compositor with the plugin root injected,
    // so the session environment this server inherited proves nothing.
    const deps = await baseDeps({ compositorSeesPluginRoot: () => true });
    const result = await provisionKWinPlugin(deps);
    expect(result.requiresRelogin).toBe(false);
    expect(result.summary).not.toMatch(/Log out/);
  });

  it("writes the env script even when the plugin is already current", async () => {
    const deps = await baseDeps({ isCurrent: async () => true });
    const result = await provisionKWinPlugin(deps);

    expect(result.action).toBe("already-current");
    expect(result.pluginId).toBeUndefined();
    // The script is what makes any install visible at all, so a user who deleted
    // it gets it back on the next enable rather than a plugin KWin never scans.
    expect(await readFile(envScriptPath(deps.env, "/unused"), "utf8")).toContain(
      deps.target.qtPluginRoot,
    );
  });

  it("still asks for the login when a current install is one the session cannot see", async () => {
    const seen = await provisionKWinPlugin(
      await baseDeps({
        isCurrent: async () => true,
        env: { XDG_CONFIG_HOME: (await temp()) + "/config", QT_PLUGIN_PATH: "/tmp/elsewhere" },
      }),
    );
    expect(seen.requiresRelogin).toBe(true);
    expect(seen.summary).toMatch(/installed and current\. Log out/);

    const deps = await baseDeps({ isCurrent: async () => true });
    const visible = await provisionKWinPlugin({
      ...deps,
      env: { ...deps.env, QT_PLUGIN_PATH: deps.target.qtPluginRoot },
    });
    expect(visible.requiresRelogin).toBe(false);
    expect(visible.summary).not.toMatch(/Log out/);
  });

  it("reinstalls past a current stamp when forced, which is what a refusal needs", async () => {
    let built = 0;
    const deps = await baseDeps({
      isCurrent: async () => true,
      buildFromSource: async () => {
        built += 1;
        const built_so = join(deps.target.pluginDirectory, "..", "built.so");
        await mkdir(join(deps.target.pluginDirectory, ".."), { recursive: true });
        await writeFile(built_so, "rebuilt");
        return built_so;
      },
    });
    const result = await provisionKWinPlugin({ ...deps, force: true });

    expect(result.action).toBe("installed-from-source");
    expect(result.pluginId).toBe("SynaraComputerUsePluginV1");
    expect(built).toBe(1);
  });

  it("records the KWin version it installed for, so a later refusal can name it", async () => {
    const deps = await baseDeps();
    await provisionKWinPlugin(deps);
    const stamp = await readFile(installStampPath(deps.stateRoot), "utf8");

    expect(stamp).toContain("plugin_id=SynaraComputerUsePluginV1");
    expect(stamp).toContain("kwin_version=6.7.3");
    expect(stamp).toContain("linux_distribution=fedora:43:");
    // Absent on purpose: the shell installer treats a missing signature as
    // "rebuild", which is the right answer for a stamp it did not write.
    expect(stamp).not.toContain("signature=");
  });

  it("serializes an unknown distro identity into direct install stamps", async () => {
    const dir = await temp();
    const path = join(dir, "install.stamp");
    await writeInstallStamp(path, {
      pluginId: "SynaraComputerUsePluginV2",
      pluginPath: join(dir, "plugin.so"),
      kwinVersion: "6.7.3",
      linuxDistribution: { id: "custom:linux", versionId: "1", versionCodename: "edge" },
      installedAt: "2026-09-10T00:00:00.000Z",
    });
    expect(await readFile(path, "utf8")).toContain("linux_distribution=custom%3Alinux:1:edge\n");
  });

  /**
   * The regression: pruning inside provisioning deleted the working build
   * before the replacement had been loaded, so a refused load (a KWin upgrade
   * the running compositor has not picked up yet, a bad build) left the user
   * with nothing. The old file now outlives the install until the backend
   * has proven the new one works and prunes explicitly.
   */
  it("leaves the build it supersedes on disk; the backend prunes after the load succeeds", async () => {
    const deps = await baseDeps();
    await mkdir(deps.target.pluginDirectory, { recursive: true });
    await writeFile(join(deps.target.pluginDirectory, "SynaraComputerUsePluginV4.so"), "old");
    await writeFile(join(deps.target.pluginDirectory, "keep-me.txt"), "unrelated");

    const result = await provisionKWinPlugin({
      ...deps,
      listInstalled: async () => ["SynaraComputerUsePluginV4.so"],
    });

    expect(result.pluginId).toBe("SynaraComputerUsePluginV5");
    expect(result.pluginDirectory).toBe(deps.target.pluginDirectory);
    const remaining = await readdir(deps.target.pluginDirectory);
    expect(remaining.toSorted()).toEqual(
      [
        ".synara-provision.lock",
        "SynaraComputerUsePluginV4.so",
        "SynaraComputerUsePluginV5.so",
        "keep-me.txt",
      ].toSorted(),
    );
    // What the backend does once V5 has passed its health check.
    expect(await pruneSupersededPlugins(result.pluginDirectory, result.pluginId!)).toEqual([
      "SynaraComputerUsePluginV4.so",
    ]);
  });

  it("hands the build the lock's signal so a cancelled setup stops the compiler", async () => {
    let received: AbortSignal | undefined;
    let abortedDuringBuild: boolean | undefined;
    const deps = await baseDeps({
      buildFromSource: async (signal) => {
        received = signal;
        abortedDuringBuild = signal?.aborted;
        const built = join(deps.target.qtPluginRoot, "..", "built.so");
        await mkdir(join(deps.target.qtPluginRoot, ".."), { recursive: true });
        await writeFile(built, "from source");
        return built;
      },
    });
    await provisionKWinPlugin(deps);
    expect(received).toBeInstanceOf(AbortSignal);
    expect(abortedDuringBuild).toBe(false);
    // The lock's own signal: it fires once the lock is released, which is how
    // a build that outlives the lock holder learns to stop.
    expect(received?.aborted).toBe(true);
  });

  it("asks whether the install is current for the on-disk KWin, never the running one", async () => {
    const asked: (string | undefined)[] = [];
    const deps = await baseDeps({
      kwinVersion: async () => "6.8.0",
      runningKwinVersion: async () => "6.7.3",
      isCurrent: async (version) => {
        asked.push(version);
        return true;
      },
    });
    const result = await provisionKWinPlugin(deps);
    expect(asked).toEqual(["6.8.0"]);
    expect(result.action).toBe("already-current");
    // Current for the KWin that starts next login, not loadable by this one.
    expect(result.requiresRelogin).toBe(true);
    expect(result.summary).toContain("6.8.0");
  });

  /**
   * The regression: after a KWin package upgrade without a relogin, the
   * on-disk version moved but the compositor in front of the user did not.
   * Provisioning installed for the new version, pruned the working build,
   * the load was refused by the old compositor, and every reconnect then
   * forced a source build. Now: install for the on-disk version, keep the
   * running build, and say the install waits for the next login.
   */
  it("installs for an upgraded on-disk KWin without touching the build the session is running", async () => {
    const dir = await temp();
    const prebuiltRoot = join(dir, "prebuilt");
    await mkdir(prebuiltRoot, { recursive: true });
    await writeFile(join(prebuiltRoot, "new.so"), "for 6.8.0");
    const { createHash } = await import("node:crypto");
    await writeFile(
      join(prebuiltRoot, "manifest.json"),
      JSON.stringify({
        builds: [
          {
            kwinVersion: "6.8.0",
            arch: "x64",
            builtOn: "fedora-43",
            file: "new.so",
            sha256: createHash("sha256").update("for 6.8.0").digest("hex"),
          },
        ],
      }),
    );
    let built = false;
    const deps = await baseDeps({
      prebuiltRoot,
      kwinVersion: async () => "6.8.0",
      runningKwinVersion: async () => "6.7.3",
      buildFromSource: async () => {
        built = true;
        return "unused";
      },
    });
    await mkdir(deps.target.pluginDirectory, { recursive: true });
    await writeFile(join(deps.target.pluginDirectory, "SynaraComputerUsePluginV4.so"), "running");
    const visibleEnv = { ...deps.env, QT_PLUGIN_PATH: deps.target.qtPluginRoot };

    const result = await provisionKWinPlugin({ ...deps, env: visibleEnv });

    expect(result.action).toBe("installed-prebuilt");
    expect(built).toBe(false);
    expect(result.pluginId).toBe("SynaraComputerUsePluginV5");
    // Visible to the session, and still not loadable by it.
    expect(result.requiresRelogin).toBe(true);
    expect(result.summary).toContain("6.8.0");
    expect(
      await readFile(join(deps.target.pluginDirectory, "SynaraComputerUsePluginV4.so"), "utf8"),
    ).toBe("running");
    expect(
      await readFile(join(deps.target.pluginDirectory, "SynaraComputerUsePluginV5.so"), "utf8"),
    ).toBe("for 6.8.0");
    const stamp = await readFile(installStampPath(deps.stateRoot), "utf8");
    expect(stamp).toContain("kwin_version=6.8.0");
    // The backend prunes below the id it just loaded and health-checked - V4,
    // the one this session runs - and V5 waits for the next login untouched.
    expect(
      await pruneSupersededPlugins(result.pluginDirectory, "SynaraComputerUsePluginV4"),
    ).toEqual([]);
    expect((await readdir(deps.target.pluginDirectory)).toSorted()).toEqual(
      [
        ".synara-provision.lock",
        "SynaraComputerUsePluginV4.so",
        "SynaraComputerUsePluginV5.so",
      ].toSorted(),
    );
  });

  it("does not call the upgrade pending when either version is unknown", async () => {
    const deps = await baseDeps({
      kwinVersion: async () => "6.8.0",
      runningKwinVersion: async () => undefined,
    });
    const result = await provisionKWinPlugin({
      ...deps,
      env: { ...deps.env, QT_PLUGIN_PATH: deps.target.qtPluginRoot },
    });
    expect(result.requiresRelogin).toBe(false);
  });

  it("keeps the version suffix climbing past what is already installed", async () => {
    const deps = await baseDeps({
      listInstalled: async () => ["SynaraComputerUsePluginV4.so"],
    });
    const result = await provisionKWinPlugin(deps);
    expect(result.pluginId).toBe("SynaraComputerUsePluginV5");
  });
});

describe("prune", () => {
  it("survives a directory that does not exist yet", async () => {
    const dir = await temp();
    expect(await pruneSupersededPlugins(join(dir, "absent"), "SynaraComputerUsePluginV1")).toEqual(
      [],
    );
  });

  it("removes only builds numbered below the kept id, never the one waiting for next login", async () => {
    const dir = await temp();
    for (const name of [
      "SynaraComputerUsePluginV3.so",
      "SynaraComputerUsePluginV4.so",
      "SynaraComputerUsePluginV5.so",
      "SynaraComputerUsePluginV6.so",
      "SynaraComputerUsePlugin.so",
      "notes.txt",
    ]) {
      await writeFile(join(dir, name), name);
    }
    const removed = await pruneSupersededPlugins(dir, "SynaraComputerUsePluginV5");
    expect(removed.toSorted()).toEqual([
      "SynaraComputerUsePluginV3.so",
      "SynaraComputerUsePluginV4.so",
    ]);
    expect((await readdir(dir)).toSorted()).toEqual(
      [
        "SynaraComputerUsePlugin.so",
        "SynaraComputerUsePluginV5.so",
        "SynaraComputerUsePluginV6.so",
        "notes.txt",
      ].toSorted(),
    );
  });
});

describe("installed binary", () => {
  it("is executable, named for its id, and leaves no staging file behind", async () => {
    const dir = await temp();
    const destination = await installPluginBytes(
      Buffer.from("bytes"),
      join(dir, "a", "b"),
      "SynaraComputerUsePluginV9",
    );
    expect(destination).toBe(join(dir, "a", "b", "SynaraComputerUsePluginV9.so"));
    expect((await stat(destination)).mode & 0o111).toBeTruthy();
    expect(await readFile(destination, "utf8")).toBe("bytes");
    // The bytes go through a sibling .tmp and a rename, so a reader that lists
    // the directory afterwards sees only the finished file.
    expect(await readdir(join(dir, "a", "b"))).toEqual(["SynaraComputerUsePluginV9.so"]);
  });

  it("refuses to overwrite an id that is already on disk", async () => {
    const dir = await temp();
    await installPluginBytes(Buffer.from("first"), dir, "SynaraComputerUsePluginV3");
    await expect(
      installPluginBytes(Buffer.from("second"), dir, "SynaraComputerUsePluginV3"),
    ).rejects.toThrow(/existing plugin build/);
    expect(await readFile(join(dir, "SynaraComputerUsePluginV3.so"), "utf8")).toBe("first");
    expect(await readdir(dir)).toEqual(["SynaraComputerUsePluginV3.so"]);
  });
});
