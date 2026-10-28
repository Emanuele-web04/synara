// FILE: providerUsage/providers/cursorSafeStorage.test.ts
// Purpose: Cursor safe-storage envelope detection, bounded "Cursor Safe Storage" keychain
// reads, and os_crypt v10 token decryption — all with synthetic fixtures, never real
// credentials or a real keychain.

import * as childProcess from "node:child_process";
import { createCipheriv, pbkdf2Sync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isCursorSafeStorageValue, unsealCursorSafeStorageValue } from "./cursorSafeStorage";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, execFile: vi.fn() };
});
const { execFile: realExecFile } = await vi.importActual<typeof childProcess>("node:child_process");

const ctx = {
  homeDir: "/fixture-home",
  env: { AWS_SECRET_ACCESS_KEY: "not-for-child", NODE_OPTIONS: "not-for-child" },
  platform: "darwin" as const,
};

const FIXTURE_JWT = `${"a".repeat(20)}.${Buffer.from(
  JSON.stringify({ sub: "user-1", exp: 4_102_444_800 }),
).toString("base64url")}.${"b".repeat(20)}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// Run only our fake CLI, never an OS credential utility, on every host.
function fakeCli(script: string) {
  let child: childProcess.ChildProcess | undefined;
  const spy = vi.mocked(childProcess.execFile).mockImplementation(((
    _file: string,
    _args: string[],
    options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (
      error: childProcess.ExecFileException | null,
      stdout: string,
      stderr: string,
    ) => void,
  ) => {
    child = realExecFile(
      process.execPath,
      ["-e", script],
      { ...options, cwd: undefined },
      callback,
    );
    return child;
  }) as typeof childProcess.execFile);
  return { spy, child: () => child };
}

// Synthetic Cursor >= 3.27 cell: "cursor-safe-storage:v1:" + base64("v10" + AES-128-CBC).
function sealToken(plaintext: string | Buffer, password: string): string {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const blob = Buffer.concat([
    Buffer.from("v10", "ascii"),
    cipher.update(plaintext),
    cipher.final(),
  ]);
  key.fill(0);
  return `cursor-safe-storage:v1:${blob.toString("base64")}`;
}

describe("isCursorSafeStorageValue", () => {
  it.each([
    ["envelope v1", `cursor-safe-storage:v1:${"QUJD".repeat(8)}`, true],
    ["envelope of an unknown version", "cursor-safe-storage:v9:AAAA", true],
    ["a raw os_crypt blob coerced to text", "v10�ciphertext", true],
    ["a raw v11 blob coerced to text", "v11�ciphertext", true],
    ["a plain JWT", FIXTURE_JWT, false],
    ["an opaque printable token", "v10opaque-looking-token", false],
  ])("detects %s", (_label, value, expected) => {
    expect(isCursorSafeStorageValue(value)).toBe(expected);
  });
});

describe("unsealCursorSafeStorageValue", () => {
  it("reads the key through a bounded process and unseals a v10 JWT", async () => {
    const fake = fakeCli('process.stdout.write("fixture-password\\n")');
    expect(
      await unsealCursorSafeStorageValue(ctx, sealToken(FIXTURE_JWT, "fixture-password")),
    ).toBe(FIXTURE_JWT);
    expect(fake.spy).toHaveBeenCalledWith(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Cursor Safe Storage", "-a", "Cursor", "-w"],
      expect.objectContaining({
        timeout: 3000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
        shell: false,
        env: { HOME: "/fixture-home", PATH: "/usr/bin:/bin" },
      }),
      expect.any(Function),
    );
  });

  it.each([
    ["an unknown envelope version", "cursor-safe-storage:v2:AAAA"],
    ["a missing envelope", FIXTURE_JWT],
    ["malformed base64", "cursor-safe-storage:v1:!!!"],
    ["an empty payload", "cursor-safe-storage:v1:"],
    ["a v11 blob", "cursor-safe-storage:v1:djExAAAAAAAAAAAAAAAAAAAAAA=="],
    ["truncated ciphertext", "cursor-safe-storage:v1:djEwAQ=="],
    ["excessive ciphertext", `cursor-safe-storage:v1:${"A".repeat(20_000)}`],
    ["a raw binary cell", "v10�\u0001ciphertext"],
  ])("rejects %s before touching the keychain", async (_label, stored) => {
    fakeCli('process.stdout.write("fixture-password")');
    expect(await unsealCursorSafeStorageValue(ctx, stored)).toBeNull();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it("rejects the wrong safe-storage password", async () => {
    fakeCli('process.stdout.write("other-password")');
    expect(
      await unsealCursorSafeStorageValue(ctx, sealToken(FIXTURE_JWT, "fixture-password")),
    ).toBeNull();
  });

  it("rejects decrypted plaintext that is not token-shaped", async () => {
    fakeCli('process.stdout.write("fixture-password")');
    const sealed = sealToken(Buffer.from("plain\x00text\x01binary", "latin1"), "fixture-password");
    expect(await unsealCursorSafeStorageValue(ctx, sealed)).toBeNull();
  });

  it.each([
    'process.stdout.write("secret"); process.stderr.write("secret"); process.exitCode = 1',
    'process.stdout.write("s".repeat(8192))',
  ])("discards child errors and excessive output without exposing secrets", async (script) => {
    fakeCli(script);
    expect(
      await unsealCursorSafeStorageValue(ctx, sealToken(FIXTURE_JWT, "fixture-password")),
    ).toBeNull();
  });

  it("resolves null when the process boundary throws", async () => {
    vi.mocked(childProcess.execFile).mockImplementation(() => {
      throw new Error("fixture failure");
    });
    expect(
      await unsealCursorSafeStorageValue(ctx, sealToken(FIXTURE_JWT, "fixture-password")),
    ).toBeNull();
  });

  it("never touches the keychain for an isolated account", async () => {
    fakeCli('process.stdout.write("fixture-password")');
    expect(
      await unsealCursorSafeStorageValue(
        { ...ctx, isolateCredentials: true },
        sealToken(FIXTURE_JWT, "fixture-password"),
      ),
    ).toBeNull();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("never touches the keychain on %s", async (platform) => {
    fakeCli('process.stdout.write("fixture-password")');
    expect(
      await unsealCursorSafeStorageValue(
        { ...ctx, platform },
        sealToken(FIXTURE_JWT, "fixture-password"),
      ),
    ).toBeNull();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});
