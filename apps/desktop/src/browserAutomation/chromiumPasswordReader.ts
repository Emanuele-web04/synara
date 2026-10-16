import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { lstat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  resolveChromiumProfileFolder,
  MAX_CHROMIUM_DATABASE_BYTES,
  isBoundedChromiumDatabase,
  isOversizedChromiumDatabase,
  type ChromiumInventorySourceId,
} from "./chromiumProfileInventory";

const MAX_PROFILE_LOGINS = 50_000;
const MAX_PLAINTEXT_BYTES = 6 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 16 * 1024;
const MAX_LOGIN_TEXT_BYTES = 4096;

export type BrowserPasswordLogin = {
  origin: string;
  username: string;
  password: string;
};

export class BrowserPasswordReadError extends Error {
  constructor(
    readonly code: "source_missing" | "reader_failed" | "too_many_logins" | "source_too_large",
  ) {
    super(code);
    this.name = "BrowserPasswordReadError";
  }
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function decodePassword(encrypted: Buffer, key: Buffer): string | null {
  if (encrypted.length <= 3 || encrypted.toString("ascii", 0, 3) !== "v10") return null;
  const iv = Buffer.alloc(16, 0x20);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    return null;
  } finally {
    iv.fill(0);
    plaintext?.fill(0);
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new BrowserPasswordReadError("reader_failed");
  }
}

/** Reads one Chromium profile's login database without changing the source browser files. */
export async function readChromiumProfilePasswords(
  home: string,
  browser: ChromiumInventorySourceId,
  profile: string,
  passphrase: string,
): Promise<{ logins: BrowserPasswordLogin[]; skipped: number }> {
  if (process.platform !== "darwin") throw new BrowserPasswordReadError("reader_failed");
  const folder = await resolveChromiumProfileFolder(home, browser, profile);
  if (!folder) throw new BrowserPasswordReadError("source_missing");
  const path = join(folder, "Login Data");
  if (!(await isFile(path))) throw new BrowserPasswordReadError("source_missing");
  if (!(await isBoundedChromiumDatabase(path)))
    throw new BrowserPasswordReadError(
      (await isOversizedChromiumDatabase(path)) ? "source_too_large" : "source_missing",
    );
  const key = pbkdf2Sync(passphrase, "saltysalt", 1003, 16, "sha1");

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 500 });
  } catch {
    key.fill(0);
    throw new BrowserPasswordReadError("reader_failed");
  }

  try {
    // Keep the count and streamed rows on one SQLite snapshot. Chromium may
    // keep writing this database while its profile is open; a transaction
    // also lets SQLite include committed WAL pages without copying a live DB.
    try {
      database.exec("BEGIN");
      const pages = database.prepare("PRAGMA page_count").get() as { page_count: number };
      const size = database.prepare("PRAGMA page_size").get() as { page_size: number };
      if (pages.page_count * size.page_size > MAX_CHROMIUM_DATABASE_BYTES)
        throw new BrowserPasswordReadError("source_too_large");
    } catch (error) {
      if (error instanceof BrowserPasswordReadError) throw error;
      throw new BrowserPasswordReadError("reader_failed");
    }
    if (
      database.prepare("SELECT type FROM sqlite_schema WHERE name = 'logins'").get()?.type !==
      "table"
    )
      throw new BrowserPasswordReadError("reader_failed");
    let count: number;
    try {
      const row = database
        .prepare(
          "SELECT COUNT(*) AS count FROM (SELECT 1 FROM logins WHERE blacklisted_by_user = 0 AND octet_length(password_value) > 0 LIMIT 50001)",
        )
        .get() as { count?: number | bigint } | undefined;
      count = Number(row?.count);
    } catch {
      throw new BrowserPasswordReadError("reader_failed");
    }
    if (!Number.isSafeInteger(count) || count < 0)
      throw new BrowserPasswordReadError("reader_failed");
    if (count > MAX_PROFILE_LOGINS) throw new BrowserPasswordReadError("too_many_logins");

    let statement;
    try {
      statement = database.prepare(
        `SELECT origin_url, username_value, password_value FROM logins
         WHERE blacklisted_by_user = 0 AND octet_length(password_value) > 0
           AND typeof(date_last_used) IN ('integer', 'real', 'null')
           AND typeof(origin_url) = 'text' AND typeof(username_value) IN ('text', 'null')
           AND typeof(password_value) = 'blob' AND octet_length(password_value) <= ${MAX_PASSWORD_BYTES}
           AND COALESCE(octet_length(origin_url), 0) <= ${MAX_LOGIN_TEXT_BYTES}
           AND COALESCE(octet_length(username_value), 0) <= ${MAX_LOGIN_TEXT_BYTES}
         ORDER BY date_last_used DESC, rowid DESC`,
      );
    } catch {
      throw new BrowserPasswordReadError("reader_failed");
    }

    const logins: BrowserPasswordLogin[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    let rowsRead = 0;
    let plaintextBytes = 0;
    try {
      for (const row of statement.iterate() as Iterable<{
        origin_url: string | null;
        username_value: string | null;
        password_value: Uint8Array | null;
      }>) {
        rowsRead++;
        const encrypted = row.password_value ? Buffer.from(row.password_value) : Buffer.alloc(0);
        const origin = normalizeOrigin(row.origin_url ?? "");
        const password = decodePassword(encrypted, key);
        encrypted.fill(0);
        if (!origin || password === null || password.length === 0) {
          skipped++;
          continue;
        }
        const username = row.username_value ?? "";
        const url = new URL(origin);
        const host = url.hostname.toLowerCase().replace(/^www\./, "");
        const identity = `${host}\u0001${username}`;
        if (seen.has(identity)) {
          skipped++;
          continue;
        }
        plaintextBytes +=
          Buffer.byteLength(origin) + Buffer.byteLength(username) + Buffer.byteLength(password);
        if (plaintextBytes > MAX_PLAINTEXT_BYTES)
          throw new BrowserPasswordReadError("source_too_large");
        seen.add(identity);
        logins.push({ origin, username, password });
      }
    } catch (error) {
      if (error instanceof BrowserPasswordReadError) throw error;
      throw new BrowserPasswordReadError("reader_failed");
    }
    database.exec("COMMIT");
    return { logins, skipped: skipped + count - rowsRead };
  } finally {
    key.fill(0);
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction was committed or failed before it began.
    }
    database.close();
  }
}
