// FILE: formatBytes.ts
// Purpose: Small shared byte-size labels for attachment prompts and chips.
// Layer: Shared runtime utility
// Exports: formatBytes

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

// Formats byte counts for compact UI/prompt summaries without pulling locale state into tests.
export function formatBytes(bytes: number): string {
  const normalized = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
  if (normalized < 1024) {
    return `${normalized} B`;
  }
  const kib = normalized / 1024;
  if (kib < 1024) {
    return `${trimTrailingZero(kib.toFixed(1))} KB`;
  }
  const mib = kib / 1024;
  if (mib < 1024) {
    return `${mib.toFixed(1)} MB`;
  }
  return `${(mib / 1024).toFixed(1)} GB`;
}
