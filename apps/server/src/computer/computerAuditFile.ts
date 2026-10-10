import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export interface ComputerAuditFileTail {
  readonly contents: Buffer;
  readonly start: number;
  readonly totalBytes: number;
  readonly requestedBytes: number;
  readonly device: number;
  readonly inode: number;
}

/** Shared bounded file access for audit history and retention, never a full-file read. */
export async function readComputerAuditFileTail(
  path: string,
  maxBytes: number,
): Promise<ComputerAuditFileTail | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid audit read bound.");
  let file;
  try {
    // O_NOFOLLOW is unavailable on some platforms. Also verify the opened
    // identity so a link cannot substitute an arbitrary file there.
    const entry = await lstat(path);
    if (!entry.isFile()) throw new Error("Could not read Computer activity history.");
    file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Could not read Computer activity history.");
  }
  try {
    const stat = await file.stat();
    const entry = await lstat(path);
    if (!stat.isFile() || !entry.isFile() || entry.dev !== stat.dev || entry.ino !== stat.ino) {
      throw new Error("Could not read Computer activity history.");
    }
    const length = Math.min(stat.size, maxBytes);
    const start = stat.size - length;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = await file.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    return {
      contents: buffer.subarray(0, bytesRead),
      start,
      totalBytes: stat.size,
      requestedBytes: length,
      device: stat.dev,
      inode: stat.ino,
    };
  } catch {
    throw new Error("Could not read Computer activity history.");
  } finally {
    await file.close();
  }
}

/** Complete newline-terminated records, newest first, preserving their file positions. */
export function* computerAuditTailLines(tail: ComputerAuditFileTail): Generator<{
  readonly line: Buffer;
  readonly offset: number;
}> {
  const { contents, start } = tail;
  let end = contents.lastIndexOf(10);
  while (end >= 0) {
    const previous = end > 0 ? contents.lastIndexOf(10, end - 1) : -1;
    const lineStart = previous + 1;
    if (previous < 0 && start > 0) return;
    yield { line: contents.subarray(lineStart, end + 1), offset: start + lineStart };
    end = previous;
  }
}
