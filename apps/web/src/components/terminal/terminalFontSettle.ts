// FILE: terminalFontSettle.ts
// Purpose: Refit xterm after web fonts finish loading so early measurements do not stick.
// Layer: Terminal runtime utility
// Exports: waitForTerminalFontReady
// Depends on: Browser FontFaceSet API

const DEFAULT_FONT_LOAD_TIMEOUT_MS = 2_000;

// Waits for the configured terminal font, but never blocks resize recovery forever.
export async function waitForTerminalFontReady(input: {
  fontFamily: string;
  fontSize: number;
  timeoutMs?: number;
}): Promise<void> {
  if (typeof document === "undefined") return;
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts || typeof fonts.load !== "function") return;

  const fontFamily = input.fontFamily.trim();
  if (!fontFamily) return;

  let timeoutId: number | null = null;
  const timeout = new Promise<void>((resolve) => {
    timeoutId = window.setTimeout(resolve, input.timeoutMs ?? DEFAULT_FONT_LOAD_TIMEOUT_MS);
  });

  try {
    await Promise.race([Promise.resolve(fonts.load(`${input.fontSize}px ${fontFamily}`)), timeout]);
  } catch {
    // Refit anyway; a bad font spec should not permanently strand terminal dimensions.
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}
