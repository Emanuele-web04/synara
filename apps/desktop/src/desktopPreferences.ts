// Native language is mirrored beside the renderer profile and readable before any window opens.
import * as FS from "node:fs";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopLanguagePreference } from "@synara/contracts";
import { Schema } from "effect";
import type { SynaraDesktopFlavor } from "@synara/shared/desktopIdentity";
import { resolveUiLanguagePreference } from "@synara/shared/uiLocale";

export const isDesktopLanguagePreference = Schema.is(DesktopLanguagePreference);

/** The renderer-to-native boundary: the caller identifies the app's main frame. */
export function applyDesktopLanguagePreference(
  raw: unknown,
  input: {
    readonly isTrustedSender: boolean;
    readonly flavor: SynaraDesktopFlavor | "unknown";
    readonly preferencePath: string;
    readonly onPreference: (preference: DesktopLanguagePreference) => void;
  },
): boolean {
  if (
    !input.isTrustedSender ||
    !isDesktopLanguagePreference(raw) ||
    resolveUiLanguagePreference(raw, input.flavor) !== raw
  )
    return false;
  writeDesktopLanguagePreference(input.preferencePath, raw);
  input.onPreference(raw);
  return true;
}

export function readDesktopLanguagePreference(filePath: string): DesktopLanguagePreference {
  try {
    const value: unknown = JSON.parse(FS.readFileSync(filePath, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === 1 &&
      "language" in value &&
      isDesktopLanguagePreference(value.language)
    )
      return value.language;
  } catch {
    // Missing, malformed or unreadable preferences keep the native system language.
  }
  return "system";
}

export function writeDesktopLanguagePreference(
  filePath: string,
  language: DesktopLanguagePreference,
): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    FS.writeFileSync(temporary, `${JSON.stringify({ version: 1, language })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    FS.renameSync(temporary, filePath);
  } finally {
    FS.rmSync(temporary, { force: true });
  }
}
