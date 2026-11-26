import * as fs from "node:fs/promises";
import path from "node:path";
import { isContainedPath } from "./realPathContainment";

// Bound reads even when a file grows while the final message is being captured.
export async function readAuthorizedFileBytes(
  sourcePath: string,
  cwd: string,
  roots: readonly string[],
  maxBytes: number,
): Promise<Buffer | null> {
  const realCwd = await fs.realpath(cwd).catch(() => null);
  if (!realCwd) return null;
  const requested = path.isAbsolute(sourcePath)
    ? path.resolve(sourcePath)
    : path.resolve(cwd, sourcePath);
  // Preserve lexical containment across an authorized cwd alias, e.g. /tmp -> /private/tmp.
  const canonicalCwdAlias = path.resolve(realCwd, path.relative(path.resolve(cwd), requested));
  const realSource = await fs.realpath(requested).catch(() => null);
  // A lexical reference and its real target must belong to the same authorized root.
  // Discovering one sibling must not allow an unrelated in-cwd symlink to jump into it.
  if (
    !realSource ||
    !roots.some(
      (root) =>
        (isContainedPath(root, requested) || isContainedPath(root, canonicalCwdAlias)) &&
        isContainedPath(root, realSource),
    )
  )
    return null;
  const before = await fs.stat(realSource).catch(() => null);
  if (!before?.isFile() || before.size <= 0 || before.size > maxBytes) return null;
  const handle = await fs.open(realSource, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      return null;
    const verifiedPath = await fs.realpath(requested).catch(() => null);
    if (verifiedPath !== realSource) return null;
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      return null;
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
