import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserVault } from "./browserVault";
import { BrowserPasswordImport } from "./browserPasswordImport";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let home: string;

function encryptPassword(value: string) {
  const key = pbkdf2Sync("test-safe-storage", "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  try {
    return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]);
  } finally {
    key.fill(0);
  }
}

async function makeProfile() {
  const profile = join(home, "Library", "Application Support", "Google", "Chrome", "Default");
  await mkdir(profile, { recursive: true });
  await mkdir(join(home, "Applications", "Google Chrome.app"), { recursive: true });
  const database = new DatabaseSync(join(profile, "Login Data"));
  database.exec(
    "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER, date_last_used INTEGER)",
  );
  database
    .prepare("INSERT INTO logins VALUES (?, ?, ?, ?, ?)")
    .run("https://accounts.example.test/login", "alice", encryptPassword("synthetic-secret"), 0, 1);
  database.close();
}

beforeEach(async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  home = await mkdtemp(join(tmpdir(), "synara-password-import-"));
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  await rm(home, { recursive: true, force: true });
});

describe("browser password import", () => {
  it.each([null, undefined, "unavailable"])(
    "reports an unstructured Keychain rejection without reading or storing passwords: %s",
    async (failure) => {
      await makeProfile();
      const vault = {
        snapshot: vi.fn(async () => ({ protection: { locked: false } })),
        importPasswords: vi.fn(),
      } as unknown as BrowserVault;
      const result = await new BrowserPasswordImport(
        vault,
        async () => {
          throw failure;
        },
        home,
      ).import({ browser: "chrome", profile: "Default", confirmed: true });
      expect(result).toEqual({ ok: false, code: "keychain_unavailable", platform: "macos" });
      expect(vault.importPasswords).not.toHaveBeenCalled();
    },
  );

  it("reads one selected installed Chrome profile and inserts it into the unlocked vault", async () => {
    await makeProfile();
    const keychain = vi.fn(async () => "test-safe-storage");
    let received: Array<{ origin: string; username: string; password: string }> = [];
    const importPasswords = vi.fn(
      async (entries: Array<{ origin: string; username: string; password: string }>) => {
        received = structuredClone(entries);
        return { imported: 1, skipped: 0, provenanceSaved: true };
      },
    );
    const vault = {
      snapshot: vi.fn(async () => ({ protection: { locked: false } })),
      importPasswords,
    } as unknown as BrowserVault;

    const result = await new BrowserPasswordImport(vault, keychain, home).import({
      browser: "chrome",
      profile: "Default",
      confirmed: true,
    });

    expect(result).toEqual({ ok: true, imported: 1, skipped: 0, warnings: [] });
    expect(keychain).toHaveBeenCalledOnce();
    expect(received).toEqual([
      {
        origin: "https://accounts.example.test",
        username: "alice",
        password: "synthetic-secret",
      },
    ]);
  });

  it("does not ask for Keychain access before the vault is unlocked", async () => {
    await makeProfile();
    const keychain = vi.fn(async () => "test-safe-storage");
    const vault = {
      snapshot: vi.fn(async () => ({ protection: { locked: true } })),
      importPasswords: vi.fn(),
    } as unknown as BrowserVault;

    const result = await new BrowserPasswordImport(vault, keychain, home).import({
      browser: "chrome",
      profile: "Default",
      confirmed: true,
    });

    expect(result).toEqual({ ok: false, code: "vault_locked", platform: "macos" });
    expect(keychain).not.toHaveBeenCalled();
  });

  it("rejects non-macOS keychain decryption before any read or prompt", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    const keychain = vi.fn(async () => "test-safe-storage");
    const vault = { snapshot: vi.fn(), importPasswords: vi.fn() } as unknown as BrowserVault;

    const result = await new BrowserPasswordImport(vault, keychain, home).import({
      browser: "chrome",
      profile: "Default",
      confirmed: true,
    });

    expect(result).toEqual({ ok: false, code: "unsupported_platform", platform: "linux" });
    expect(keychain).not.toHaveBeenCalled();
    expect(vault.snapshot).not.toHaveBeenCalled();
  });
});

