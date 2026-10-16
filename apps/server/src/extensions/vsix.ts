import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import * as yauzl from "yauzl";
import { ExtensionArchivePaths } from "./archivePaths";
import {
  extensionArchivePath,
  extensionId,
  parseExtensionManifest,
  type ExtensionManifest,
} from "./manifest";

export const MAX_VSIX_BYTES = 128 * 1_024 * 1_024;
const MAX_FILE_BYTES = 128 * 1_024 * 1_024;
const MAX_TOTAL_BYTES = 512 * 1_024 * 1_024;
const MAX_ENTRIES = 25_000;
export interface InstalledVsix {
  id: string;
  version: string;
  digest: string;
  directory: string;
  manifest: ExtensionManifest;
}

function openArchive(bytes: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("Invalid VSIX archive."));
        else resolve(zip);
      },
    );
  });
}
function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("Unable to read VSIX entry."));
      else resolve(stream);
    });
  });
}

/** No extension code runs here. All archive writes stay in a new private directory. */
export async function installVsix(
  archive: Buffer,
  extensionsRoot: string,
  expected?: { id: string; version: string },
  signal?: AbortSignal,
): Promise<InstalledVsix> {
  if (archive.length === 0 || archive.length > MAX_VSIX_BYTES)
    throw new Error("Invalid VSIX size.");
  signal?.throwIfAborted();
  await mkdir(extensionsRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(extensionsRoot)).isSymbolicLink())
    throw new Error("Extension storage must not be a symlink.");
  const root = await realpath(extensionsRoot);
  const staging = await mkdtemp(path.join(root, ".install-"));
  let zip: yauzl.ZipFile | undefined;
  let active: Promise<void> | undefined;
  const paths = new ExtensionArchivePaths();
  let declaredTotal = 0;
  let writtenTotal = 0;
  let entries = 0;
  try {
    zip = await openArchive(archive);
    const opened = zip;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (error !== undefined) {
          opened.close();
          reject(error);
        } else resolve();
      };
      const abort = () => finish(signal?.reason ?? new Error("VSIX installation cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
      opened.once("error", finish);
      opened.once("end", () => finish());
      opened.on("entry", (entry: yauzl.Entry) => {
        if (settled) return;
        active = (async () => {
          signal?.throwIfAborted();
          if (++entries > MAX_ENTRIES) throw new Error("VSIX contains too many entries.");
          const directory = entry.fileName.endsWith("/");
          const relative = paths.add(entry.fileName, directory);
          const attributes = entry.externalFileAttributes >>> 16;
          const type = attributes & 0o170000;
          if (
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            (type !== 0 && type !== 0o100000 && type !== 0o040000) ||
            (type === 0o040000 && !directory) ||
            (type === 0o100000 && directory) ||
            (directory && entry.uncompressedSize !== 0)
          ) {
            throw new Error("VSIX links, special files and encrypted entries are not supported.");
          }
          declaredTotal += entry.uncompressedSize;
          if (
            entry.uncompressedSize > MAX_FILE_BYTES ||
            declaredTotal > MAX_TOTAL_BYTES ||
            (entry.uncompressedSize > 1_024 * 1_024 &&
              entry.uncompressedSize > Math.max(1, entry.compressedSize) * 1_000)
          ) {
            throw new Error("VSIX exceeds extraction limits.");
          }
          if (relative !== "extension" && !relative.startsWith("extension/")) return;
          const target = path.join(staging, relative);
          if (directory) {
            await mkdir(target, { recursive: true, mode: 0o700 });
            return;
          }
          if (relative === "extension/package.json" && entry.uncompressedSize > 1_024 * 1_024) {
            throw new Error("Extension manifest exceeds the size limit.");
          }
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          const source = await openEntry(opened, entry);
          let fileBytes = 0;
          let checksum = 0;
          const bound = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              fileBytes += chunk.length;
              writtenTotal += chunk.length;
              checksum = crc32(chunk, checksum);
              if (fileBytes > MAX_FILE_BYTES || writtenTotal > MAX_TOTAL_BYTES) {
                callback(new Error("VSIX exceeds actual extraction limits."));
              } else callback(null, chunk);
            },
          });
          // Preserve only owner execution for packaged tools; never setuid,
          // group/world writes, archive ownership, links or special modes.
          const mode = (attributes & 0o111) !== 0 ? 0o700 : 0o600;
          await pipeline(source, bound, createWriteStream(target, { flags: "wx", mode }), {
            signal,
          });
          if (fileBytes !== entry.uncompressedSize || checksum !== entry.crc32 >>> 0) {
            throw new Error("VSIX entry integrity check failed.");
          }
        })();
        void active.then(() => {
          if (!settled) opened.readEntry();
        }, finish);
      });
      if (signal?.aborted) abort();
      else opened.readEntry();
    });
    signal?.throwIfAborted();
    const manifest = parseExtensionManifest(
      JSON.parse(await readFile(path.join(staging, "extension/package.json"), "utf8")),
    );
    const id = extensionId(`${manifest.publisher}.${manifest.name}`);
    if (expected && (id !== extensionId(expected.id) || manifest.version !== expected.version)) {
      throw new Error("VSIX identity differs from the selected registry extension.");
    }
    if (manifest.main) {
      const main = path.join(
        staging,
        "extension",
        extensionArchivePath(manifest.main.replace(/^\.\//, "")),
      );
      const candidates = [main, `${main}.js`, path.join(main, "index.js")];
      const exists = await Promise.all(
        candidates.map((candidate) =>
          lstat(candidate).then(
            (stat) => stat.isFile(),
            () => false,
          ),
        ),
      );
      if (!exists.some(Boolean)) throw new Error("Extension entry point is missing from the VSIX.");
    }
    const digest = createHash("sha256").update(archive).digest("hex");
    const directory = `${id}-${manifest.version}-${digest.slice(0, 16)}-${randomUUID()}`;
    await rename(path.join(staging, "extension"), path.join(root, directory));
    return { id, version: manifest.version, digest, directory, manifest };
  } finally {
    zip?.close();
    // Wait for owned writes to settle before deleting this call's temporary
    // directory. A cancelled pipeline must not recreate files during cleanup.
    await active?.catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
  }
}
