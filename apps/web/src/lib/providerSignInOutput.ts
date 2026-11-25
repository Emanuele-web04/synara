// FILE: providerSignInOutput.ts
// Purpose: Reads what a provider CLI's login printed, so the sign-in window can offer the
//          login link and the code field itself instead of showing a raw terminal.
// Layer: Web domain helper (no React, no I/O)
// Exports: stripTerminalControl, parseProviderSignInOutput

export interface ProviderSignInOutput {
  /** The sign-in page the CLI opened, when it printed one. */
  readonly url: string | null;
  /** The CLI is waiting for a code the browser shows after approval. */
  readonly asksForCode: boolean;
}

// CSI and OSC sequences, then any other lone escape. Login output is plain text with
// colors and cursor moves; nothing here needs a full terminal emulator.
const CONTROL_SEQUENCE = new RegExp(
  [
    "\\u001B\\[[0-?]*[ -/]*[@-~]",
    "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
    "\\u001B[@-Z\\\\-_]",
  ].join("|"),
  "g",
);
const URL_START = /https?:\/\//g;
const URL_CHARACTERS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
const CODE_PROMPT = /\b(?:paste|enter)\b[^\n]{0,60}\bcode\b/i;

export function stripTerminalControl(raw: string): string {
  return raw.replace(CONTROL_SEQUENCE, "").replaceAll("\r", "");
}

/**
 * A link starting at `start`, rejoined across hard wraps: CLIs that lay their output out
 * themselves break a long link at the terminal width, so following lines made only of link
 * characters belong to it. A blank line or a line with spaces ends it.
 */
function readWrappedUrl(lines: readonly string[], lineIndex: number, start: number): string {
  let url = (lines[lineIndex] ?? "").slice(start).split(/\s/)[0] ?? "";
  // Only a line the link ran to the end of can continue on the next one.
  if ((lines[lineIndex] ?? "").slice(start) !== url) return url;
  for (let next = lineIndex + 1; next < lines.length; next += 1) {
    const line = lines[next] ?? "";
    if (line.length === 0 || !URL_CHARACTERS.test(line)) break;
    url += line;
  }
  return url;
}

function isSignInUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    // A local callback server is where the browser reports back, not a page to visit.
    return !LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function parseProviderSignInOutput(raw: string): ProviderSignInOutput {
  const text = stripTerminalControl(raw);
  const lines = text.split("\n").map((line) => line.trimEnd());
  let url: string | null = null;
  for (let index = 0; index < lines.length && url === null; index += 1) {
    for (const match of (lines[index] ?? "").matchAll(URL_START)) {
      // Sentence punctuation after a link is not part of it.
      const candidate = readWrappedUrl(lines, index, match.index).replace(/[.,;:)\]]+$/, "");
      if (isSignInUrl(candidate)) {
        url = candidate;
        break;
      }
    }
  }
  return { url, asksForCode: CODE_PROMPT.test(text) };
}
