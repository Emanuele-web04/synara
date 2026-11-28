import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const installScript = resolve(import.meta.dirname, "install.sh");
const payloadArch = process.arch === "arm64" ? "arm64" : "x86_64";
const manifestArch = process.arch === "arm64" ? "-arm64" : "";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in AppImage. Like a real one on a machine without FUSE 2, it refuses to start and
 * only unpacks. The unpacked app records each start and can replace its own AppImage, which is
 * what the in-app updater does.
 */
function fakeAppImage(name: string, version: string, brokenUnpack = false): string {
  return `#!/bin/sh
[ "$1" = "--appimage-extract" ] || { echo "AppImages require FUSE to run." >&2; exit 1; }
${brokenUnpack ? '[ -n "${2:-}" ] || exit 1' : ""}
mkdir -p squashfs-root/usr/share/icons/hicolor/1024x1024/apps
printf 'icon ${version}' > squashfs-root/usr/share/icons/hicolor/1024x1024/apps/${name}.png
ln -s usr/share/icons/hicolor/1024x1024/apps/${name}.png squashfs-root/.DirIcon
cat > squashfs-root/${name}.desktop <<'ENTRY'
[Desktop Entry]
Name=Synara
Exec=AppRun --no-sandbox %U
Terminal=false
Type=Application
Icon=${name}
StartupWMClass=${name}
X-AppImage-Version=${version}
Categories=Development;
ENTRY
cat > squashfs-root/AppRun <<'APPRUN'
#!/bin/sh
[ -z "\${APPDIR:-}" ] || [ "$APPDIR" = "$(dirname "$0")" ] || exit 127
echo "${version} appimage=$APPIMAGE args=$*" >> "$SYNARA_TEST_LOG"
if [ -n "\${SYNARA_TEST_UPDATE:-}" ] && [ -f "$SYNARA_TEST_UPDATE" ]; then
  mv -f "$SYNARA_TEST_UPDATE" "$APPIMAGE"
fi
APPRUN
chmod +x squashfs-root/AppRun
`;
}

interface Release {
  readonly version: string;
  readonly name?: string;
  readonly manifest?: string;
  readonly sha512?: string;
  readonly brokenUnpack?: boolean;
}

function setup(releases: { readonly latest?: Release; readonly tagged?: readonly Release[] }) {
  const root = mkdtempSync(join(tmpdir(), "synara-install-"));
  roots.push(root);
  const home = join(root, "home");
  const releasesDir = join(root, "site", "releases");
  mkdirSync(home, { recursive: true });

  const stage = (directory: string, release: Release) => {
    const name = release.name ?? "synara";
    const payload = `Synara-${release.version}-${payloadArch}.AppImage`;
    const bytes = fakeAppImage(name, release.version, release.brokenUnpack);
    const sha512 = release.sha512 ?? createHash("sha512").update(bytes).digest("base64");
    const manifest = release.manifest ?? `latest-linux${manifestArch}.yml`;
    for (const target of [directory, join(releasesDir, "download", `v${release.version}`)]) {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, payload), bytes);
      writeFileSync(
        join(target, manifest),
        `version: ${release.version}\nfiles:\n  - url: ${payload}\n    sha512: ${sha512}\npath: ${payload}\nsha512: ${sha512}\n`,
      );
    }
  };

  if (releases.latest) stage(join(releasesDir, "latest", "download"), releases.latest);
  for (const release of releases.tagged ?? []) {
    stage(join(releasesDir, "download", `v${release.version}`), release);
  }
  writeFileSync(
    join(root, "site", "releases.atom"),
    (releases.tagged ?? [])
      .map((release) => `<link href="https://example.test/releases/tag/v${release.version}"/>`)
      .join("\n"),
  );

  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    SYNARA_INSTALL_RELEASES_URL: pathToFileURL(releasesDir).href,
    SYNARA_TEST_LOG: join(root, "starts.log"),
  };
  const run = (command: string, args: readonly string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(command, args, { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000 });

  return {
    root,
    home,
    publishLatest: (release: Release) => stage(join(releasesDir, "latest", "download"), release),
    dataDir: (name: string) => join(home, ".local", "share", name),
    install: (...args: string[]) => run("sh", [installScript, ...args]),
    launch: (name: string, args: readonly string[] = [], extraEnv: Record<string, string> = {}) =>
      run(join(home, ".local", "share", name, "launch"), args, extraEnv),
    starts: () => readFileSync(env.SYNARA_TEST_LOG, "utf8").trim().split("\n"),
  };
}

