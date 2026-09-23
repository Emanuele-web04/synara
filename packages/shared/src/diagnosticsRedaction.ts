// FILE: diagnosticsRedaction.ts
// Purpose: PII redaction for free-text diagnostics fields (error messages,
// stack traces, log excerpts) before they leave the machine or are stored.
// Layer: Shared text processing — used by the beta desktop diagnostics client
// and re-run by the ingest worker as defense in depth.

export interface DiagnosticsRedactionOptions {
  /** Absolute home directory to collapse to `~` (callers pass os.homedir()). */
  readonly homeDir?: string | undefined;
  /** Hard cap on the returned string length, applied after redaction. */
  readonly maxLength: number;
}

const REDACTED = "[redacted]";
const SENSITIVE_KEY =
  /[A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key|auth|cookie|session)[A-Za-z0-9_-]*/i;

interface Replacement {
  readonly pattern: RegExp;
  readonly replace: string | ((match: string, ...groups: unknown[]) => string);
}

/**
 * Ordered replacement rules. Order matters: the caller's home directory is
 * collapsed before the generic user-directory patterns, and URLs run before
 * the key/value rules so query strings cannot smuggle secrets through.
 */
const RULES: ReadonlyArray<Replacement> = [
  // /Users/<name>, /home/<name>, C:\Users\<name>
  {
    pattern: /\/Users\/[^/\s:'"]+|\/home\/[^/\s:'"]+|[A-Za-z]:\\Users\\[^\\\s:'"]+/g,
    replace: "<user>",
  },
  // Email addresses.
  {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replace: "<email>",
  },
  // URLs: keep scheme + host + path, drop query and fragment.
  {
    pattern: /\b(https?|wss?|ftp):\/\/([^\s/?#]+)(\/[^\s?#]*)?(?:\?[^\s#]*)?(?:#[^\s]*)?/gi,
    replace: (_match, scheme, host, path) =>
      `${scheme}://${host}${typeof path === "string" ? path : ""}`,
  },
  // Bearer tokens and Authorization header values.
  {
    pattern: /\bBearer\s+\S+/gi,
    replace: "Bearer [redacted]",
  },
  {
    pattern: /\bAuthorization\s*[:=]\s*\S+(\s+\S+)?/gi,
    replace: `Authorization: ${REDACTED}`,
  },
  // Known token shapes.
  { pattern: /\bsk-ant-[A-Za-z0-9_-]+/g, replace: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]+/g, replace: REDACTED },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  // JSON Web Tokens: three base64url segments, the header always starts "eyJ".
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: REDACTED,
  },
  // "key": "value" (JSON-ish) for sensitive keys.
  {
    pattern: new RegExp(
      `("(?:${SENSITIVE_KEY.source})"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|[A-Za-z0-9._~+/=-]+)`,
      "gi",
    ),
    replace: (_match, prefix) => `${prefix}"${REDACTED}"`,
  },
  // key=value (env/log-ish) for sensitive keys.
  {
    pattern: new RegExp(`\\b(${SENSITIVE_KEY.source})\\s*=\\s*("[^"]*"|'[^']*'|[^\\s,;&]+)`, "gi"),
    replace: (_match, key) => `${key}=${REDACTED}`,
  },
  // IPv4 addresses.
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replace: "<ip>" },
  // IPv6 addresses. Pure-digit colon runs (HH:MM:SS timestamps) are kept so
  // log excerpts stay readable.
  {
    pattern:
      /(?<![0-9a-fA-F:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}(?![0-9a-fA-F:])|(?<![0-9a-fA-F:])[0-9a-fA-F:]*::[0-9a-fA-F:]*/g,
    replace: (match) => (/^[0-9:]+$/.test(match) ? match : "<ip>"),
  },
  // Catch-all: any remaining long hex or base64url run is treated as a secret.
  { pattern: /\b[A-Za-z0-9_-]{32,}\b/g, replace: REDACTED },
];

/**
 * Redacts credentials, paths, addresses and tokens from diagnostic free text.
 * Returns text safe to queue or store, truncated to `opts.maxLength`.
 */
export function redactDiagnosticText(text: string, opts: DiagnosticsRedactionOptions): string {
  let out = String(text);
  const homeDir = opts.homeDir?.trim();
  if (homeDir && homeDir !== "/") {
    out = out.split(homeDir).join("~");
  }
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    out =
      typeof rule.replace === "string"
        ? out.replace(rule.pattern, rule.replace)
        : out.replace(rule.pattern, rule.replace);
  }
  if (out.length > opts.maxLength) {
    out = `${out.slice(0, Math.max(0, opts.maxLength - 1))}…`;
  }
  return out;
}
