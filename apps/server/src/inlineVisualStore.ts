// FILE: inlineVisualStore.ts
// Purpose: Where inline visual documents live on disk, and how they are written, read, and removed.
// Layer: Server persistence helper for thread-owned agent output
// Exports: INLINE_VISUALS_DIRECTORY, inlineVisualThreadDirectory, inlineVisualFilePath,
//          writeInlineVisual, readInlineVisual

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { INLINE_VISUAL_MAX_HTML_BYTES, InlineVisualId } from "@synara/contracts";
import { Schema } from "effect";

import { resolveAttachmentRelativePath } from "./attachmentPaths";
import { toSafeThreadAttachmentSegment } from "./attachmentStore";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "./privatePathPermissions";

/**
 * Visual documents sit in a folder below the attachments root. The attachments
 * HTTP route refuses this prefix (agent HTML must never be served from the app
 * origin), and the rollback prune only scans root-level files, so undoing an
 * unrelated turn cannot delete a visual that is still shown. Thread deletion
 * removes the thread's folder explicitly.
 */
export const INLINE_VISUALS_DIRECTORY = "visuals";

const isInlineVisualId = Schema.is(InlineVisualId);

export function inlineVisualThreadDirectory(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
}): string | null {
  // Attachment prefixes are lossy; directory ownership hashes the complete ID.
  const threadSegment = toSafeThreadAttachmentSegment(input.threadId);
  if (!threadSegment) return null;
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${INLINE_VISUALS_DIRECTORY}/${createHash("sha256").update(input.threadId).digest("hex")}`,
  });
}

export function inlineVisualFilePath(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly visualId: string;
}): string | null {
  if (!isInlineVisualId(input.visualId)) return null;
  const directory = inlineVisualThreadDirectory(input);
  return directory === null ? null : path.join(directory, `${input.visualId}.html`);
}

/**
 * Writes the document through a temporary file, so a reader never sees half a
 * page. Returns whether the file already existed: an identical retry rewrites
 * the same id, and only the call that created the file may remove it again.
 */
export async function writeInlineVisual(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly visualId: string;
  readonly html: string;
}): Promise<{ readonly filePath: string; readonly existed: boolean }> {
  const filePath = inlineVisualFilePath(input);
  if (filePath === null) {
    throw new Error("The visual could not be stored for this thread.");
  }
  const existed = await stat(filePath).then(
    (info) => info.isFile(),
    () => false,
  );
  await mkdir(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, input.html, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return { filePath, existed };
}

/** The stored document, or null when it is missing, oversized, or the id is invalid. */
export async function readInlineVisual(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly visualId: string;
}): Promise<string | null> {
  const filePath = inlineVisualFilePath(input);
  if (filePath === null) return null;
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile() || info.size > INLINE_VISUAL_MAX_HTML_BYTES) return null;
  return readFile(filePath, "utf8");
}