describe.skipIf(process.platform !== "linux")("Linux install script", () => {
  it("installs the latest Stable build with an app menu entry and starts it without FUSE", () => {
    const lab = setup({ latest: { version: "1.6.0" } });

    const result = lab.install();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const appImage = join(lab.dataDir("synara"), "Synara.AppImage");
    expect(statSync(appImage).mode & 0o111).not.toBe(0);

    const launcher = join(lab.dataDir("synara"), "launch");
    const entry = readFileSync(
      join(lab.home, ".local", "share", "applications", "synara.desktop"),
      "utf8",
    );
    expect(entry).toContain(`Exec=${launcher} %U`);
    expect(entry).toContain("Icon=synara");
    expect(entry).toContain("StartupWMClass=synara");
    expect(entry).not.toContain("AppRun");
    expect(entry).not.toContain("X-AppImage-Version");
    expect(
      readFileSync(
        join(lab.home, ".local", "share", "icons", "hicolor", "512x512", "apps", "synara.png"),
        "utf8",
      ),
    ).toBe("icon 1.6.0");

    expect(lab.launch("synara", ["--flag", "two words"], { APPDIR: "/opt/other-app" }).status).toBe(
      0,
    );
    expect(lab.starts()).toEqual([`1.6.0 appimage=${appImage} args=--flag two words`]);
  });

  it("starts the new version after the app replaces its AppImage with an update", () => {
    const lab = setup({ latest: { version: "1.6.0" } });
    expect(lab.install().status).toBe(0);

    const update = join(lab.root, "update.AppImage");
    writeFileSync(update, fakeAppImage("synara", "1.7.0"));
    chmodSync(update, 0o755);

    expect(lab.launch("synara", ["--first"], { SYNARA_TEST_UPDATE: update }).status).toBe(0);

    const appImage = join(lab.dataDir("synara"), "Synara.AppImage");
    expect(lab.starts()).toEqual([
      `1.6.0 appimage=${appImage} args=--first`,
      `1.7.0 appimage=${appImage} args=`,
    ]);
  });

  it("reports an upgrade that cannot be unpacked and keeps the working version", () => {
    const lab = setup({ latest: { version: "1.6.0" } });
    expect(lab.install().status).toBe(0);
    lab.publishLatest({ version: "1.7.0", brokenUnpack: true });

    const result = lab.install();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not unpack");
    expect(lab.launch("synara").status).toBe(0);
    expect(lab.starts()).toEqual([
      `1.6.0 appimage=${join(lab.dataDir("synara"), "Synara.AppImage")} args=`,
    ]);
  });

  it("installs nothing when the download does not match the published checksum", () => {
    const lab = setup({
      latest: { version: "1.6.0", sha512: createHash("sha512").update("other").digest("base64") },
    });

    const result = lab.install();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum");
    expect(existsSync(join(lab.dataDir("synara"), "Synara.AppImage"))).toBe(false);
    expect(existsSync(join(lab.home, ".local", "share", "applications", "synara.desktop"))).toBe(
      false,
    );
  });

  it("installs the newest Beta beside Stable with --beta", () => {
    const beta = (version: string): Release => ({
      version,
      name: "synara-beta",
      manifest: `beta-linux${manifestArch}.yml`,
    });
    const lab = setup({
      latest: { version: "1.6.0" },
      tagged: [{ version: "1.6.0" }, beta("1.6.1-beta.2"), beta("1.6.1-beta.1")],
    });
    expect(lab.install().status).toBe(0);

    const result = lab.install("--beta");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const betaAppImage = join(lab.dataDir("synara-beta"), "Synara.AppImage");
    expect(lab.launch("synara-beta").status).toBe(0);
    expect(lab.launch("synara").status).toBe(0);
    expect(lab.starts()).toEqual([
      `1.6.1-beta.2 appimage=${betaAppImage} args=`,
      `1.6.0 appimage=${join(lab.dataDir("synara"), "Synara.AppImage")} args=`,
    ]);
    expect(
      readFileSync(
        join(lab.home, ".local", "share", "applications", "synara-beta.desktop"),
        "utf8",
      ),
    ).toContain("Icon=synara-beta");
  });

  it("refuses a Stable build offered on the Beta lane", () => {
    const lab = setup({
      tagged: [{ version: "1.6.1-beta.1", manifest: `beta-linux${manifestArch}.yml` }],
    });

    const result = lab.install("--beta");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not a Synara Beta package");
    expect(existsSync(join(lab.home, ".local", "share", "applications", "synara.desktop"))).toBe(
      false,
    );
    expect(
      existsSync(join(lab.home, ".local", "share", "applications", "synara-beta.desktop")),
    ).toBe(false);
  });

  it("removes the app with --uninstall and keeps the user's Synara data", () => {
    const lab = setup({ latest: { version: "1.6.0" } });
    expect(lab.install().status).toBe(0);
    mkdirSync(join(lab.home, ".synara"));
    writeFileSync(join(lab.home, ".synara", "state.sqlite"), "data");

    expect(lab.install("--uninstall").status).toBe(0);

    expect(existsSync(lab.dataDir("synara"))).toBe(false);
    expect(existsSync(join(lab.home, ".local", "share", "applications", "synara.desktop"))).toBe(
      false,
    );
    expect(
      existsSync(
        join(lab.home, ".local", "share", "icons", "hicolor", "512x512", "apps", "synara.png"),
      ),
    ).toBe(false);
    expect(readFileSync(join(lab.home, ".synara", "state.sqlite"), "utf8")).toBe("data");
  });
});
