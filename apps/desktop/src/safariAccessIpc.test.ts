import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import {
  getSafariAccessInfo,
  probeSafariFullDiskAccess,
  registerSafariAccessIpc,
  type SafariAccessFileSystem,
} from "./safariAccessIpc";

const HOME = "/Users/tester";
const CONTAINER_COOKIES = `${HOME}/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies`;
const LEGACY_COOKIES = `${HOME}/Library/Cookies/Cookies.binarycookies`;
const SAFARI_DIR = `${HOME}/Library/Safari`;

function fsError(code: string) {
  return Object.assign(new Error(`${code}: private OS detail`), { code });
}

/** Each path either opens/lists or fails with the given errno code. */
function fakeFileSystem(outcomes: Record<string, string | "ok"> = {}) {
  const attempt = vi.fn(async (path: string) => {
    const outcome = outcomes[path] ?? "ENOENT";
    if (outcome !== "ok") throw fsError(outcome);
  });
  const fileSystem: SafariAccessFileSystem = {
    openAndClose: attempt,
    listDirectory: attempt,
  };
  return { fileSystem, attempt };
}

function setup(platform: NodeJS.Platform = "darwin", systemVersion = "26.0") {
  const options = {
    platform,
    systemVersion,
    execPath: "/Applications/Synara (Dev).app/Contents/MacOS/Synara",
    appName: "Synara",
    isTrustedRenderer: (id: number) => id === 1,
    openExternal: vi.fn(async (_url: string) => {}),
    showItemInFolder: vi.fn(),
    homeDir: HOME,
    fileSystem: fakeFileSystem({ [CONTAINER_COOKIES]: "EPERM" }).fileSystem,
  };
  type Handler = (event: IpcMainInvokeEvent) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: (name: string, handler: Handler) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name),
  };
  registerSafariAccessIpc(ipc as unknown as IpcMain, options);
  const mainFrame = {};
  const event = {
    sender: { id: 1, mainFrame },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
  const call = (method: keyof typeof DESKTOP_IPC_CHANNELS.safariAccess, input = event) =>
    handlers.get(DESKTOP_IPC_CHANNELS.safariAccess[method])!(input);
  return { options, call, event };
}

