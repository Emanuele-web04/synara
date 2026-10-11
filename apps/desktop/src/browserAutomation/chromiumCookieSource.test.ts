import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import crypto from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const browsers = [
  ["helium", "net.imput.helium"],
  ["aside", "Aside"],
  ["dia", "Dia/User Data"],
] as const;
const password = "synthetic-cookie-import-key";
const host = ".example.test";
const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let home: string;
type Options = { source: { browser: string; profile: string }; timeoutMs: number };
type Snapshot = {
  detailedCookies: Array<{
    cookie: { name: string; value: string };
    context: Record<string, unknown>;
  }>;
  warnings: Array<{ code: string; count: number }>;
};
let reader: {
  listChromiumCookieSources(): Array<{ id: string; name: string }>;
  listChromiumProfiles(browser: string, home: string): Promise<Array<{ id: string }>>;
  readChromiumCookieSnapshot(
    options: Options,
    deps?: {
      home: string;
      keychainPassword?: (browser: string, timeout: number) => Promise<string>;
    },
  ): Promise<Snapshot>;
};
let sync: {
  normalizeCookieSyncOptions(options: { source: Options["source"]; domains?: string[] }): Options;
  extractCookieSync(
    options: Options,
    load: undefined | (() => Promise<{ read: (options: unknown) => Promise<Snapshot> }>),
    deps?: {
      home: string;
      keychainPassword: (browser: string, timeout: number) => Promise<string>;
    },
  ): Promise<{
    cookies: Array<{ name: string; value: string }>;
    source: { browser: string };
    warnings: Array<{ code: string; count: number }>;
  }>;
};
beforeAll(async () => {
  const base = dirname(createRequire(import.meta.url).resolve("betterwright"));
  reader = await import(pathToFileURL(join(base, "chromium-cookie-source.js")).href);
  sync = await import(pathToFileURL(join(base, "cookie-sync.js")).href);
});
beforeEach(async () => {
  Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
  home = await mkdtemp(join(tmpdir(), "synara-browser-import-"));
});
afterEach(async () => {
  Object.defineProperty(process, "platform", descriptor);
  await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});
