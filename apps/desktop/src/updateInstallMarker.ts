// FILE: updateInstallMarker.ts
// Purpose: Persists and resolves durable desktop update install attempts across app restarts.
// Layer: Desktop update utility

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import { isUpdateVersionNewer } from "./updateState";

const INSTALL_MARKER_SCHEMA_VERSION = 1;
const INSTALL_MARKER_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type InstallMarkerPhase = "requested" | "handoff" | "failed";

export interface UpdateInstallMarker {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly requestedAt: string;
  readonly handoffAt: string | null;
  readonly phase: InstallMarkerPhase;
  readonly consecutiveFailures: number;
  readonly lastFailureAt: string | null;
}

export type InstallMarkerReadResult =
  | { readonly status: "missing" }
  | { readonly status: "valid"; readonly marker: UpdateInstallMarker }
  | { readonly status: "invalid"; readonly error: string };

export type InstallMarkerOutcome = "success" | "failure" | "already-failed" | "stale" | "invalid";

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNullableIsoTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value);
}

function isUpdateInstallMarker(value: unknown): value is UpdateInstallMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const marker = value as Record<string, unknown>;
  return (
    marker.schemaVersion === INSTALL_MARKER_SCHEMA_VERSION &&
    typeof marker.attemptId === "string" &&
    marker.attemptId.trim().length > 0 &&
    typeof marker.fromVersion === "string" &&
    marker.fromVersion.trim().length > 0 &&
    typeof marker.toVersion === "string" &&
    marker.toVersion.trim().length > 0 &&
    isIsoTimestamp(marker.requestedAt) &&
    isNullableIsoTimestamp(marker.handoffAt) &&
    (marker.phase === "requested" || marker.phase === "handoff" || marker.phase === "failed") &&
    typeof marker.consecutiveFailures === "number" &&
    Number.isInteger(marker.consecutiveFailures) &&
    marker.consecutiveFailures >= 0 &&
    isNullableIsoTimestamp(marker.lastFailureAt)
  );
}

function formatReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUpdateInstallMarker(args: {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly requestedAt: string;
  readonly consecutiveFailures: number;
  readonly lastFailureAt?: string | null;
}): UpdateInstallMarker {
  return {
    schemaVersion: INSTALL_MARKER_SCHEMA_VERSION,
    attemptId: Crypto.randomUUID(),
    fromVersion: args.fromVersion,
    toVersion: args.toVersion,
    requestedAt: args.requestedAt,
    handoffAt: null,
    phase: "requested",
    consecutiveFailures: args.consecutiveFailures,
    lastFailureAt: args.lastFailureAt ?? null,
  };
}

export function readInstallMarker(filePath: string): InstallMarkerReadResult {
  let raw: string;
  try {
    raw = FS.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "invalid", error: formatReadError(error) };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isUpdateInstallMarker(parsed)) {
      return { status: "invalid", error: "Marker does not match schema version 1." };
    }
    return { status: "valid", marker: parsed };
  } catch (error) {
    return { status: "invalid", error: formatReadError(error) };
  }
}

export function writeInstallMarker(filePath: string, marker: UpdateInstallMarker): void {
  if (!isUpdateInstallMarker(marker)) {
    throw new Error("Cannot write an invalid update install marker.");
  }

  const directory = Path.dirname(filePath);
  FS.mkdirSync(directory, { recursive: true });
  const temporaryPath = Path.join(
    directory,
    `.${Path.basename(filePath)}.${process.pid}.${Crypto.randomUUID()}.tmp`,
  );
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = FS.openSync(temporaryPath, "wx", 0o600);
    FS.writeFileSync(fileDescriptor, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    FS.fsyncSync(fileDescriptor);
    FS.closeSync(fileDescriptor);
    fileDescriptor = null;
    FS.renameSync(temporaryPath, filePath);
  } finally {
    if (fileDescriptor !== null) {
      FS.closeSync(fileDescriptor);
    }
    FS.rmSync(temporaryPath, { force: true });
  }
}

export function markInstallHandoffSync(
  filePath: string,
  nowIso = new Date().toISOString(),
): UpdateInstallMarker | null {
  const result = readInstallMarker(filePath);
  if (result.status !== "valid") {
    return null;
  }
  if (result.marker.phase === "failed" || result.marker.handoffAt !== null) {
    return result.marker;
  }
  const marker: UpdateInstallMarker = {
    ...result.marker,
    phase: "handoff",
    handoffAt: nowIso,
  };
  writeInstallMarker(filePath, marker);
  return marker;
}

export function resolveInstallMarkerOutcome(
  marker: unknown,
  currentVersion: string,
  nowIso: string,
): InstallMarkerOutcome {
  if (!isUpdateInstallMarker(marker) || !isIsoTimestamp(nowIso)) {
    return "invalid";
  }
  if (!isUpdateVersionNewer(currentVersion, marker.toVersion)) {
    return "success";
  }
  if (Date.parse(nowIso) - Date.parse(marker.requestedAt) > INSTALL_MARKER_STALE_AFTER_MS) {
    return "stale";
  }
  if (marker.phase === "failed") {
    return "already-failed";
  }
  return "failure";
}

export function clearInstallMarker(filePath: string): void {
  FS.rmSync(filePath, { force: true });
}
