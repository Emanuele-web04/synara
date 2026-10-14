// FILE: desktopProcessErrors.ts
// Purpose: Handles closed terminal pipes without losing the desktop session.
// Layer: Desktop main process helpers

export function isBrokenPipeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return (error as NodeJS.ErrnoException).code === "EPIPE";
}

/** A launcher closing its output pipe must not shut down the GUI it launched. */
export function handleDesktopStdioError(error: unknown): void {
  if (!isBrokenPipeError(error)) throw error;
}
