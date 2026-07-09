// FILE: studioOutputDisplay.ts
// Purpose: Presentation helpers for Studio output rows — turn machine-friendly
//          file names (dated, snake_cased, extensioned) into human-readable labels.
// Layer: Web presentation utility
// Exports: humanizeStudioOutputName

const FILE_EXTENSION_PATTERN = /\.[a-z0-9]{1,8}$/i;
const LEADING_DATE_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}[_\-\s]*/;

/**
 * Derives a readable label from a Studio output file name: drops the extension
 * (the type icon carries it) and any leading ISO-date prefix (the row already
 * shows a relative timestamp), then de-snake_cases into sentence case.
 * Falls back to the raw name whenever stripping would leave nothing.
 *
 * "2026-07-08_chat_whatsapp_autotorino.pdf" -> "Chat whatsapp autotorino"
 */
export function humanizeStudioOutputName(fileName: string): string {
  const withoutExtension = fileName.replace(FILE_EXTENSION_PATTERN, "");
  const withoutDatePrefix = withoutExtension.replace(LEADING_DATE_PREFIX_PATTERN, "");
  const spaced = withoutDatePrefix.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const base = spaced.length > 0 ? spaced : withoutExtension.trim();
  if (base.length === 0) {
    return fileName;
  }
  return base.charAt(0).toUpperCase() + base.slice(1);
}
