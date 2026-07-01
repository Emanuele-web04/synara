// Devin model variant base-id normalization.
// Mirrors normalizeCursorModelVariantBaseId: strips variant suffixes from a
// full Devin slug so stored threads (e.g. "claude-opus-4-8-high-fast") match
// their base descriptor ("claude-opus-4-8") in resolveRuntimeModelDescriptor.

const DEVIN_VARIANT_TOKENS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
  "minimal",
  "slow",
  "fast",
  "priority",
  "thinking",
  "1m",
]);

export function normalizeDevinModelVariantBaseId(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) {
    return null;
  }
  const isModelPrefix = trimmed.startsWith("MODEL_");
  const sep = isModelPrefix ? "_" : "-";
  const parts = trimmed.split(sep);
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (!last || !DEVIN_VARIANT_TOKENS.has(last.toLowerCase())) {
      break;
    }
    parts.pop();
  }
  return parts.join(sep);
}
