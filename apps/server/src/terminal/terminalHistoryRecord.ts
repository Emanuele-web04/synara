import { createHash } from "node:crypto";
import fs from "node:fs";

import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
} from "@synara/contracts";

import { PRIVATE_FILE_MODE, repairPrivateFile } from "../privatePathPermissions";

const METADATA_VERSION = 1;
const MAX_METADATA_BYTES = 4_096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface TerminalHistoryRecord {
  history: string;
  recoveredCols?: number;
  recoveredRows?: number;
  historyRecordIdentity?: string;
  /** True when the on-disk source needed sanitizing or capping before use. */
  historyWasNormalized?: boolean;
}

export interface TerminalHistoryRecordMetadata {
  version: 1;
  cols: number;
  rows: number;
  byteLength: number;
  sha256: string;
  recordIdentity: string;
}

export function terminalHistoryMetadataPath(historyPath: string): string {
  return `${historyPath}.meta.json`;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function recordIdentity(cols: number, rows: number, byteLength: number, sha256: string): string {
  return createHash("sha256")
    .update(`${METADATA_VERSION}\0${cols}\0${rows}\0${byteLength}\0${sha256}`)
    .digest("hex");
}

function validDimension(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

export function createTerminalHistoryMetadata(
  history: string,
  cols: number,
  rows: number,
): TerminalHistoryRecordMetadata {
  if (
    !validDimension(cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS) ||
    !validDimension(rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)
  ) {
    throw new RangeError("Terminal history dimensions are out of bounds");
  }
  const bytes = Buffer.from(history, "utf8");
  const sha256 = digest(bytes);
  return {
    version: METADATA_VERSION,
    cols,
    rows,
    byteLength: bytes.byteLength,
    sha256,
    recordIdentity: recordIdentity(cols, rows, bytes.byteLength, sha256),
  };
}

function parseMetadata(raw: Buffer, historyBytes: Buffer): TerminalHistoryRecordMetadata | null {
  if (raw.byteLength === 0 || raw.byteLength > MAX_METADATA_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (
    metadata.version !== METADATA_VERSION ||
    !validDimension(metadata.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS) ||
    !validDimension(metadata.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS) ||
    !Number.isSafeInteger(metadata.byteLength) ||
    Number(metadata.byteLength) < 0 ||
    Number(metadata.byteLength) !== historyBytes.byteLength ||
    typeof metadata.sha256 !== "string" ||
    !SHA256_PATTERN.test(metadata.sha256) ||
    typeof metadata.recordIdentity !== "string" ||
    !SHA256_PATTERN.test(metadata.recordIdentity)
  ) {
    return null;
  }
  const sha256 = digest(historyBytes);
  const expectedIdentity = recordIdentity(
    metadata.cols,
    metadata.rows,
    historyBytes.byteLength,
    sha256,
  );
  if (metadata.sha256 !== sha256 || metadata.recordIdentity !== expectedIdentity) return null;
  return metadata as unknown as TerminalHistoryRecordMetadata;
}

async function readBoundedMetadata(metadataPath: string): Promise<Buffer | null> {
  const handle = await fs.promises.open(metadataPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_METADATA_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead === 0 || bytesRead > MAX_METADATA_BYTES) return null;
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readTerminalHistoryRecord(
  historyPath: string,
  normalizeHistory: (raw: string) => string,
): Promise<TerminalHistoryRecord | null> {
  let rawHistory: string;
  try {
    rawHistory = await fs.promises.readFile(historyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  await repairPrivateFile(historyPath);
  const history = normalizeHistory(rawHistory);
  const historyWasNormalized = history !== rawHistory;
  const historyBytes = Buffer.from(history, "utf8");
  let metadata: TerminalHistoryRecordMetadata | null = null;
  try {
    const metadataPath = terminalHistoryMetadataPath(historyPath);
    await repairPrivateFile(metadataPath);
    if (!historyWasNormalized) {
      const rawMetadata = await readBoundedMetadata(metadataPath);
      if (rawMetadata) metadata = parseMetadata(rawMetadata, historyBytes);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      metadata = null;
    }
  }
  return metadata
    ? {
        history,
        recoveredCols: metadata.cols,
        recoveredRows: metadata.rows,
        historyRecordIdentity: metadata.recordIdentity,
      }
    : {
        history,
        ...(historyWasNormalized ? { historyWasNormalized: true } : {}),
      };
}

async function atomicWrite(
  finalPath: string,
  contents: string,
  nextTempPath: (finalPath: string) => string,
): Promise<void> {
  const tempPath = nextTempPath(finalPath);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tempPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tempPath, finalPath);
    await repairPrivateFile(finalPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeTerminalHistoryRecord(
  historyPath: string,
  history: string,
  cols: number,
  rows: number,
  nextTempPath: (finalPath: string) => string,
  afterMetadataWritten?: () => void | Promise<void>,
): Promise<TerminalHistoryRecordMetadata> {
  const metadata = createTerminalHistoryMetadata(history, cols, rows);
  await atomicWrite(
    terminalHistoryMetadataPath(historyPath),
    JSON.stringify(metadata),
    nextTempPath,
  );
  await afterMetadataWritten?.();
  await atomicWrite(historyPath, history, nextTempPath);
  return metadata;
}

/**
 * Replace a legacy/damaged history source without blessing it with recovered
 * dimensions. Metadata is removed first so every interrupted state remains a
 * readable dimensionless log.
 */
export async function writeDimensionlessTerminalHistory(
  historyPath: string,
  history: string,
  nextTempPath: (finalPath: string) => string,
): Promise<void> {
  await fs.promises.rm(terminalHistoryMetadataPath(historyPath), { force: true });
  await atomicWrite(historyPath, history, nextTempPath);
}

export async function deleteTerminalHistoryRecord(
  historyPath: string,
  afterMetadataDeleted?: () => void | Promise<void>,
): Promise<void> {
  await fs.promises.rm(terminalHistoryMetadataPath(historyPath), { force: true });
  await afterMetadataDeleted?.();
  await fs.promises.rm(historyPath, { force: true });
}
