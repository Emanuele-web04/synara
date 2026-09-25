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
/**
 * Sensitive key detection runs inside a replacer over whole key tokens, not as
 * wildcards around the alternation — greedy `*` on both sides of a group is
 * quadratic on adversarial input.
 */
const SENSITIVE_KEY =
  /token|secret|password|api[_-]?key|auth|cookie|session|credential|key|sess|sid/i;

/** URL schemes that address this machine or the app bundle, never a remote org. */
const LOCAL_URL_SCHEME =
  /^(?:file|synara(?:-[a-z]+)?|node|electron|devtools|chrome|chrome-extension)$/i;

interface Replacement {
  readonly pattern: RegExp;
  readonly replace: string | ((match: string, ...groups: unknown[]) => string);
}

/**
 * Ordered replacement rules. Order matters: PEM blocks and git remotes run
 * before the generic email/URL rules so their `@`s and blocks are not picked
 * apart first; the caller's home directory is collapsed before the generic
 * user-directory patterns; key/value rules run last-ish so query strings and
 * headers are already gone.
 */
// PEM blocks are replaced before input truncation so a key split across the
// maxLength boundary never leaks material.
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const RULES: ReadonlyArray<Replacement> = [
  // Git remotes carry org/repo names: ssh://git@host/org/repo and the
  // scp-style git@host:org/repo(.git).
  { pattern: /\bssh:\/\/git@[^\s'"]+/g, replace: "<git-url>" },
  { pattern: /\bgit@[A-Za-z0-9.-]+:[^\s'"]+/g, replace: "<git-url>" },
  // /Users/<name>, /home/<name>, C:\Users\<name>. The Windows form allows
  // spaces in the username and stops at the next backslash.
  {
    pattern: /\/Users\/[^/\s:'"]+|\/home\/[^/\s:'"]+|[A-Za-z]:\\Users\\[^\\:'"]+/g,
    replace: "<user>",
  },
  // URLs of any scheme: credentials in userinfo become <redacted>@ and the
  // query string and fragment are dropped. Network URLs keep only scheme +
  // host, since their paths carry org, repo, and ticket names; local schemes
  // (file://, synara://, ...) keep the path so stack frames stay readable.
  // Runs before the email rule so userinfo is not mistaken for an address.
  {
    pattern:
      /\b([a-z][a-z0-9+.-]{0,31}):\/\/([^\s/?#@]*@)?([^\s/?#]+)(\/[^\s?#]*)?(?:\?[^\s#]*)?(?:#[^\s]*)?/gi,
    replace: (_match, scheme, userinfo, host, path) => {
      const keepPath = typeof scheme === "string" && LOCAL_URL_SCHEME.test(scheme);
      const tail = typeof path === "string" && path !== "/" ? (keepPath ? path : "/…") : "";
      return `${scheme}://${typeof userinfo === "string" ? "<redacted>@" : ""}${host}${tail}`;
    },
  },
  // Email addresses.
  {
    // Bounds keep this linear: a `+` before a required `@` rescans to end of
    // input at every position otherwise.
    pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,63}/g,
    replace: "<email>",
  },
  // Paths under ~ or <user> collapse to the basename: folder and repo names
  // are dropped entirely.
  {
    pattern: /(~|<user>)[\\/](?:[^\s'"()\\/]+[\\/])*([^\s'"()\\/]+)/g,
    replace: (_match, _prefix, basename) => `~/…/${basename}`,
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
  // A Cookie/Set-Cookie header value is replaced whole — the individual
  // name=value pairs inside it are never kept.
  {
    pattern: /\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]*/gi,
    replace: (_match, header) => `${header}: ${REDACTED}`,
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
  // key=value / key: value / "key": "value" for sensitive keys. The key match
  // is a single bounded token ({1,64} keeps backtracking linear on long
  // alphanumeric runs); sensitivity is decided in the replacer.
  {
    pattern: /\b(["']?)([A-Za-z0-9_-]{1,64})(["']?)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/g,
    replace: (match, openQ, key, closeQ, separator, value) => {
      if (typeof key !== "string" || !SENSITIVE_KEY.test(key)) return match;
      const v = String(value);
      const redacted = v.startsWith('"')
        ? `"${REDACTED}"`
        : v.startsWith("'")
          ? `'${REDACTED}'`
          : REDACTED;
      return `${openQ}${key}${closeQ}${separator}${redacted}`;
    },
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
  // Standard base64 secrets (AWS secret keys and similar) use + and /, which
  // the run above stops at. Mixed case plus a digit and a + or / separates
  // them from ordinary relative paths.
  {
    pattern: /[A-Za-z0-9+/]{40,}={0,2}/g,
    replace: (match) =>
      /[+/]/.test(match) && /[0-9]/.test(match) && /[a-z]/.test(match) && /[A-Z]/.test(match)
        ? REDACTED
        : match,
  },
];

/**
 * Redacts credentials, paths, addresses and tokens from diagnostic free text.
 * Returns text safe to queue or store, truncated to `opts.maxLength`.
 */
export function redactDiagnosticText(text: string, opts: DiagnosticsRedactionOptions): string {
  let out = String(text).replace(PEM_BLOCK, "[redacted private key]");
  // Bound the work first: rules only ever shrink or lightly rewrite, so
  // redacting more than the output cap would be wasted effort — and an
  // uncapped caller (renderer console text) would stall the main thread.
  const inputTruncated = out.length > opts.maxLength;
  if (inputTruncated) {
    out = out.slice(0, opts.maxLength);
  }
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
  if (inputTruncated || out.length > opts.maxLength) {
    out = `${out.slice(0, Math.max(0, opts.maxLength - 1))}…`;
  }
  return out;
}
