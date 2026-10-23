// FILE: linuxAppIcon.ts
// Purpose: Apply the app-icon preference on Linux desktops that draw app and window icons
//          from the XDG icon theme.
// Layer: Desktop-native preference utility
//
// Wayland has no per-window icon in the protocols Electron uses (`setIcon` only reaches
// X11/XWayland windows). Docks, panels and launchers on Linux match the window's app_id to a
// desktop entry and draw that entry's `Icon=` name from the icon theme. The data home is
// searched before every system data dir. Override only this flavor's packaged icon name;
// user-customized entries and other app/flavor names retain their own artwork.

import * as FS from "node:fs";
import * as Path from "node:path";

import { synaraDesktopIdentity, type SynaraDesktopFlavor } from "@synara/shared/desktopIdentity";

/** Sizes the hicolor index declares under `apps`; larger artwork would be ignored. */
export const LINUX_APP_ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512] as const;

const ICON_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Icon name of the `[Desktop Entry]` group, the only group that carries the app's own icon.
 * Null when the entry has no usable name: an absolute path belongs to whoever wrote the
 * entry and there is no theme name to cover.
 */
export function desktopEntryIconName(contents: string): string | null {
  let inDesktopEntry = false;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inDesktopEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inDesktopEntry || !line.startsWith("Icon=")) continue;
    const value = line.slice("Icon=".length).trim();
    return ICON_NAME_PATTERN.test(value) ? value : null;
  }
  return null;
}

/**
 * Icon name of the first desktop entry found for this app, searched in XDG precedence
 * (data home, then each data dir). Null when no entry exists or its icon was customized;
 * a customized higher-priority entry must not fall through to a system entry.
 */
export function resolveLinuxDesktopIconName(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly flavor: SynaraDesktopFlavor;
}): string | null {
  const dataHome = linuxDataHome(input.env, input.homeDir);
  const dataDirs = (input.env.XDG_DATA_DIRS?.trim() || "/usr/local/share:/usr/share")
    .split(":")
    .filter((directory) => Path.isAbsolute(directory));
  // Packaging uses this identity for both the executable/desktop filename and Icon= name.
  // Never repaint another flavor or an unrelated icon named by a user-customized entry.
  const iconName = synaraDesktopIdentity(input.flavor).userDataDirectoryName;
  const fileName = `${iconName}.desktop`;
  for (const directory of [dataHome, ...dataDirs]) {
    let contents: string;
    try {
      contents = FS.readFileSync(Path.join(directory, "applications", fileName), "utf8");
    } catch {
      continue;
    }
    return desktopEntryIconName(contents) === iconName ? iconName : null;
  }
  return null;
}

export function linuxDataHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configured = env.XDG_DATA_HOME?.trim();
  return configured && Path.isAbsolute(configured)
    ? configured
    : Path.join(homeDir, ".local", "share");
}

/**
 * Writes `renderPng(size)` as `<dataHome>/icons/hicolor/<size>x<size>/apps/<iconName>.png`.
 * Unchanged files are left alone so restarts do not invalidate icon caches. Returns
 * whether any file changed.
 */
export function persistLinuxAppIcon(input: {
  readonly dataHome: string;
  readonly iconName: string;
  readonly renderPng: (size: number) => Buffer;
}): boolean {
  if (!ICON_NAME_PATTERN.test(input.iconName)) {
    throw new Error(`Refusing to write an icon for unsafe name: ${input.iconName}`);
  }
  let changed = false;
  for (const size of LINUX_APP_ICON_SIZES) {
    const directory = Path.join(input.dataHome, "icons", "hicolor", `${size}x${size}`, "apps");
    const target = Path.join(directory, `${input.iconName}.png`);
    const png = input.renderPng(size);
    try {
      if (FS.readFileSync(target).equals(png)) continue;
    } catch {
      // Missing or unreadable: write it.
    }
    FS.mkdirSync(directory, { recursive: true });
    // Rename over the old file so a dock reading mid-update never sees a truncated PNG.
    const temporary = `${target}.${process.pid}.tmp`;
    FS.writeFileSync(temporary, png);
    FS.renameSync(temporary, target);
    changed = true;
  }
  return changed;
}
