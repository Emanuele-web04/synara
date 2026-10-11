import { createHash } from "node:crypto";

import {
  COMPUTER_AUDIT_HISTORY_MAX_LIMIT,
  ComputerAuditEffect,
  type ComputerAuditHistoryEntry,
  type ComputerGetAuditHistoryInput,
  type ComputerGetAuditHistoryResult,
} from "@synara/contracts";
import { Schema } from "effect";
import { computerAuditTailLines, readComputerAuditFileTail } from "./computerAuditFile.ts";

/** One request never reads arbitrary paths or scans an unbounded legacy log. */
export const COMPUTER_AUDIT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
export const COMPUTER_AUDIT_HISTORY_MAX_ROWS = 10_000;
const MAX_LINE_BYTES = 64 * 1024;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const isAuditEffect = Schema.is(ComputerAuditEffect);

interface AuditPosition {
  readonly file: string;
  readonly offset: number;
  readonly fingerprint: string;
}

interface PositionedEntry {
  readonly position: AuditPosition;
  readonly entry: ComputerAuditHistoryEntry;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function cursorFor(position: AuditPosition): string {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

function parseCursor(cursor: string | undefined): AuditPosition | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error("Invalid Computer activity cursor. Refresh the history to continue.");
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      value !== null &&
      typeof value === "object" &&
      "file" in value &&
      typeof value.file === "string" &&
      FINGERPRINT.test(value.file) &&
      "offset" in value &&
      typeof value.offset === "number" &&
      Number.isSafeInteger(value.offset) &&
      value.offset >= 0 &&
      "fingerprint" in value &&
      typeof value.fingerprint === "string" &&
      FINGERPRINT.test(value.fingerprint)
    ) {
      return { file: value.file, offset: value.offset, fingerprint: value.fingerprint };
    }
  } catch {
    // A cursor is a position only; it never supplies a filesystem path.
  }
  throw new Error("Invalid Computer activity cursor. Refresh the history to continue.");
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}

function projectEntry(line: Buffer, position: AuditPosition): ComputerAuditHistoryEntry | null {
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.ts !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(record.ts) ||
      !Number.isFinite(Date.parse(record.ts)) ||
      typeof record.tool !== "string" ||
      !/^computer_[a-z_]{1,80}$/.test(record.tool) ||
      !isAuditEffect(record.effect)
    ) {
      return null;
    }
    const threadId = safeIdentifier(record.threadId);
    const turnId = safeIdentifier(record.turnId);
    const gatewayRequestId = safeIdentifier(record.gatewayRequestId);
    const code =
      typeof record.code === "string" && /^[a-z][a-z0-9_]{0,95}$/.test(record.code)
        ? record.code
        : undefined;
    return {
      id: digest(cursorFor(position)),
      ts: new Date(record.ts).toISOString(),
      tool: record.tool,
      effect: record.effect,
      ...(threadId !== undefined ? { threadId } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(gatewayRequestId !== undefined ? { gatewayRequestId } : {}),
      ...(code !== undefined ? { code } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Read only the configured local log and two conventional rotations. The
 * writer currently compacts in place; supporting these fixed suffixes also
 * preserves history from existing log rotation without directory enumeration.
 * File identity + byte offset preserves duplicate records during normal
 * appends/rotation. A unique fingerprint can recover a retained cursor after
 * compaction; ambiguous or expired cursors return an explicit truncated page.
 */
export async function readComputerAuditHistory(
  filePath: string | undefined,
  input: ComputerGetAuditHistoryInput,
): Promise<ComputerGetAuditHistoryResult> {
  const limit = input.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > COMPUTER_AUDIT_HISTORY_MAX_LIMIT) {
    throw new Error("Computer activity history supports between 1 and 100 entries per page.");
  }
  const before = parseCursor(input.before);
  if (filePath === undefined) {
    return { entries: [], nextCursor: null, truncated: false, status: "disabled" };
  }

  const records: PositionedEntry[] = [];
  const seenFiles = new Set<string>();
  let remainingBytes = COMPUTER_AUDIT_HISTORY_MAX_BYTES;
  let scannedRows = 0;
  let foundFile = false;
  let truncated = false;
  for (const path of [filePath, `${filePath}.1`, `${filePath}.2`]) {
    const tail = await readComputerAuditFileTail(
      path,
      scannedRows < COMPUTER_AUDIT_HISTORY_MAX_ROWS ? remainingBytes : 0,
    );
    if (tail === null) continue;
    remainingBytes -= tail.requestedBytes;
    foundFile = true;
    const fileId = digest(`${tail.device}:${tail.inode}`);
    if (seenFiles.has(fileId)) continue;
    seenFiles.add(fileId);
    truncated ||=
      tail.start > 0 ||
      tail.contents.length !== tail.requestedBytes ||
      (tail.contents.length > 0 && tail.contents.at(-1) !== 10);
    for (const { line: terminatedLine, offset } of computerAuditTailLines(tail)) {
      if (scannedRows >= COMPUTER_AUDIT_HISTORY_MAX_ROWS) {
        truncated = true;
        break;
      }
      scannedRows += 1;
      const line = terminatedLine.subarray(0, -1);
      if (line.length === 0) continue;
      if (line.length > MAX_LINE_BYTES) {
        truncated = true;
        continue;
      }
      const position = { file: fileId, offset, fingerprint: digest(line) };
      const entry = projectEntry(line, position);
      if (entry) records.push({ position, entry });
      else truncated = true;
    }
  }

  const status = foundFile ? "available" : "missing";
  let first = 0;
  if (before) {
    let index = records.findIndex(
      ({ position }) =>
        position.file === before.file &&
        position.offset === before.offset &&
        position.fingerprint === before.fingerprint,
    );
    if (index < 0) {
      const matches = records.flatMap(({ position }, index) =>
        position.fingerprint === before.fingerprint ? [index] : [],
      );
      if (matches.length === 1) index = matches[0]!;
    }
    if (index < 0) return { entries: [], nextCursor: null, truncated: true, status };
    first = index + 1;
  }
  const page = records.slice(first, first + limit);
  const last = page.at(-1);
  return {
    entries: page.map(({ entry }) => entry),
    nextCursor: last && first + page.length < records.length ? cursorFor(last.position) : null,
    truncated,
    status,
  };
}
