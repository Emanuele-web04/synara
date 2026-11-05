// FILE: providerInstancePresentation.ts
// Purpose: How a provider account (instance) is named, marked, and told apart in pickers
//   and settings, including the explicit state of a selection whose account is gone.
// Layer: Web presentation helper

import { t } from "~/i18n";
import type { ProviderInstanceId, ProviderKind } from "@synara/contracts";

export function resolveProviderInstanceLabel(
  instances: ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly label: string }>,
  selectedInstanceId: ProviderInstanceId,
  translate: typeof t = t,
): string {
  return (
    instances.find((instance) => instance.instanceId === selectedInstanceId)?.label ??
    translate("settings:missingAccount")
  );
}

const ACCENT_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

/** Swatches offered when picking an account's accent color. */
export const PROVIDER_ACCENT_COLOR_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

// Only `#rrggbb` is an accent; anything else stored in settings counts as unset.
export function normalizeProviderAccentColor(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && ACCENT_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

// "Codex · Work" unless the account name already carries the provider name.
export function providerAccountQualifiedLabel(providerLabel: string, accountLabel: string): string {
  return accountLabel.toLowerCase().includes(providerLabel.toLowerCase())
    ? accountLabel
    : `${providerLabel} · ${accountLabel}`;
}

const ACCOUNT_ID_SLUG_MAX_CHARS = 48;

// Routing id proposed for a new account from its label: "Work laptop" on Claude ->
// "claude_work_laptop". Empty when the label has nothing usable.
export function deriveProviderAccountId(provider: ProviderKind, label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, ACCOUNT_ID_SLUG_MAX_CHARS);
  if (slug.length === 0) return "";
  return `${provider === "claudeAgent" ? "claude" : provider.toLowerCase()}_${slug}`;
}

const ACCOUNT_ID_MAX_CHARS = 64;
const ACCOUNT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;

/** Why an account id cannot be used, or null when it can. */
export function validateProviderAccountId(
  accountId: string,
  existingIds: ReadonlySet<string>,
): string | null {
  const trimmed = accountId.trim();
  if (trimmed.length === 0) return t("settings:accountIdRequired");
  if (trimmed.length > ACCOUNT_ID_MAX_CHARS) return t("settings:accountIdTooLong");
  if (!ACCOUNT_ID_PATTERN.test(trimmed)) {
    return t("settings:accountIdInvalid");
  }
  if (existingIds.has(trimmed)) return t("settings:accountIdExists", { id: trimmed });
  return null;
}
