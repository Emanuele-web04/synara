/** Encrypted, atomic storage for the separately hosted confidential OAuth broker. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import { writeFileStringAtomically } from "../atomicWrite.ts";

const AAD = Buffer.from("synara-notion-oauth-v1");
const LIMIT = 24 * 1024 * 1024;
export function createNotionBrokerStore(
  filePath: string,
  keyBase64: string,
): { load: () => Promise<string | null>; save: (document: string) => Promise<void> } {
  const key = Buffer.from(keyBase64, "base64");
  if (!path.isAbsolute(filePath) || key.length !== 32 || key.toString("base64") !== keyBase64)
    throw new Error(
      "The Notion broker needs an absolute storage path and a base64-encoded 32-byte encryption key.",
    );
  return {
    load: async () => {
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(
          filePath,
          constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error("Cannot open the Notion broker credential store.");
      }
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.size > LIMIT ||
          (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
        )
          throw new Error("Unsafe Notion broker credential store.");
        const envelope = JSON.parse(await handle.readFile("utf8")) as {
          version?: unknown;
          iv?: unknown;
          tag?: unknown;
          data?: unknown;
        };
        if (
          envelope.version !== 1 ||
          typeof envelope.iv !== "string" ||
          typeof envelope.tag !== "string" ||
          typeof envelope.data !== "string"
        )
          throw new Error("Invalid envelope.");
        const iv = Buffer.from(envelope.iv, "base64");
        const tag = Buffer.from(envelope.tag, "base64");
        if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encryption metadata.");
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(AAD);
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(Buffer.from(envelope.data, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error(
          "The Notion broker credential store could not be authenticated. Preserve it and check the deployment key.",
        );
      } finally {
        await handle.close();
      }
    },
    save: async (document) => {
      if (Buffer.byteLength(document) > 16 * 1024 * 1024)
        throw new Error("Notion broker storage limit exceeded.");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(AAD);
      const encrypted = Buffer.concat([cipher.update(document, "utf8"), cipher.final()]);
      await Effect.runPromise(
        writeFileStringAtomically({
          filePath,
          mode: 0o600,
          contents: JSON.stringify({
            version: 1,
            iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            data: encrypted.toString("base64"),
          }),
        }),
      );
    },
  };
}
