import type { ExecFileException } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));
const ownership = vi.hoisted(() => ({
  cuaHostProcessIsAlive: vi.fn((_pid: number) => false),
  sweepOwnedCuaRuntimeDirectories: vi.fn(
    (_options: { directory: string; liveSocketDirs: ReadonlySet<string> }) => [] as string[],
  ),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: childProcess.execFile,
  execFileSync: childProcess.execFileSync,
}));
vi.mock("./cuaRuntimeOwnership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cuaRuntimeOwnership")>()),
  cuaHostProcessIsAlive: ownership.cuaHostProcessIsAlive,
  sweepOwnedCuaRuntimeDirectories: ownership.sweepOwnedCuaRuntimeDirectories,
}));

const { sweepOrphanedCuaDriversInBackground } = await import("./cuaDriverHost");

const LISTING = [
  "  PID ARGS",
  " 4242 /Applications/Synara.app/cua-driver serve --embedded --socket /tmp/synara-cua-a/driver.sock",
  " 4343 /usr/bin/some-other-tool --flag",
].join("\n");

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("sweepOrphanedCuaDriversInBackground", () => {
  it("reaps a driver whose host died, reading the process list without blocking", async () => {
    childProcess.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: ExecFileException | null, stdout: string) => void,
      ) => {
        setImmediate(() => callback(null, LISTING));
      },
    );
    childProcess.execFileSync.mockReturnValue("cua-driver CUA_DRIVER_EMBEDDED_HOST_PID=999 serve");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await sweepOrphanedCuaDriversInBackground();

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "ps",
      ["-axo", "pid,args"],
      expect.anything(),
      expect.any(Function),
    );
    expect(childProcess.execFileSync).not.toHaveBeenCalledWith(
      "ps",
      ["-axo", "pid,args"],
      expect.anything(),
    );
    expect(ownership.cuaHostProcessIsAlive).toHaveBeenCalledWith(999);
    expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
    expect(ownership.sweepOwnedCuaRuntimeDirectories).toHaveBeenCalledWith(
      expect.objectContaining({ liveSocketDirs: new Set(["/tmp/synara-cua-a"]) }),
    );
  });

  it("leaves every driver alone when the process list cannot be read", async () => {
    childProcess.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: ExecFileException | null, stdout: string) => void,
      ) => {
        setImmediate(() => callback(new Error("ps failed"), ""));
      },
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await sweepOrphanedCuaDriversInBackground();

    expect(kill).not.toHaveBeenCalled();
    expect(ownership.sweepOwnedCuaRuntimeDirectories).not.toHaveBeenCalled();
  });
});
