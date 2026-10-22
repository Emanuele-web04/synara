import { open, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DesktopSafariAccessInfo, DesktopSafariFullDiskAccess } from "@synara/contracts";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

interface SafariAccessOptions {
  platform: NodeJS.Platform;
  systemVersion: string;
  execPath: string;
  appName: string;
  isTrustedRenderer: (id: number) => boolean;
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (path: string) => void;
  homeDir: string;
  fileSystem?: SafariAccessFileSystem;
}

/** Only the calls the probe needs, so tests never touch real Safari data. */
export interface SafariAccessFileSystem {
  /** Opens read-only and closes at once; contents are never read. */
  openAndClose: (path: string) => Promise<void>;
  /** Lists a directory; the names are discarded. */
  listDirectory: (path: string) => Promise<void>;
}

const PROBE_TIMEOUT_MS = 2_000;

const nodeFileSystem: SafariAccessFileSystem = {
  openAndClose: async (path) => {
    const handle = await open(path, "r");
    await handle.close();
  },
  listDirectory: async (path) => {
    await readdir(path);
  },
};

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/**
 * Probes Safari's TCC-protected data from the process that performs the cookie
 * read. A plain stat succeeds without Full Disk Access, so files are opened.
 * The cookie stores come first because the import reads them; the Safari folder
 * covers users without a cookie file, since listing it is also refused without
 * Full Disk Access.
 */
export async function probeSafariFullDiskAccess(
  homeDir: string,
  fileSystem: SafariAccessFileSystem = nodeFileSystem,
): Promise<DesktopSafariFullDiskAccess> {
  const probes = [
    () =>
      fileSystem.openAndClose(
        join(
          homeDir,
          "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
        ),
      ),
    () => fileSystem.openAndClose(join(homeDir, "Library/Cookies/Cookies.binarycookies")),
    () => fileSystem.listDirectory(join(homeDir, "Library/Safari")),
  ];
  let expired = false;
  const run = async (): Promise<DesktopSafariFullDiskAccess> => {
    for (const probe of probes) {
      // An in-flight filesystem call cannot be cancelled; do not start a new
      // protected-path access after the startup probe has already timed out.
      if (expired) return "unknown";
      try {
        await probe();
        return "granted";
      } catch (error) {
        const code = errorCode(error);
        if (code === "EPERM" || code === "EACCES") return "denied";
        // Missing data, or any other failure, proves nothing; try the next source.
      }
    }
    return "unknown";
  };
  // The renderer waits for this answer before startup surfaces, so a stuck
  // filesystem must not hold them back.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DesktopSafariFullDiskAccess>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve("unknown");
    }, PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function getSafariAccessInfo(options: SafariAccessOptions): DesktopSafariAccessInfo {
  if (options.platform !== "darwin") return { supported: false };
  const bundle = dirname(dirname(dirname(options.execPath)));
  const appPath = bundle.endsWith(".app") ? bundle : null;
  return {
    supported: true,
    appName: appPath ? basename(appPath, ".app") : options.appName,
    appPath,
  };
}

export function registerSafariAccessIpc(ipcMain: IpcMain, options: SafariAccessOptions): void {
  const handle = (channel: string, action: () => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent) => {
      if (
        !options.isTrustedRenderer(event.sender.id) ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        throw new Error("Safari setup access denied.");
      }
      return action();
    });
  };
  const info = getSafariAccessInfo(options);
  // Probed per request, never cached: macOS applies a new grant after a relaunch.
  handle(DESKTOP_IPC_CHANNELS.safariAccess.getInfo, async () =>
    info.supported
      ? {
          ...info,
          fullDiskAccess: await probeSafariFullDiskAccess(options.homeDir, options.fileSystem),
        }
      : info,
  );
  handle(DESKTOP_IPC_CHANNELS.safariAccess.openSettings, async () => {
    if (!info.supported) return false;
    const pane =
      Number.parseInt(options.systemVersion, 10) >= 13
        ? "com.apple.settings.PrivacySecurity.extension"
        : "com.apple.preference.security";
    try {
      // A successful URL open says nothing about the app's TCC authorization.
      await options.openExternal(`x-apple.systempreferences:${pane}?Privacy_AllFiles`);
      return true;
    } catch {
      return false;
    }
  });
  handle(DESKTOP_IPC_CHANNELS.safariAccess.revealApp, () => {
    if (!info.supported || !info.appPath) return false;
    try {
      options.showItemInFolder(info.appPath);
      return true;
    } catch {
      return false;
    }
  });
}
