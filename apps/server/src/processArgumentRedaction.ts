const ENV_ASSIGNMENT_START_PATTERN = /(^|[\s;&|()])([A-Za-z_][A-Za-z0-9_]*)=/g;
const SHELL_ASSIGNMENT_VALUE_PATTERN =
  /(?:"(?:\\.|[^"\\])*"|'[^']*'|\$\((?:\\.|[^)])*\)|`(?:\\.|[^`\\])*`|\\[^\r\n]|[^\s"'\\;&|()<>])+/gy;
const SENSITIVE_ENV_NAME =
  /^(?:API_?KEY|ACCESS_TOKEN|AUTH_TOKEN|AUTHORIZATION|KEY|PASSWORD|PASSPHRASE|SECRET|TOKEN)$/;
const SENSITIVE_ENV_NAME_SUFFIX =
  /_(?:API_?KEY|ACCESS_TOKEN|AUTH_TOKEN|AUTHORIZATION|KEY|PASSWORD|PASSPHRASE|SECRET|TOKEN)$/;
const URL_CREDENTIALS_AT_VALUE_START = /^["']?[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;
const URL_CREDENTIALS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu;

function isSensitiveEnvironmentName(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name.toUpperCase();
  return SENSITIVE_ENV_NAME.test(normalized) || SENSITIVE_ENV_NAME_SUFFIX.test(normalized);
}

function redactSensitiveEnvironmentRemainder(args: string): string {
  for (const match of args.matchAll(ENV_ASSIGNMENT_START_PATTERN)) {
    const valueStart = match.index + match[0].length;
    if (
      !isSensitiveEnvironmentName(match[2]) &&
      !URL_CREDENTIALS_AT_VALUE_START.test(args.slice(valueStart))
    ) {
      continue;
    }

    // Process-table APIs flatten argv into one string and may discard the
    // quotes around a value containing spaces. Once a secret assignment
    // starts, its true boundary is therefore unknowable; fail closed instead
    // of exposing a suffix of the credential in diagnostics.
    return `${args.slice(0, valueStart)}[redacted]`;
  }
  return args;
}

function redactBoundedSensitiveEnvironmentValues(args: string): string {
  let result = "";
  let cursor = 0;
  for (const match of args.matchAll(ENV_ASSIGNMENT_START_PATTERN)) {
    if (!isSensitiveEnvironmentName(match[2])) continue;
    const valueStart = match.index + match[0].length;
    if (valueStart < cursor) continue;
    SHELL_ASSIGNMENT_VALUE_PATTERN.lastIndex = valueStart;
    const value = SHELL_ASSIGNMENT_VALUE_PATTERN.exec(args);
    const valueEnd =
      value?.index === valueStart ? SHELL_ASSIGNMENT_VALUE_PATTERN.lastIndex : valueStart;
    result += `${args.slice(cursor, valueStart)}[redacted]`;
    cursor = valueEnd;
  }
  return `${result}${args.slice(cursor)}`;
}

export interface RedactSensitiveProcessArgsOptions {
  readonly truncateSensitiveEnvironmentRemainder?: boolean;
}

export function redactSensitiveProcessArgs(
  args: string,
  options: RedactSensitiveProcessArgsOptions = {},
): string {
  const environmentRedacted = options.truncateSensitiveEnvironmentRemainder
    ? redactSensitiveEnvironmentRemainder(args)
    : redactBoundedSensitiveEnvironmentValues(args);
  return environmentRedacted
    .replace(
      /(--?(?:api[-_]?key|auth|authorization|key|password|secret|token)(?:=|\s+))(\S+)/gi,
      "$1[redacted]",
    )
    .replace(URL_CREDENTIALS_PATTERN, "$1[redacted]@")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bsyn_(?:pair|mcp)_v1_[A-Za-z0-9_-]+\b/g, "[redacted]");
}