function encrypted(value: string, binding = host, tag = "v10") {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  try {
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([
      createHash("sha256").update(binding).digest(),
      Buffer.from(value),
    ]);
    return Buffer.concat([Buffer.from(tag), cipher.update(plain), cipher.final()]);
  } finally {
    key.fill(0);
  }
}
async function profile(browser: readonly [string, string], network = false, name = "Default") {
  const path = join(
    home,
    "Library",
    "Application Support",
    browser[1],
    name,
    ...(network ? ["Network"] : []),
  );
  await mkdir(path, { recursive: true, mode: 0o700 });
  const file = join(path, "Cookies");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER); INSERT INTO meta VALUES ('version', 24);
    CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
      is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, expires_utc INTEGER, has_expires INTEGER,
      top_frame_site_key TEXT, has_cross_site_ancestor INTEGER, source_scheme INTEGER, source_port INTEGER);`);
  const insert = db.prepare(
    "INSERT INTO cookies VALUES (?, ?, '', ?, '/', 1, 1, 1, 0, 0, ?, 1, 2, 443)",
  );
  insert.run(host, "session", encrypted("synthetic-session"), "https://top.test");
  insert.run("other.test", "unrelated", encrypted("unrelated-value", "other.test"), "");
  db.close();
  return file;
}
const options = (browser: string): Options => ({
  source: { browser, profile: "Default" },
  timeoutMs: 30_000,
});
const keychainPassword = vi.fn(async (_browser: string, _timeout: number) => password);

describe("macOS Chromium-family cookie sources", () => {
  it.each(browsers)(
    "discovers and decrypts %s through shared scope normalization",
    async (browser, dataDir) => {
      await profile([browser, dataDir]);
      expect(reader.listChromiumCookieSources()).toContainEqual({
        id: browser,
        name: expect.any(String),
        engine: "chromium",
      });
      expect(await reader.listChromiumProfiles(browser, home)).toEqual([
        { id: "Default", name: "Default", isDefault: true },
      ]);
      keychainPassword.mockClear();
      const result = await sync.extractCookieSync(
        sync.normalizeCookieSyncOptions({
          source: { browser, profile: "Default" },
          domains: ["example.test"],
        }),
        undefined,
        { home, keychainPassword },
      );
      expect(result.cookies).toHaveLength(1);
      expect(result.cookies[0]).toMatchObject({
        name: "session",
        value: "synthetic-session",
        httpOnly: true,
        secure: true,
        partitionKey: "https://top.test",
        partitionCrossSiteAncestor: true,
      });
      expect(result.source.browser).toBe(browser);
      expect(keychainPassword).toHaveBeenCalledExactlyOnceWith(browser, 15_000);
    },
  );
  it.each(browsers)(
    "supports the Network/Cookies layout and multiple %s profiles",
    async (browser, dataDir) => {
      await profile([browser, dataDir], true);
      await profile([browser, dataDir], false, "Profile 1");
      expect((await reader.listChromiumProfiles(browser, home)).map((x) => x.id)).toEqual([
        "Default",
        "Profile 1",
      ]);
      expect(
        (await reader.readChromiumCookieSnapshot(options(browser), { home, keychainPassword }))
          .detailedCookies,
      ).toHaveLength(2);
    },
  );
  it.each(browsers)(
    "fails closed for %s without the trusted Keychain owner",
    async (browser, dataDir) => {
      await profile([browser, dataDir]);
      await expect(
        reader.readChromiumCookieSnapshot(options(browser), { home }),
      ).rejects.toMatchObject({
        cookieReaderCode: "reader_unavailable",
        cookieReaderStage: "decrypt",
      });
    },
  );
  it("reuses the existing native Arc reader without custom Keychain acquisition", async () => {
    const native = { read: vi.fn(async () => ({ detailedCookies: [], warnings: [] })) };
    keychainPassword.mockClear();
    await sync.extractCookieSync(
      sync.normalizeCookieSyncOptions({ source: { browser: "arc", profile: "Default" } }),
      async () => native,
    );
    expect(native.read).toHaveBeenCalledWith(
      expect.objectContaining({ browser: "arc", profile: "Default", appBound: "disabled" }),
    );
    expect(keychainPassword).not.toHaveBeenCalled();
  });
  it("lists only profiles with cookie stores, without reading cookies or acquiring keys", async () => {
    for (const browser of browsers) await profile(browser);
    await mkdir(join(home, "Library", "Application Support", "Aside", "Empty"));
    keychainPassword.mockClear();
    expect(reader.listChromiumCookieSources().map((x) => x.id)).toEqual(browsers.map((x) => x[0]));
    expect((await reader.listChromiumProfiles("aside", home)).map((x) => x.id)).toEqual([
      "Default",
    ]);
    expect(keychainPassword).not.toHaveBeenCalled();
  });
  it.each(["linux", "win32"])("does not advertise macOS sources on %s", async (platform) => {
    await profile(browsers[0]);
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    expect(reader.listChromiumCookieSources()).toEqual([]);
    await expect(
      reader.readChromiumCookieSnapshot(options("helium"), { home, keychainPassword }),
    ).rejects.toMatchObject({ cookieReaderCode: "no_discovered_source" });
  });
  it.each(["../Default", "/tmp/private", "__proto__"])(
    "rejects unsupported profile or browser %s before Keychain access",
    async (input) => {
      await profile(browsers[0]);
      keychainPassword.mockClear();
      await expect(
        reader.readChromiumCookieSnapshot(
          {
            ...options(input === "__proto__" ? input : "helium"),
            source: { browser: input === "__proto__" ? input : "helium", profile: input },
          },
          { home, keychainPassword },
        ),
      ).rejects.toMatchObject({ cookieReaderCode: "no_selected_source" });
      expect(keychainPassword).not.toHaveBeenCalled();
    },
  );
  it("rejects symlinked profiles and cookie databases", async () => {
    const file = await profile(browsers[0]);
    const root = join(home, "Library", "Application Support", browsers[0][1]);
    const outside = join(home, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, "Linked"));
    expect((await reader.listChromiumProfiles("helium", home)).map((x) => x.id)).toEqual([
      "Default",
    ]);
    await rm(file);
    await writeFile(join(outside, "Cookies"), "private");
    await symlink(join(outside, "Cookies"), file);
    await expect(
      reader.readChromiumCookieSnapshot(options("helium"), { home, keychainPassword }),
    ).rejects.toMatchObject({ cookieReaderCode: "source_extraction_failed" });
  });
  it("validates v24 host binding and skips unknown tags instead of guessing", async () => {
    const file = await profile(browsers[0]);
    const db = new DatabaseSync(file);
    db.prepare("UPDATE cookies SET encrypted_value = ? WHERE name = 'session'").run(
      encrypted("private", "different.test"),
    );
    db.prepare("UPDATE cookies SET encrypted_value = ? WHERE name = 'unrelated'").run(
      encrypted("private", "other.test", "v11"),
    );
    db.close();
    const snapshot = await reader.readChromiumCookieSnapshot(options("helium"), {
      home,
      keychainPassword,
    });
    expect(snapshot.detailedCookies).toEqual([]);
    expect(snapshot.warnings).toEqual([{ code: "decrypt_failed", count: 2 }]);
  });
  it("preserves empty plaintext and encrypted cookie values and legacy column names", async () => {
    const file = await profile(browsers[0]);
    const db = new DatabaseSync(file);
    db.exec(
      "ALTER TABLE cookies RENAME COLUMN is_secure TO secure; ALTER TABLE cookies RENAME COLUMN is_httponly TO httponly",
    );
    db.prepare("UPDATE cookies SET encrypted_value = ? WHERE name = 'session'").run(encrypted(""));
    db.exec("UPDATE cookies SET value = '', encrypted_value = x'' WHERE name = 'unrelated'");
    db.close();
    const snapshot = await reader.readChromiumCookieSnapshot(options("helium"), {
      home,
      keychainPassword,
    });
    expect(snapshot.detailedCookies.map((x) => x.cookie.value)).toEqual(["", ""]);
  });
  it.each([false, true])(
    "clears the derived key after reading, including query failure=%s",
    async (fails) => {
      const file = await profile(browsers[0]);
      if (fails) {
        const db = new DatabaseSync(file);
        db.exec("DROP TABLE cookies");
        db.close();
      }
      const derive = crypto.pbkdf2Sync;
      let derived: Buffer | undefined;
      vi.spyOn(crypto, "pbkdf2Sync").mockImplementation((...args) => (derived = derive(...args)));
      syncBuiltinESMExports();
      const pending = reader.readChromiumCookieSnapshot(options("helium"), {
        home,
        keychainPassword,
      });
      if (fails) await expect(pending).rejects.toMatchObject({ cookieReaderStage: "query" });
      else await pending;
      expect(derived).toBeDefined();
      expect(derived!.every((byte) => byte === 0)).toBe(true);
    },
  );
  it("bounds acquisition before acquiring the browser key", async () => {
    const file = await profile(browsers[0]);
    await truncate(file, 64 * 1024 * 1024 + 1);
    expect(reader.listChromiumCookieSources().map((source) => source.id)).toEqual(
      browsers.map(([id]) => id),
    );
    keychainPassword.mockClear();
    await expect(
      reader.readChromiumCookieSnapshot(options("helium"), { home, keychainPassword }),
    ).rejects.toMatchObject({
      cookieReaderCode: "resource_exhausted",
      cookieReaderStage: "acquisition",
    });
    expect(keychainPassword).not.toHaveBeenCalled();
  });
  it("fails closed for malformed database metadata and never exposes raw database diagnostics", async () => {
    const file = await profile(browsers[0]);
    const db = new DatabaseSync(file);
    db.exec("UPDATE meta SET value = 'invalid'");
    db.close();
    await expect(
      reader.readChromiumCookieSnapshot(options("helium"), { home, keychainPassword }),
    ).rejects.toMatchObject({
      cookieReaderCode: "source_extraction_failed",
      cookieReaderStage: "decode",
      message: "Cookie Sync could not read the selected Chromium profile.",
    });
  });
});
