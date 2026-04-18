// FILE: shellQuote.ts
// Purpose: POSIX-compatible shell argument quoting for commands typed into a PTY.
// Exports: `quotePosixShellArgument` — wraps a value in single quotes and escapes
// embedded single quotes so it is always a single, opaque shell token.

const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a value so it can be passed as a single argument to a POSIX shell.
 *
 * Strings that already consist of only "safe" characters are returned unchanged
 * to keep the visible terminal output readable; everything else is wrapped in
 * single quotes, with embedded single quotes escaped via the standard
 * `'\''` close-quote/escape/open-quote sequence.
 */
export function quotePosixShellArgument(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  if (SAFE_TOKEN_PATTERN.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