describe("Safari access setup IPC", () => {
  it("identifies the running bundle, not a hard-coded production app", async () => {
    const { options, call } = setup();
    await expect(call("getInfo")).resolves.toEqual({
      supported: true,
      appName: "Synara (Dev)",
      appPath: "/Applications/Synara (Dev).app",
      fullDiskAccess: "denied",
    });
    expect(options.openExternal).not.toHaveBeenCalled();
    await expect(call("revealApp")).resolves.toBe(true);
    expect(options.showItemInFolder).toHaveBeenCalledExactlyOnceWith(
      "/Applications/Synara (Dev).app",
    );
    expect(getSafariAccessInfo({ ...options, execPath: "/usr/bin/synara" })).toEqual({
      supported: true,
      appName: "Synara",
      appPath: null,
    });
  });

  it.each([
    ["26.0", "com.apple.settings.PrivacySecurity.extension"],
    ["13.0", "com.apple.settings.PrivacySecurity.extension"],
    ["12.7", "com.apple.preference.security"],
  ])(
    "opens the supported settings URL on macOS %s without claiming permission",
    async (version, pane) => {
      const { options, call } = setup("darwin", version);
      await expect(call("openSettings")).resolves.toBe(true);
      expect(options.openExternal).toHaveBeenCalledExactlyOnceWith(
        `x-apple.systempreferences:${pane}?Privacy_AllFiles`,
      );
      expect(await call("getInfo")).not.toHaveProperty("granted");
      options.openExternal.mockRejectedValueOnce(new Error("private OS error"));
      await expect(call("openSettings")).resolves.toBe(false);
    },
  );

  it.each(["win32", "linux", "freebsd"] as const)("does nothing on %s", async (platform) => {
    const { options, call } = setup(platform);
    await expect(call("getInfo")).resolves.toEqual({ supported: false });
    await expect(call("openSettings")).resolves.toBe(false);
    await expect(call("revealApp")).resolves.toBe(false);
    expect(options.openExternal).not.toHaveBeenCalled();
    expect(options.showItemInFolder).not.toHaveBeenCalled();
  });

  it("rejects browser pages and subframes for every setup operation", async () => {
    const { options, call, event } = setup();
    for (const method of ["getInfo", "openSettings", "revealApp"] as const) {
      await expect(
        call(method, { ...event, senderFrame: {} } as IpcMainInvokeEvent),
      ).rejects.toThrow("access denied");
      await expect(
        call(method, { ...event, sender: { ...event.sender, id: 9 } } as IpcMainInvokeEvent),
      ).rejects.toThrow("access denied");
    }
    expect(options.openExternal).not.toHaveBeenCalled();
    expect(options.showItemInFolder).not.toHaveBeenCalled();
  });

  it.each([
    ["the Safari container cookies open", { [CONTAINER_COOKIES]: "ok" }, "granted", 1],
    ["the legacy cookies open", { [LEGACY_COOKIES]: "ok" }, "granted", 2],
    ["only the Safari folder lists", { [SAFARI_DIR]: "ok" }, "granted", 3],
    ["the container cookies are EPERM", { [CONTAINER_COOKIES]: "EPERM" }, "denied", 1],
    ["the legacy cookies are EACCES", { [LEGACY_COOKIES]: "EACCES" }, "denied", 2],
    ["only the Safari folder is EPERM", { [SAFARI_DIR]: "EPERM" }, "denied", 3],
    ["no Safari data exists", {}, "unknown", 3],
    ["probes fail for other reasons", { [CONTAINER_COOKIES]: "EISDIR" }, "unknown", 3],
  ] as const)("reports %s as %s", async (_name, outcomes, expected, attempts) => {
    const { fileSystem, attempt } = fakeFileSystem(outcomes);
    await expect(probeSafariFullDiskAccess(HOME, fileSystem)).resolves.toBe(expected);
    expect(attempt).toHaveBeenCalledTimes(attempts);
  });

  it("probes in read order and lists the Safari folder only as a fallback", async () => {
    const missing = async () => {
      throw fsError("ENOENT");
    };
    const fileSystem = { openAndClose: vi.fn(missing), listDirectory: vi.fn(missing) };
    await probeSafariFullDiskAccess(HOME, fileSystem);
    expect(fileSystem.openAndClose.mock.calls).toEqual([[CONTAINER_COOKIES], [LEGACY_COOKIES]]);
    expect(fileSystem.listDirectory.mock.calls).toEqual([[SAFARI_DIR]]);
  });

  it("re-probes on every info request so a relaunch grant is picked up", async () => {
    const { options, call } = setup();
    const outcomes: Record<string, string> = { [CONTAINER_COOKIES]: "EPERM" };
    options.fileSystem = {
      openAndClose: async (path) => {
        const outcome = outcomes[path] ?? "ENOENT";
        if (outcome !== "ok") throw fsError(outcome);
      },
      listDirectory: async () => {
        throw fsError("ENOENT");
      },
    };
    await expect(call("getInfo")).resolves.toMatchObject({ fullDiskAccess: "denied" });
    outcomes[CONTAINER_COOKIES] = "ok";
    await expect(call("getInfo")).resolves.toMatchObject({ fullDiskAccess: "granted" });
  });

  it("does not start another protected-path probe after its deadline", async () => {
    vi.useFakeTimers();
    try {
      let rejectFirst!: (reason: Error) => void;
      const openAndClose = vi.fn(async () => {});
      openAndClose.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      );
      const listDirectory = vi.fn(async () => {});
      const result = probeSafariFullDiskAccess(HOME, { openAndClose, listDirectory });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toBe("unknown");
      // A slow filesystem can report absence after the caller already timed out.
      rejectFirst(fsError("ENOENT"));
      await vi.advanceTimersByTimeAsync(0);
      expect(openAndClose).toHaveBeenCalledTimes(1);
      expect(listDirectory).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold startup on a stuck filesystem", async () => {
    vi.useFakeTimers();
    try {
      const stuck = vi.fn(() => new Promise<void>(() => {}));
      const result = probeSafariFullDiskAccess(HOME, {
        openAndClose: stuck,
        listDirectory: stuck,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles Finder failure without exposing OS details", async () => {
    const { options, call } = setup();
    options.showItemInFolder.mockImplementationOnce(() => {
      throw new Error("private OS error");
    });
    await expect(call("revealApp")).resolves.toBe(false);
  });
});
