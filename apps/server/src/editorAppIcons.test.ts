import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { clearEditorIconInFlightCache, resolveCachedEditorIcon } from "./editorAppIcons";
import { clearWindowsStorePackageDiscoveryCache } from "./editorAppDiscovery";

const tempDirs: string[] = [];

afterEach(() => {
  clearEditorIconInFlightCache();
  clearWindowsStorePackageDiscoveryCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFakeMacAppIcon(input: {
  readonly homeDir: string;
  readonly appName: string;
  readonly iconName: string;
  readonly bytes: Uint8Array;
}): void {
  const resourcesDir = path.join(
    input.homeDir,
    "Applications",
    `${input.appName}.app`,
    "Contents",
    "Resources",
  );
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(
    path.join(input.homeDir, "Applications", `${input.appName}.app`, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIconFile</key>
  <string>${input.iconName}</string>
</dict>
</plist>`,
  );
  fs.writeFileSync(path.join(resourcesDir, `${input.iconName}.png`), input.bytes);
}

function writeFakeLinuxDesktopIcon(input: {
  readonly homeDir: string;
  readonly desktopFileName: string;
  readonly desktopContent: string;
  readonly iconName: string;
  readonly bytes: Uint8Array;
}): void {
  const applicationsDir = path.join(input.homeDir, ".local", "share", "applications");
  const iconsDir = path.join(
    input.homeDir,
    ".local",
    "share",
    "icons",
    "hicolor",
    "256x256",
    "apps",
  );
  fs.mkdirSync(applicationsDir, { recursive: true });
  fs.mkdirSync(iconsDir, { recursive: true });
  fs.writeFileSync(path.join(applicationsDir, input.desktopFileName), input.desktopContent);
  fs.writeFileSync(path.join(iconsDir, `${input.iconName}.png`), input.bytes);
}

function writeFakeWindowsStorePackageIcon(input: {
  readonly programFilesDir: string;
  readonly packageDirName: string;
  readonly iconFileName: string;
  readonly bytes: Uint8Array;
}): void {
  const assetsDir = path.join(input.programFilesDir, "WindowsApps", input.packageDirName, "Assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, input.iconFileName), input.bytes);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeFakePowerShellAppxRegistration(input: {
  readonly binDir: string;
  readonly installLocation: string;
}): void {
  fs.mkdirSync(input.binDir, { recursive: true });
  const script = `#!/bin/sh\nprintf '%s\\n' ${shellSingleQuote(input.installLocation)}\n`;
  const scriptPath = path.join(input.binDir, "powershell.exe");
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);
}

describe("resolveCachedEditorIcon", () => {
  it("copies a macOS app PNG icon into the cache", async () => {
    const homeDir = makeTempDir("synara-editor-icon-home-");
    const cacheDir = makeTempDir("synara-editor-icon-cache-");
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    writeFakeMacAppIcon({
      homeDir,
      appName: "Ghostty",
      iconName: "Ghostty",
      bytes,
    });

    const icon = await resolveCachedEditorIcon({
      editorId: "ghostty",
      cacheDir,
      platform: "darwin",
      env: { HOME: homeDir, PATH: "" },
    });

    expect(icon?.contentType).toBe("image/png");
    expect(icon?.path.startsWith(cacheDir)).toBe(true);
    expect(icon ? fs.readFileSync(icon.path) : null).toEqual(Buffer.from(bytes));
  });

  it("resolves a Linux desktop icon by icon name", async () => {
    const homeDir = makeTempDir("synara-editor-icon-linux-home-");
    const cacheDir = makeTempDir("synara-editor-icon-linux-cache-");
    const bytes = new Uint8Array([137, 80, 78, 71, 4, 5, 6]);
    writeFakeLinuxDesktopIcon({
      homeDir,
      desktopFileName: "com.cursor.Cursor.desktop",
      desktopContent: [
        "[Desktop Entry]",
        "Name=Cursor",
        "Exec=cursor %F",
        "Icon=cursor-test-icon",
      ].join("\n"),
      iconName: "cursor-test-icon",
      bytes,
    });

    const icon = await resolveCachedEditorIcon({
      editorId: "cursor",
      cacheDir,
      platform: "linux",
      env: { HOME: homeDir, PATH: "", XDG_DATA_DIRS: "" },
    });

    expect(icon?.contentType).toBe("image/png");
    expect(icon?.path.startsWith(cacheDir)).toBe(true);
    expect(icon ? fs.readFileSync(icon.path) : null).toEqual(Buffer.from(bytes));
  });

  it("copies a Windows Store package PNG icon for VS Code", async () => {
    const programFilesDir = makeTempDir("synara-editor-icon-win-program-files-");
    const cacheDir = makeTempDir("synara-editor-icon-win-cache-");
    const powershellBinDir = makeTempDir("synara-editor-icon-win-powershell-");
    const localAppData = makeTempDir("synara-editor-icon-win-local-appdata-");
    const packageDirName = "Microsoft.VisualStudioCode_1.0.0.0_x64__8wekyb3d8bbwe";
    const installLocation = path.join(programFilesDir, "WindowsApps", packageDirName);
    const bytes = new Uint8Array([137, 80, 78, 71, 20, 21, 22]);
    writeFakeWindowsStorePackageIcon({
      programFilesDir,
      packageDirName,
      iconFileName: "Square44x44Logo.targetsize-256_altform-unplated.png",
      bytes,
    });
    writeFakePowerShellAppxRegistration({ binDir: powershellBinDir, installLocation });
    fs.mkdirSync(
      path.join(
        localAppData,
        "Microsoft",
        "WindowsApps",
        "Microsoft.VisualStudioCode_8wekyb3d8bbwe",
      ),
      { recursive: true },
    );

    const icon = await resolveCachedEditorIcon({
      editorId: "vscode",
      cacheDir,
      platform: "win32",
      env: {
        LOCALAPPDATA: localAppData,
        PATH: powershellBinDir,
        PATHEXT: ".EXE",
        ProgramFiles: programFilesDir,
        ProgramW6432: "",
        SystemDrive: "",
      },
    });

    expect(icon?.contentType).toBe("image/png");
    expect(icon?.path.startsWith(cacheDir)).toBe(true);
    expect(icon ? fs.readFileSync(icon.path) : null).toEqual(Buffer.from(bytes));
  });

  it("does not match Linux desktop files from unrelated comments", async () => {
    const homeDir = makeTempDir("synara-editor-icon-linux-comment-home-");
    const cacheDir = makeTempDir("synara-editor-icon-linux-comment-cache-");
    writeFakeLinuxDesktopIcon({
      homeDir,
      desktopFileName: "notes.desktop",
      desktopContent: [
        "[Desktop Entry]",
        "Name=Notes",
        "Comment=Imports Cursor color themes",
        "Exec=notes %F",
        "Icon=notes-test-icon",
      ].join("\n"),
      iconName: "notes-test-icon",
      bytes: new Uint8Array([137, 80, 78, 71, 7, 8, 9]),
    });

    await expect(
      resolveCachedEditorIcon({
        editorId: "cursor",
        cacheDir,
        platform: "linux",
        env: { HOME: homeDir, PATH: "", XDG_DATA_DIRS: "" },
      }),
    ).resolves.toBeNull();
  });

  it("does not match short Linux editor ids inside unrelated words", async () => {
    const homeDir = makeTempDir("synara-editor-icon-linux-short-home-");
    const cacheDir = makeTempDir("synara-editor-icon-linux-short-cache-");
    writeFakeLinuxDesktopIcon({
      homeDir,
      desktopFileName: "good-ideas.desktop",
      desktopContent: [
        "[Desktop Entry]",
        "Name=Good Ideas",
        "StartupWMClass=GoodIdeas",
        "Exec=good-ideas %F",
        "Icon=good-ideas-test-icon",
      ].join("\n"),
      iconName: "good-ideas-test-icon",
      bytes: new Uint8Array([137, 80, 78, 71, 10, 11, 12]),
    });

    await expect(
      resolveCachedEditorIcon({
        editorId: "idea",
        cacheDir,
        platform: "linux",
        env: { HOME: homeDir, PATH: "", XDG_DATA_DIRS: "" },
      }),
    ).resolves.toBeNull();
  });

  it("short-circuits repeated missing native icon lookups briefly", async () => {
    const homeDir = makeTempDir("synara-editor-icon-linux-negative-home-");
    const cacheDir = makeTempDir("synara-editor-icon-linux-negative-cache-");
    const lookup = {
      editorId: "ghostty",
      cacheDir,
      platform: "linux" as const,
      env: { HOME: homeDir, PATH: "", XDG_DATA_DIRS: "" },
    };

    await expect(resolveCachedEditorIcon(lookup)).resolves.toBeNull();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 14, 15]);
    writeFakeLinuxDesktopIcon({
      homeDir,
      desktopFileName: "com.mitchellh.ghostty.desktop",
      desktopContent: [
        "[Desktop Entry]",
        "Name=Ghostty",
        "Exec=ghostty",
        "Icon=ghostty-test-icon",
      ].join("\n"),
      iconName: "ghostty-test-icon",
      bytes,
    });

    await expect(resolveCachedEditorIcon(lookup)).resolves.toBeNull();

    clearEditorIconInFlightCache();
    const icon = await resolveCachedEditorIcon(lookup);

    expect(icon?.contentType).toBe("image/png");
    expect(icon ? fs.readFileSync(icon.path) : null).toEqual(Buffer.from(bytes));
  });

  it("returns null for unknown editor ids", async () => {
    await expect(
      resolveCachedEditorIcon({
        editorId: "missing-editor",
        cacheDir: makeTempDir("synara-editor-icon-missing-cache-"),
        platform: "darwin",
        env: { HOME: makeTempDir("synara-editor-icon-missing-home-"), PATH: "" },
      }),
    ).resolves.toBeNull();
  });
});
