import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHROMIUM_INVENTORY_SOURCES } from "./chromiumProfileInventory";
import { readChromiumProfilePasswords } from "./chromiumPasswordReader";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let home: string;

function encryptPassword(value: string | Buffer, passphrase = "test-safe-storage") {
  const key = pbkdf2Sync(passphrase, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  try {
    return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]);
  } finally {
    key.fill(0);
  }
}

async function makeProfile(profileId = "Profile ü") {
  const source = CHROMIUM_INVENTORY_SOURCES[0];
  const profile = join(home, "Library", "Application Support", source.data, profileId);
  await mkdir(profile, { recursive: true });
  const database = new DatabaseSync(join(profile, "Login Data"));
  database.exec(
    "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER, date_last_used INTEGER)",
  );
  return { database, profileId };
}

beforeEach(async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  home = await mkdtemp(join(tmpdir(), "synara-chromium-passwords-"));
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  await rm(home, { recursive: true, force: true });
});

describe("macOS Chromium password reader", () => {
  it("decrypts eligible v10 logins, preserves exact origins, and reports skipped rows", async () => {
    const { database, profileId } = await makeProfile();
    const insert = database.prepare("INSERT INTO logins VALUES (?, ?, ?, ?, ?)");
    insert.run(
      "https://accounts.example.test/login?next=1",
      "alice",
      encryptPassword("synthetic-password"),
      0,
      10,
    );
    insert.run(
      "https://accounts.example.test/old-login",
      "alice",
      encryptPassword("older-synthetic-password"),
      0,
      5,
    );
    insert.run("chrome://settings", "internal", encryptPassword("not-a-web-login"), 0, 4);
    insert.run("https://example.test", "blocked", encryptPassword("blocked"), 1, 3);
    insert.run("https://example.test", "unreadable", randomBytes(64), 0, 2);
    database.close();

    await mkdir(join(home, "Applications", "Google Chrome.app"), { recursive: true });
    const result = await readChromiumProfilePasswords(
      home,
      "chrome",
      profileId,
      "test-safe-storage",
    );
    expect(result).toEqual({
      logins: [
        {
          origin: "https://accounts.example.test",
          username: "alice",
          password: "synthetic-password",
        },
      ],
      skipped: 3,
    });
  });

  it("skips invalid password text without inventing a binary prefix to discard", async () => {
    const { database, profileId } = await makeProfile("Default");
    database
      .prepare("INSERT INTO logins VALUES (?, ?, ?, ?, ?)")
      .run(
        "https://example.test",
        "alice",
        encryptPassword(Buffer.concat([Buffer.alloc(32, 0x80), Buffer.from("synthetic-password")])),
        0,
        1,
      );
    database.close();
    await mkdir(join(home, "Applications", "Google Chrome.app"), { recursive: true });

    const result = await readChromiumProfilePasswords(
      home,
      "chrome",
      profileId,
      "test-safe-storage",
    );
    expect(result).toEqual({ logins: [], skipped: 1 });
  });

  it("rejects a missing profile without reading another profile", async () => {
    await expect(
      readChromiumProfilePasswords(home, "chrome", "Missing", "test-safe-storage"),
    ).rejects.toMatchObject({ code: "source_missing" });
  });
});

it("skips oversized password, origin and username values before materializing login rows", async () => {
  const { database, profileId } = await makeProfile("Default");
  const insert = database.prepare("INSERT INTO logins VALUES (?, ?, ?, 0, ?)");
  insert.run("https://example.test", "large-password", Buffer.alloc(16 * 1024 + 1), 4);
  insert.run(
    "https://example.test/" + "a".repeat(4097),
    "large-origin",
    encryptPassword("secret"),
    3,
  );
  insert.run("https://example.test", "a".repeat(4097), encryptPassword("secret"), 2);
  insert.run("https://example.test", "valid", encryptPassword("synthetic-password"), 1);
  database.close();
  expect(
    await readChromiumProfilePasswords(home, "chrome", profileId, "test-safe-storage"),
  ).toEqual({
    logins: [{ origin: "https://example.test", username: "valid", password: "synthetic-password" }],
    skipped: 3,
  });
});

it("rejects synthesized login views before counting or decoding them", async () => {
  const { database, profileId } = await makeProfile();
  database.exec(
    "ALTER TABLE logins RENAME TO stored_logins; CREATE VIEW logins AS SELECT * FROM stored_logins",
  );
  database.close();
  await expect(
    readChromiumProfilePasswords(home, "chrome", profileId, "test-safe-storage"),
  ).rejects.toMatchObject({ code: "reader_failed" });
});
it("bounds aggregate decrypted credentials before returning an import batch", async () => {
  const { database, profileId } = await makeProfile();
  const insert = database.prepare("INSERT INTO logins VALUES (?, ?, ?, 0, 0)");
  const encrypted = encryptPassword("x".repeat(10000));
  database.exec("BEGIN");
  for (let index = 0; index < 700; index++)
    insert.run(`https://site${index}.test/`, `user${index}`, encrypted);
  database.exec("COMMIT");
  database.close();
  await expect(
    readChromiumProfilePasswords(home, "chrome", profileId, "test-safe-storage"),
  ).rejects.toMatchObject({ code: "source_too_large" });
});

it("skips non-text username rows without discarding valid credentials", async () => {
  const { database, profileId } = await makeProfile();
  database.exec(
    "DROP TABLE logins; CREATE TABLE logins (origin_url, username_value, password_value, blacklisted_by_user, date_last_used)",
  );
  const insert = database.prepare("INSERT INTO logins VALUES (?, ?, ?, 0, 0)");
  insert.run("https://good.test", "good-user", encryptPassword("good-secret"));
  insert.run("https://bad.test", 42, encryptPassword("bad-secret"));
  database.close();
  expect(
    await readChromiumProfilePasswords(home, "chrome", profileId, "test-safe-storage"),
  ).toEqual({
    logins: [{ origin: "https://good.test", username: "good-user", password: "good-secret" }],
    skipped: 1,
  });
});
