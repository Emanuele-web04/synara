// FILE: codexErrorClassification.ts
// Purpose: Centralizes Codex runtime error classification shared across manager and adapter layers.
// Exports: helpers for non-fatal Codex error messages that should remain warnings

const NON_FATAL_CODEX_ERROR_SNIPPETS = [
  "write_stdin failed: stdin is closed for this session",
] as const;

export function isNonFatalCodexErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return NON_FATAL_CODEX_ERROR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}
