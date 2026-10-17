import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

export const JS_DEBUG_VERSION = "1.140.0";
export const JS_DEBUG_SHA256 = "27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968";
const JS_DEBUG_URL = `https://github.com/microsoft/vscode-js-debug/releases/download/v${JS_DEBUG_VERSION}/js-debug-dap-v${JS_DEBUG_VERSION}.tar.gz`;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const installs = new Map<string, Promise<string>>();

/** Narrow extractor for the checksum-pinned upstream tar: no links, devices, or path traversal. */
export async function extractDebugAdapter(archive: Uint8Array, destination: string): Promise<void> {
  if (
    archive.byteLength > MAX_ARCHIVE_BYTES ||
    createHash("sha256").update(archive).digest("hex") !== JS_DEBUG_SHA256
  ) {
    throw new Error("The JavaScript debugger download failed its SHA-256 integrity check.");
  }
  const tar = await promisify(gunzip)(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  let entries = 0;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (++entries > 2_000) throw new Error("The debugger archive contains too many entries.");
    const text = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .split("\0")[0] ?? "";
    const name = text(0, 100),
      prefix = text(345, 155);
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const parts = archivePath.split("/").filter(Boolean);
    const size = Number.parseInt(text(124, 12).trim(), 8);
    if (
      parts[0] !== "js-debug" ||
      parts.some((part) => part === ".." || part.includes("\\") || part.includes(":")) ||
      archivePath.startsWith("/") ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > tar.length
    ) {
      throw new Error("Unsafe or invalid path in debugger archive.");
    }
    const target = path.join(destination, ...parts);
    const type = text(156, 1);
    if (type === "5") await mkdir(target, { recursive: true, mode: 0o700 });
    else if (type === "0" || type === "") {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, tar.subarray(offset + 512, offset + 512 + size), {
        flag: "wx",
        mode: Number.parseInt(text(100, 8).trim(), 8) & 0o100 ? 0o700 : 0o600,
      });
    } else throw new Error("The debugger archive contains an unsupported entry type.");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

/** Called only after an explicit launch/attach action. Stored in the current app's private state directory. */
export function ensureDebugAdapter(stateDir: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const key = path.resolve(stateDir);
  let pending = installs.get(key);
  if (pending) return pending;
  pending = (async () => {
    const parent = path.join(key, "editor-runtimes");
    const destination = path.join(parent, `js-debug-${JS_DEBUG_VERSION}`);
    const entry = path.join(destination, "js-debug", "src", "dapDebugServer.js");
    try {
      // Keep the checked archive and recheck the executable too, rather than trusting an empty marker.
      const manifest = JSON.parse(
        await readFile(path.join(destination, "integrity.json"), "utf8"),
      ) as { archive?: string; entry?: string };
      if (
        manifest.archive === JS_DEBUG_SHA256 &&
        manifest.entry ===
          createHash("sha256")
            .update(await readFile(entry))
            .digest("hex")
      )
        return entry;
      throw new Error(
        "The installed JavaScript debugger has changed. Remove its version directory before reinstalling.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(parent, ".js-debug-"));
    try {
      const response = await fetch(JS_DEBUG_URL, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
        redirect: "follow",
      });
      if (!response.ok || !response.body)
        throw new Error(`JavaScript debugger download failed (${response.status}).`);
      const declaredSize = Number(response.headers.get("content-length") ?? "0");
      if (declaredSize > MAX_ARCHIVE_BYTES)
        throw new Error("JavaScript debugger download is too large.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > MAX_ARCHIVE_BYTES)
            throw new Error("JavaScript debugger download is too large.");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const archive = Buffer.concat(chunks);
      signal?.throwIfAborted();
      await extractDebugAdapter(archive, staging);
      signal?.throwIfAborted();
      const entryHash = createHash("sha256")
        .update(await readFile(path.join(staging, "js-debug", "src", "dapDebugServer.js")))
        .digest("hex");
      await writeFile(
        path.join(staging, "integrity.json"),
        JSON.stringify({ archive: JS_DEBUG_SHA256, entry: entryHash }),
        { mode: 0o600 },
      );
      await rename(staging, destination);
      return entry;
    } finally {
      // Only our unique, newly created staging directory; never a user's workspace or an installed runtime.
      await rm(staging, { recursive: true, force: true });
    }
  })().finally(() => installs.delete(key));
  installs.set(key, pending);
  return pending;
}
