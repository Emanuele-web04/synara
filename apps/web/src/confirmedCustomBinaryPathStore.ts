// FILE: confirmedCustomBinaryPathStore.ts
// Purpose: Persist which custom provider binary paths a successful session has
//   already confirmed, so the "uses a custom local binary path" warning does not
//   reappear on every app restart for a path that is already known to work.
// Layer: Web UI state utilities
// Exports: load/save helpers for the confirmed-path record.

import { ProviderInstanceId } from "@synara/contracts";
import * as Schema from "effect/Schema";
import { isPlainObject } from "./persistedRecord";

const STORAGE_KEY = "synara:confirmed-custom-binary-paths:v1";

const isProviderInstanceId = Schema.is(ProviderInstanceId);

export function loadConfirmedCustomBinaryPaths(): Partial<Record<ProviderInstanceId, string>> {
  if (typeof window === "undefined") {
    return {};
  }
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) {
    return {};
  }
  // Validating keys against the provider-instance id schema also blocks prototype
  // pollution (e.g. "__proto__") from untrusted persisted input.
  const result: Partial<Record<ProviderInstanceId, string>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isProviderInstanceId(key) || typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      result[key] = trimmed;
    }
  }
  return result;
}

export function saveConfirmedCustomBinaryPaths(
  paths: Partial<Record<ProviderInstanceId, string>>,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // Best-effort persistence; ignore quota/availability errors.
  }
}
