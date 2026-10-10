import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const moduleUrl = pathToFileURL(
  path.join(path.dirname(require.resolve("betterwright")), "helium-cookie-source.js"),
).href;
const cookieSyncUrl = pathToFileURL(
  path.join(path.dirname(require.resolve("betterwright")), "cookie-sync.js"),
).href;

let heliumSource: Record<string, any>;
let cookieSync: Record<string, any>;

beforeAll(async () => {
  [heliumSource, cookieSync] = await Promise.all([import(moduleUrl), import(cookieSyncUrl)]);
});

const SYNTHETIC_KEY_MATERIAL = "synthetic-key-material";
const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;

function syntheticKeychainPassword(): string {
  return createHash("sha256").update(`helium-test:${SYNTHETIC_KEY_MATERIAL}`).digest("hex");
}

function encryptPlaintext(plaintext: string, version: number): Buffer {
  const key = pbkdf2Sync(syntheticKeychainPassword(), "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  let input = Buffer.from(plaintext, "utf8");
  if (version >= 24) {
    // Recent Chromium versions place the host-key SHA-256 digest before the
    // plaintext inside the encrypted blob, so it is removed after decryption.
    const digest = createHash("sha256").update("example.test").digest();
    input = Buffer.concat([digest, input]);
  }
  return Buffer.concat([cipher.update(input), cipher.final()]);
}

function v10Blob(plaintext: string, version = 0): Buffer {
  return Buffer.concat([Buffer.from("v10", "latin1"), encryptPlaintext(plaintext, version)]);
}

function v11Blob(plaintext: string, version = 0): Buffer {
  // v11 values carry a 35-byte prefix before the CBC ciphertext; for the test
  // fixture that prefix is arbitrary bytes followed by the encrypted body.
  return Buffer.concat([
    Buffer.from("v11", "latin1"),
    Buffer.alloc(32, 0xab),
    encryptPlaintext(plaintext, version),
  ]);
}

const actualPlatform = process.platform;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let previousUserProfile: string | undefined;
let home = "";
let previousHome: string | undefined;

beforeEach(async () => {
  // OS selection is mocked; all filesystem/SQLite/crypto work uses a temporary
  // synthetic profile and all Keychain access is injected. This is not a native
  // macOS Keychain integration test.
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  previousUserProfile = process.env.USERPROFILE;
  previousHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "synara-helium-fixture-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const profileDir = join(home, "Library", "Application Support", "net.imput.helium", "Default");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(profileDir, "Cookies"));
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL DEFAULT 0,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      encrypted_value BLOB NOT NULL DEFAULT x'',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL DEFAULT 0,
      is_secure INTEGER NOT NULL DEFAULT 0,
      is_httponly INTEGER NOT NULL DEFAULT 0,
      has_expires INTEGER NOT NULL DEFAULT 1,
      samesite INTEGER NOT NULL DEFAULT -1,
      source_scheme INTEGER NOT NULL DEFAULT 2,
      source_port INTEGER NOT NULL DEFAULT 443,
      has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = database.prepare(
    `INSERT INTO cookies (host_key, top_frame_site_key, has_cross_site_ancestor, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, source_scheme, source_port)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const futureUtc =
    BigInt(Math.floor(Date.now() / 1000) + 86_400 + CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000n;
  const pastUtc =
    BigInt(Math.floor(Date.now() / 1000) - 3_600 + CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000n;
  insert.run(
    "example.test",
    "",
    0,
    "session",
    "",
    v10Blob("synthetic-session-value"),
    "/",
    futureUtc,
    1,
    1,
    -1,
    2,
    443,
  );
  insert.run(
    "other.test",
    "",
    0,
    "plain",
    "plain-value",
    Buffer.alloc(0),
    "/",
    futureUtc,
    0,
    0,
    1,
    1,
    80,
  );
  insert.run(
    "broken.test",
    "",
    0,
    "broken",
    "",
    Buffer.concat([Buffer.from("v10", "latin1"), Buffer.alloc(32, 0xab)]),
    "/",
    futureUtc,
    1,
    0,
    -1,
    2,
    443,
  );
  insert.run(
    "example.test",
    "",
    0,
    "stale",
    "",
    v10Blob("stale-value"),
    "/",
    pastUtc,
    1,
    0,
    -1,
    2,
    443,
  );
  // Partitioned CHIPS cookie: same name scoped to a top-frame site.
  insert.run(
    "example.test",
    "https://partition.test",
    1,
    "partitioned",
    "",
    v10Blob("partitioned-session-value"),
    "/",
    futureUtc,
    1,
    1,
    -1,
    2,
    443,
  );
  database.close();
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platformDescriptor);
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

function heliumOptions(overrides: { profile?: string; domains?: string[] } = {}) {
  return cookieSync.normalizeCookieSyncOptions({
    source: { browser: "helium", profile: overrides.profile ?? "Default" },
    ...(overrides.domains ? { domains: overrides.domains } : {}),
  });
}

function neverLoadNativeReader() {
  return async () => {
    throw new Error("native reader must not load for helium");
  };
}

async function createHeliumProfile(
  profileName: string,
  metaVersion: number,
  rows: Array<{
    host_key: string;
    top_frame_site_key?: string;
    has_cross_site_ancestor?: number;
    name: string;
    value?: string;
    encrypted_value?: Buffer;
    path: string;
    expires_utc: bigint;
    is_secure: number;
    is_httponly: number;
    samesite: number;
    source_scheme: number;
    source_port: number;
  }>,
  metaStorage: "text" | "integer" = "text",
): Promise<void> {
  const dir = join(home, "Library", "Application Support", "net.imput.helium", profileName);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(dir, "Cookies"));
  // Real Chromium stores meta.value as INTEGER; readBigInts surfaces it as
  // bigint. The text form keeps coverage for legacy and synthetic databases.
  const metaValueType = metaStorage === "integer" ? "INTEGER" : "TEXT";
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value ${metaValueType} NOT NULL);
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL DEFAULT 0,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      encrypted_value BLOB NOT NULL DEFAULT x'',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL DEFAULT 0,
      is_secure INTEGER NOT NULL DEFAULT 0,
      is_httponly INTEGER NOT NULL DEFAULT 0,
      has_expires INTEGER NOT NULL DEFAULT 1,
      samesite INTEGER NOT NULL DEFAULT -1,
      source_scheme INTEGER NOT NULL DEFAULT 2,
      source_port INTEGER NOT NULL DEFAULT 443,
      has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
    );
  `);
  database
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
    .run("version", metaStorage === "integer" ? metaVersion : String(metaVersion));
  const insert = database.prepare(
    `INSERT INTO cookies (host_key, top_frame_site_key, has_cross_site_ancestor, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, source_scheme, source_port)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.host_key,
      row.top_frame_site_key ?? "",
      row.has_cross_site_ancestor ?? 0,
      row.name,
      row.value ?? "",
      row.encrypted_value ?? Buffer.alloc(0),
      row.path,
      row.expires_utc,
      row.is_secure,
      row.is_httponly,
      row.samesite,
      row.source_scheme,
      row.source_port,
    );
  }
  if (metaVersion === 0) {
    // A version of 0 can mean either "no meta row" or "meta version 0".
    // Make sure the default fixture with a blank meta table still works.
    database.prepare("DELETE FROM meta WHERE key = ?").run("version");
  }
  database.close();
}

const futureUtc =
  BigInt(Math.floor(Date.now() / 1000) + 86_400 + CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000n;

describe("Helium synthetic macOS profile fixtures", () => {
  it("lists only profiles that contain a cookie database", async () => {
    await expect(heliumSource.listHeliumProfiles()).resolves.toEqual([
      { id: "Default", name: "Default", isDefault: true },
    ]);
  });

  it("decrypts v10 rows and applies site scope through the shared pipeline", async () => {
    const snapshot = await cookieSync.extractCookieSync(
      heliumOptions({ domains: ["example.test"] }),
      neverLoadNativeReader(),
      { keychainPassword: async () => syntheticKeychainPassword() },
    );
    expect(snapshot.cookies).toHaveLength(2);
    expect(snapshot.cookies[0]).toMatchObject({
      name: "session",
      value: "synthetic-session-value",
      domain: "example.test",
      path: "/",
      secure: true,
      httpOnly: true,
    });
    expect(snapshot.cookies[1]).toMatchObject({
      name: "partitioned",
      value: "partitioned-session-value",
      domain: "example.test",
      path: "/",
      secure: true,
      httpOnly: true,
      partitionKey: "https://partition.test",
      partitionCrossSiteAncestor: true,
    });
    expect(snapshot.skipped).toBe(2);
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        { code: "decrypt_failed", count: 1 },
        { code: "domain_filtered", count: 1 },
        { code: "expired", count: 1 },
      ]),
    );
  });

  it("imports every site in profile scope and reports undecryptable rows", async () => {
    const snapshot = await cookieSync.extractCookieSync(heliumOptions(), neverLoadNativeReader(), {
      keychainPassword: async () => syntheticKeychainPassword(),
    });
    const names = snapshot.cookies.map((cookie: { name: string }) => cookie.name).sort();
    expect(names).toEqual(["partitioned", "plain", "session"]);
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([{ code: "decrypt_failed", count: 1 }]),
    );
  });

  it("decrypts Chromium v10 values that carry a v24 host-key digest", async () => {
    await createHeliumProfile("Chromium24", 24, [
      {
        host_key: "example.test",
        name: "session",
        encrypted_value: v10Blob("v24-session-value", 24),
        path: "/",
        expires_utc: futureUtc,
        is_secure: 1,
        is_httponly: 1,
        samesite: -1,
        source_scheme: 2,
        source_port: 443,
      },
    ]);
    const snapshot = await cookieSync.extractCookieSync(
      heliumOptions({ profile: "Chromium24", domains: ["example.test"] }),
      neverLoadNativeReader(),
      { keychainPassword: async () => syntheticKeychainPassword() },
    );
    expect(snapshot.cookies).toHaveLength(1);
    expect(snapshot.cookies[0]).toMatchObject({
      name: "session",
      value: "v24-session-value",
      domain: "example.test",
    });
  });

  it("strips the v24 host-key digest when meta.version is stored as an integer", async () => {
    await createHeliumProfile(
      "Chromium24Integer",
      24,
      [
        {
          host_key: "example.test",
          name: "session",
          encrypted_value: v10Blob("v24-integer-meta-value", 24),
          path: "/",
          expires_utc: futureUtc,
          is_secure: 1,
          is_httponly: 1,
          samesite: -1,
          source_scheme: 2,
          source_port: 443,
        },
      ],
      "integer",
    );
    const snapshot = await cookieSync.extractCookieSync(
      heliumOptions({ profile: "Chromium24Integer", domains: ["example.test"] }),
      neverLoadNativeReader(),
      { keychainPassword: async () => syntheticKeychainPassword() },
    );
    expect(snapshot.cookies).toHaveLength(1);
    expect(snapshot.cookies[0]).toMatchObject({
      name: "session",
      value: "v24-integer-meta-value",
      domain: "example.test",
    });
  });

  it("maps a corrupt cookie database to a bounded reader error", async () => {
    const dir = join(home, "Library", "Application Support", "net.imput.helium", "Corrupt");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "Cookies"), Buffer.from("not a sqlite database"));
    const error = await cookieSync
      .extractCookieSync(heliumOptions({ profile: "Corrupt" }), neverLoadNativeReader(), {
        keychainPassword: async () => syntheticKeychainPassword(),
      })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      cookieReaderCode: "source_extraction_failed",
      cookieReaderStage: "acquisition",
      cookiePermissionDenied: false,
    });
    expect(String(error)).not.toContain("not a sqlite");
  });

  it("never loads the native reader and maps a missing profile to source_missing", async () => {
    const load = vi.fn(neverLoadNativeReader());
    const error = await cookieSync
      .extractCookieSync(heliumOptions({ profile: "Missing" }), load)
      .catch((value: unknown) => value);
    expect(load).not.toHaveBeenCalled();
    expect(error).toMatchObject({ cookieReaderCode: "no_selected_source" });
  });

  it.each([
    [
      "interaction denial",
      new Error("security: User interaction is not allowed."),
      { cookiePermissionDenied: true, cookieReaderStage: "decrypt" },
    ],
    [
      "timeout kill",
      Object.assign(new Error("spawn timed out"), { killed: true }),
      { cookieReaderCode: "timed_out", cookieReaderStage: "decrypt" },
    ],
    [
      "unknown helper failure",
      new Error("security: lookup command failed"),
      { cookieReaderCode: "source_extraction_failed", cookieReaderStage: "decrypt" },
    ],
  ])(
    "classifies Keychain helper failures without leaking the diagnostic",
    (_label, cause, expected) => {
      const error = heliumSource.keychainFailure(cause);
      expect(error).toMatchObject(expected);
      expect(String(error)).not.toContain("security:");
      expect(String(error)).not.toContain("interaction");
    },
  );

  it("propagates an injected Keychain failure unchanged", async () => {
    const cause = new Error("synthetic-injected-failure");
    const error = await heliumSource
      .readHeliumCookieSnapshot(heliumOptions(), {
        keychainPassword: async () => {
          throw cause;
        },
      })
      .catch((value: unknown) => value);
    expect(error).toBe(cause);
  });

  it.skipIf(actualPlatform === "win32")(
    "propagates a permission-denied Helium root directory as a bounded discovery error",
    async () => {
      const root = join(home, "Library", "Application Support", "net.imput.helium");
      await chmod(root, 0o000);
      try {
        const error = await heliumSource.listHeliumProfiles().catch((value: unknown) => value);
        expect(error).toMatchObject({
          cookieReaderCode: "discovery_failed",
          cookiePermissionDenied: true,
        });
        expect(String(error)).not.toMatch(/\bEACCES\b/);
        expect(String(error)).not.toMatch(/\bpermission denied\b/i);
      } finally {
        await chmod(root, 0o700).catch(() => {});
      }
    },
  );

  it.skipIf(actualPlatform === "win32")(
    "propagates a permission-denied profile cookie store as a bounded acquisition error",
    async () => {
      await createHeliumProfile("Locked", 0, []);
      const profileDir = join(home, "Library", "Application Support", "net.imput.helium", "Locked");
      await chmod(profileDir, 0o000);
      try {
        const error = await heliumSource
          .readHeliumCookieSnapshot(heliumOptions({ profile: "Locked" }), {
            listProfiles: async () => [{ id: "Locked" }],
            keychainPassword: async () => syntheticKeychainPassword(),
          })
          .catch((value: unknown) => value);
        expect(error).toMatchObject({
          cookieReaderCode: "source_extraction_failed",
          cookieReaderStage: "acquisition",
          cookiePermissionDenied: true,
        });
        expect(String(error)).not.toMatch(/\bEACCES\b/);
        expect(String(error)).not.toMatch(/\bpermission denied\b/i);
      } finally {
        await chmod(profileDir, 0o700).catch(() => {});
      }
    },
  );
});

describe("patched Betterwright listCookieSourceBrowsers", () => {
  it("does not treat a native-reader load failure as an empty source list", async () => {
    await rm(join(home, "Library", "Application Support", "net.imput.helium"), {
      recursive: true,
      force: true,
    });
    const load = vi.fn(async () => {
      throw new Error("synthetic native reader load failure");
    });
    await expect(cookieSync.listCookieSourceBrowsers(load)).rejects.toMatchObject({
      cookieReaderCode: "reader_unavailable",
    });
  });

  it("does not treat a native-reader supported-browsers failure as an empty source list", async () => {
    await rm(join(home, "Library", "Application Support", "net.imput.helium"), {
      recursive: true,
      force: true,
    });
    const load = vi.fn(async () => ({
      supportedBrowsers: async () => {
        throw Object.assign(new Error("synthetic supported failure"), {
          rookieCode: "discovery_failed",
        });
      },
    }));
    await expect(cookieSync.listCookieSourceBrowsers(load)).rejects.toMatchObject({
      cookieReaderCode: "discovery_failed",
    });
  });

  // Helium discovery itself is macOS-only; the two rejection tests above stay
  // platform-independent because they remove the Helium data directory first.
  it("returns Helium independently when the native reader fails", async () => {
    const load = vi.fn(async () => {
      throw new Error("synthetic native reader load failure");
    });
    const result = await cookieSync.listCookieSourceBrowsers(load);
    expect(result.some((entry: { id: string }) => entry.id === "helium")).toBe(true);
  });
});

// Pure crypto/row checks run on every CI platform using synthetic bytes only.
describe("Helium cookie format validation", () => {
  it("does not discover or extract Helium on an unsupported real platform", async () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    await expect(heliumSource.heliumCookieSourceAvailable()).resolves.toBeNull();
    await expect(heliumSource.readHeliumCookieSnapshot(heliumOptions())).rejects.toMatchObject({
      cookieReaderCode: "no_discovered_source",
    });
  });

  const key = pbkdf2Sync(syntheticKeychainPassword(), "saltysalt", 1003, 16, "sha1");
  it("verifies the v24 host digest instead of importing a cookie under another host", () => {
    expect(
      heliumSource.decryptChromiumValue(v10Blob("synthetic", 24), key, 24, "example.test"),
    ).toBe("synthetic");
    expect(
      heliumSource.decryptChromiumValue(v10Blob("synthetic", 24), key, 24, "other.test"),
    ).toBeNull();
  });
  it("supports legacy v10 and fails closed for unverified format tags", () => {
    expect(heliumSource.decryptChromiumValue(v10Blob("legacy"), key, 0, "example.test")).toBe(
      "legacy",
    );
    expect(
      heliumSource.decryptChromiumValue(v11Blob("unsupported"), key, 0, "example.test"),
    ).toBeNull();
    expect(
      heliumSource.decryptChromiumValue(Buffer.from("v20unknown"), key, 0, "example.test"),
    ).toBeNull();
  });
  it("preserves legitimate empty plaintext cookies", () => {
    const warnings = new Map();
    const result = heliumSource.heliumCookieRow(
      {
        name: "empty",
        host_key: "example.test",
        path: "/",
        value: "",
        encrypted_value: Buffer.alloc(0),
      },
      key,
      warnings,
      24,
    );
    expect(result.cookie.value).toBe("");
    expect(warnings.size).toBe(0);
  });
  it("does not let plaintext hide an invalid encrypted value", () => {
    const warnings = new Map();
    expect(
      heliumSource.heliumCookieRow(
        {
          name: "bad",
          host_key: "other.test",
          path: "/",
          value: "fallback",
          encrypted_value: v10Blob("synthetic", 24),
        },
        key,
        warnings,
        24,
      ),
    ).toBeNull();
    expect(warnings.get("decrypt_failed")).toBe(1);
  });
});
