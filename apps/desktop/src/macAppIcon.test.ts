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
});
