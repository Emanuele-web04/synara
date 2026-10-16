// File reads and extension-owned storage operations execute inside the same
// OS sandbox as extension code. The privileged broker never dereferences paths
// beneath child-writable storage. Workspace writes still use Synara's writer.
import {
  lstat,
  stat,
  readFile,
  readdir,
  open,
  mkdir,
  rm,
  rename,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import { URI } from "@code-oss/vs/base/common/uri.js";
import { VSBuffer } from "@code-oss/vs/base/common/buffer.js";

function within(root, filename) {
  const relative = path.relative(root, filename);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export function nativeFileSystem(initialization, parent) {
  const resource = (value) => {
    const uri = URI.revive(value);
    if (uri.scheme !== "file" || uri.authority || !uri.fsPath || uri.fsPath.includes("\0"))
      throw new Error("Unsupported extension filesystem resource.");
    const filename = path.resolve(uri.fsPath);
    const roots = [
      initialization().workspace,
      initialization().storage,
      ...initialization().extensions.map((extension) => extension.directory),
    ];
    if (!roots.some((root) => within(root, filename)))
      throw new Error("Extension filesystem resource exceeds its granted scope.");
    return filename;
  };
  const owned = (value) => {
    const filename = resource(value);
    if (!within(initialization().storage, filename) || filename === initialization().storage)
      throw new Error("This operation is supported only inside extension-owned storage.");
    return filename;
  };
  return {
    async $stat(value) {
      const info = await stat(resource(value));
      return {
        type: info.isDirectory() ? 2 : 1,
        ctime: info.ctimeMs,
        mtime: info.mtimeMs,
        size: info.size,
      };
    },
    async $readdir(value) {
      const entries = await readdir(resource(value), { withFileTypes: true });
      if (entries.length > 10_000)
        throw new Error("Extension directory listing exceeds its size limit.");
      return entries.map((entry) => [
        entry.name,
        entry.isSymbolicLink() ? 64 : entry.isDirectory() ? 2 : 1,
      ]);
    },
    async $readFile(value) {
      const filename = resource(value);
      const info = await stat(filename);
      if (!info.isFile() || info.size > 4_000_000)
        throw new Error("Extension file read exceeds its size limit.");
      const bytes = await readFile(filename);
      if (bytes.length > 4_000_000) throw new Error("Extension file read exceeds its size limit.");
      return VSBuffer.wrap(bytes);
    },
    async $writeFile(value, contents, options = {}) {
      const filename = resource(value);
      const bytes = Buffer.from(contents.buffer);
      if (bytes.length > 4_000_000) throw new Error("Extension file write exceeds its size limit.");
      if (!within(initialization().storage, filename)) {
        return parent("fs.write", {
          resource: URI.revive(value),
          contents: bytes.toString("base64"),
          options,
        });
      }
      owned(value);
      const existing = await lstat(filename).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (existing?.isSymbolicLink())
        throw new Error("Extension storage writes cannot target a symlink.");
      if (!existing && options.create === false)
        throw new Error("Extension storage file does not exist.");
      if (existing && options.overwrite === false)
        throw new Error("Extension storage file already exists.");
      // Any concurrent symlink redirection remains constrained by the OS's
      // read-only workspace/package mounts, not by this lexical precheck.
      const handle = await open(
        filename,
        options.overwrite === false ? "wx" : options.create === false ? "r+" : "w",
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.truncate(bytes.length);
      } finally {
        await handle.close();
      }
    },
    $mkdir(value) {
      return mkdir(owned(value), { recursive: true, mode: 0o700 });
    },
    $delete(value, options) {
      return rm(owned(value), { recursive: options?.recursive === true });
    },
    async $rename(source, destination, options) {
      const from = owned(source),
        to = owned(destination);
      if (
        !options?.overwrite &&
        (await lstat(to).then(
          () => true,
          () => false,
        ))
      )
        throw new Error("Extension storage destination exists.");
      await rename(from, to);
    },
    $copy(source, destination, options) {
      return copyFile(resource(source), owned(destination), options?.overwrite ? 0 : 1);
    },
    $ensureActivation() {},
  };
}
