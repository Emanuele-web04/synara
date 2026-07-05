// FILE: desktopProcessErrors.ts
// Purpose: Classifies process-level errors that need desktop shutdown handling.
// Layer: Desktop main process helpers

export function isBrokenPipeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return (error as NodeJS.ErrnoException).code === "EPIPE";
}
