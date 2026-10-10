import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { execProcessFile } from "@synara/shared/processRuntime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { persistMacAppIcon } from "./macAppIcon";

vi.mock("@synara/shared/processRuntime", () => ({ execProcessFile: vi.fn() }));

let cacheDirectory: string;
const bundlePath = "/Applications/Synara's $(literal) App.app";

beforeEach(async () => {
  cacheDirectory = await FS.mkdtemp(Path.join(OS.tmpdir(), "synara-mac-icon-test-"));
  vi.mocked(execProcessFile).mockReset();
  vi.mocked(execProcessFile).mockImplementation((_command, _args, _options, callback) => {
    callback(null, "", "");
    return {} as ReturnType<typeof execProcessFile>;
  });
});

afterEach(async () => {
  await FS.rm(cacheDirectory, { recursive: true, force: true });
});

describe("persistent macOS app icons", () => {
  it("materializes artwork outside ASAR and passes paths as literal arguments", async () => {
    const png = Buffer.from("artwork read by Electron from app.asar");
    await persistMacAppIcon({ bundlePath, cacheDirectory, png });

    const [command, args, options] = vi.mocked(execProcessFile).mock.calls[0]!;
    expect(command).toBe("/usr/bin/osascript");
    expect(args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(args[3]).not.toContain(bundlePath);
    expect(args[4]).toBe(bundlePath);
    expect(Path.dirname(args[5]!)).toBe(cacheDirectory);
    expect(await FS.readFile(args[5]!)).toEqual(png);
    expect(options.timeout).toBe(5_000);
  });

  it("uses different cache paths when an update changes the artwork", async () => {
    await persistMacAppIcon({ bundlePath, cacheDirectory, png: Buffer.from("old") });
    await persistMacAppIcon({ bundlePath, cacheDirectory, png: Buffer.from("new") });
    const calls = vi.mocked(execProcessFile).mock.calls;
    expect(calls[0]![1][5]).not.toBe(calls[1]![1][5]);
  });

  it("restores the appearance-aware bundle icon without loading an image", async () => {
    await persistMacAppIcon({ bundlePath, cacheDirectory, png: null });

    expect(vi.mocked(execProcessFile).mock.calls[0]![1].slice(4)).toEqual([bundlePath, ""]);
    expect(await FS.readdir(cacheDirectory)).toEqual([]);
  });

  it("propagates native failures and permits an explicit retry", async () => {
    const error = new Error("The application is read-only");
    vi.mocked(execProcessFile).mockImplementationOnce((_command, _args, _options, callback) => {
      callback(error, "", "");
      return {} as ReturnType<typeof execProcessFile>;
    });
    await expect(persistMacAppIcon({ bundlePath, cacheDirectory, png: null })).rejects.toBe(error);
    await expect(
      persistMacAppIcon({ bundlePath, cacheDirectory, png: null }),
    ).resolves.toBeUndefined();
  });

  it("re-stamps a replacement bundle even when its directory mtime is preserved", async () => {
    const target = Path.join(cacheDirectory, "Synara.app");
    await FS.mkdir(target);
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    await FS.utimes(target, fixedTime, fixedTime);
    const original = await FS.stat(target);
    const input = { bundlePath: target, cacheDirectory, png: null };

    await persistMacAppIcon(input);
    await persistMacAppIcon(input);
    expect(execProcessFile).toHaveBeenCalledTimes(1);

    // Keep the old inode allocated so the fresh app cannot reuse its identity.
    await FS.rename(target, `${target}.previous`);
    await FS.mkdir(target);
    await FS.utimes(target, fixedTime, fixedTime);
    const replacement = await FS.stat(target);
    expect(replacement.mtimeMs).toBe(original.mtimeMs);
    expect(replacement.ino).not.toBe(original.ino);

    await persistMacAppIcon(input);
    expect(execProcessFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execProcessFile).mock.calls[1]![1][4]).toBe(target);
  });

  it("records the bundle after a successful native write and retries a failed new choice", async () => {
    const target = Path.join(cacheDirectory, "Synara.app");
    await FS.mkdir(target);
    // Native custom-icon writes change the bundle directory's metadata.
    vi.mocked(execProcessFile).mockImplementationOnce((_command, _args, _options, callback) => {
      void FS.writeFile(Path.join(target, "Icon"), "custom icon metadata").then(() => {
        callback(null, "", "");
      });
      return {} as ReturnType<typeof execProcessFile>;
    });
    const input = { bundlePath: target, cacheDirectory, png: Buffer.from("old artwork") };
    await persistMacAppIcon(input);
    await persistMacAppIcon(input);
    expect(execProcessFile).toHaveBeenCalledTimes(1);

    const failure = new Error("The app is temporarily not writable");
    vi.mocked(execProcessFile).mockImplementationOnce((_command, _args, _options, callback) => {
      callback(failure, "", "");
      return {} as ReturnType<typeof execProcessFile>;
    });
    const changed = { ...input, png: Buffer.from("new artwork") };
    await expect(persistMacAppIcon(changed)).rejects.toBe(failure);
    await persistMacAppIcon(changed);
    expect(execProcessFile).toHaveBeenCalledTimes(3);
  });

  it("retries when the bundle is replaced while a native write is completing", async () => {
    const target = Path.join(cacheDirectory, "Synara.app");
    await FS.mkdir(target);
    vi.mocked(execProcessFile).mockImplementationOnce((_command, _args, _options, callback) => {
      void FS.rename(target, `${target}.previous`).then(async () => {
        await FS.mkdir(target);
        callback(null, "", "");
      });
      return {} as ReturnType<typeof execProcessFile>;
    });
    const input = { bundlePath: target, cacheDirectory, png: null };

    await persistMacAppIcon(input);
    await persistMacAppIcon(input);
    expect(execProcessFile).toHaveBeenCalledTimes(2);
  });
});