it("reads only the requested profile and never scans a broken unrelated browser", async () => {
  await makeProfile();
  const unrelated = join(home, "Library", "Application Support", "Microsoft Edge", "Default");
  await mkdir(unrelated, { recursive: true });
  await mkdir(join(home, "Applications", "Microsoft Edge.app"), { recursive: true });
  const db = new DatabaseSync(join(unrelated, "Login Data"));
  db.exec(
    "CREATE VIEW logins AS SELECT zeroblob(1000000000) AS password_value, 0 AS blacklisted_by_user",
  );
  db.close();
  const vault = {
    snapshot: vi.fn(async () => ({ protection: { locked: false } })),
    importPasswords: vi.fn(async () => ({ imported: 1, skipped: 0, provenanceSaved: true })),
  } as unknown as BrowserVault;
  expect(
    await new BrowserPasswordImport(vault, async () => "test-safe-storage", home).import({
      browser: "chrome",
      profile: "Default",
      confirmed: true,
    }),
  ).toMatchObject({ ok: true, imported: 1 });
});

it("cancels only the matching password operation before vault writes", async () => {
  await makeProfile();
  const vault = {
    snapshot: vi.fn(async () => ({ protection: { locked: false } })),
    importPasswords: vi.fn(async () => ({ imported: 1, skipped: 0, provenanceSaved: true })),
  } as unknown as BrowserVault;
  let signal!: AbortSignal;
  const keychain = vi.fn(
    (_browser: string, nextSignal?: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal = nextSignal!;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  const importer = new BrowserPasswordImport(vault, keychain, home);
  const pending = importer.import({
    browser: "chrome",
    profile: "Default",
    confirmed: true,
    operationId: "first",
  });
  await vi.waitFor(() => expect(keychain).toHaveBeenCalled());
  importer.cancel("another-operation");
  expect(signal.aborted).toBe(false);
  importer.cancel("first");
  expect(await pending).toEqual({ ok: false, code: "cancelled", platform: "macos" });
  expect(vault.importPasswords).not.toHaveBeenCalled();
  keychain.mockImplementation(async () => "test-safe-storage");
  const next = importer.import({
    browser: "chrome",
    profile: "Default",
    confirmed: true,
    operationId: "second",
  });
  importer.cancel("first");
  expect(await next).toMatchObject({ ok: true, imported: 1 });
});

it.each(["EACCES", "EPERM", "ENOENT", "EIO"])(
  "returns structured preflight errors for %s",
  async (code) => {
    const vault = { snapshot: vi.fn(), importPasswords: vi.fn() } as unknown as BrowserVault;
    const keychain = vi.fn();
    const importer = new BrowserPasswordImport(vault, keychain, home, async () => {
      throw Object.assign(new Error("private path"), { code });
    });
    expect(
      await importer.import({ browser: "chrome", profile: "Default", confirmed: true }),
    ).toEqual({
      ok: false,
      code:
        code === "EACCES" || code === "EPERM"
          ? "permission_denied"
          : code === "ENOENT"
            ? "source_missing"
            : "reader_failed",
      platform: "macos",
    });
    expect(keychain).not.toHaveBeenCalled();
    expect(vault.importPasswords).not.toHaveBeenCalled();
  },
);

it("reads Login Data without touching an inaccessible Network cookie directory", async () => {
  await makeProfile();
  const network = join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "Default",
    "Network",
  );
  await mkdir(network);
  await chmod(network, 0);
  try {
    const vault = {
      snapshot: async () => ({ protection: { locked: false } }),
      importPasswords: vi.fn(async () => ({ imported: 1, skipped: 0, provenanceSaved: true })),
    } as unknown as BrowserVault;
    const result = await new BrowserPasswordImport(
      vault,
      async () => "test-safe-storage",
      home,
    ).import({ browser: "chrome", profile: "Default", confirmed: true });
    expect(result).toMatchObject({ ok: true, imported: 1 });
    expect(vault.importPasswords).toHaveBeenCalledOnce();
  } finally {
    await chmod(network, 0o700);
  }
});
