// FILE: i18n.ts
// Purpose: Locale-aware helpers shared across server and web.
//   Chinese doesn't pluralize — this module provides helpers for that.
// Layer: Shared runtime utility
// Exports: isChineseLocale

/**
 * Check if the current locale is a Chinese variant.
 * Used by pluralize() and other locale-sensitive utilities.
 *
 * In the web app, this reads import.meta.env.VITE_LOCALE (bundled at build time).
 * On the server or in tests where import.meta.env is unavailable, it returns false
 * (English default — the safe fallback).
 */
export function isChineseLocale(): boolean {
  try {
    // Vite injects VITE_LOCALE at build time; safe to call from both server and client.
    // The shared package doesn't have Vite's client types, so we access import.meta.env
    // through a narrow type assertion. In server code or tests where VITE_LOCALE is
    // undefined, this returns false (English default).
    const meta = import.meta as unknown as { env?: Record<string, string> };
    return meta.env?.VITE_LOCALE === "zh-CN";
  } catch {
    return false;
  }
}
