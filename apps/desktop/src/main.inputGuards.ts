// FILE: main.inputGuards.ts
// Purpose: Pure validation/normalization helpers for desktop IPC inputs and error formatting.
// Layer: Desktop main process
// Exports: formatErrorMessage, getSafeExternalUrl, getSafeTheme, isSaveFileInput, normalizeCommitHash.

import type { FileFilter } from "electron";
import type { DesktopTheme } from "@t3tools/contracts";

import { COMMIT_HASH_DISPLAY_LENGTH, COMMIT_HASH_PATTERN } from "./main.constants";

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

export function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }

  return null;
}

export function isSaveFileInput(input: unknown): input is {
  defaultFilename: string;
  contents: string;
  filters?: FileFilter[];
} {
  if (!input || typeof input !== "object") {
    return false;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.defaultFilename !== "string" || record.defaultFilename.trim().length === 0) {
    return false;
  }
  if (typeof record.contents !== "string") {
    return false;
  }
  if (record.filters === undefined) {
    return true;
  }
  if (!Array.isArray(record.filters)) {
    return false;
  }
  return record.filters.every((filter) => {
    if (!filter || typeof filter !== "object") return false;
    const filterRecord = filter as Record<string, unknown>;
    return (
      typeof filterRecord.name === "string" &&
      Array.isArray(filterRecord.extensions) &&
      filterRecord.extensions.every((extension) => typeof extension === "string")
    );
  });
}

export function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}
