import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runBoundedNodeProcess } from "./boundedNodeProcess";

const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist-electron/chromiumPasswordWorker.js",
);

function encryptPassword(value: string) {
  const key = pbkdf2Sync("test-safe-storage", "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  try {
    return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]);
  } finally {
    key.fill(0);
  }
}

describe("Chromium password child process", () => {
  it.skipIf(process.platform !== "darwin" || !existsSync(workerPath))(
    "preflights and reads one synthetic Login Data profile in the built worker",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "synara-password-child-"));
      const folder = join(home, "Library", "Application Support", "Google", "Chrome", "Default");
      await mkdir(folder, { recursive: true });
      const database = new DatabaseSync(join(folder, "Login Data"));
      database.exec(
        "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER, date_last_used INTEGER)",
      );
      database
        .prepare("INSERT INTO logins VALUES (?, ?, ?, ?, ?)")
        .run(
          "https://accounts.example.test/login",
          "alice",
          encryptPassword("fixture-secret"),
          0,
          1,
        );
      database.close();

      const call = async (request: Record<string, unknown>) => {
        const script = `await import(${JSON.stringify(pathToFileURL(workerPath).href)});`;
        const output = await runBoundedNodeProcess(script, Buffer.from(JSON.stringify(request)), {
          home,
          signal: new AbortController().signal,
          timeoutMs: 10_000,
          maxInputBytes: 64 * 1024,
          maxOutputBytes: 16 * 1024 * 1024,
          maxStderrBytes: 16 * 1024,
        });
        return JSON.parse(output);
      };

      try {
        await expect(
          call({ action: "preflight", home, browser: "chrome", profile: "Default" }),
        ).resolves.toEqual({ ok: true, profile: { count: 1, status: "available" } });
        await expect(
          call({
            action: "read",
            home,
            browser: "chrome",
            profile: "Default",
            passphrase: "test-safe-storage",
          }),
        ).resolves.toEqual({
          ok: true,
          result: {
            logins: [
              {
                origin: "https://accounts.example.test",
                username: "alice",
                password: "fixture-secret",
              },
            ],
            skipped: 0,
          },
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
