const ENV_ASSIGNMENT_START_PATTERN = /(^|[\s;&|()'"])([A-Za-z_][A-Za-z0-9_]*)=/g;
const SENSITIVE_ENV_NAME =
  /^(?:API_?KEY|ACCESS_TOKEN|AUTH_TOKEN|AUTHORIZATION|KEY|MYSQL_PWD|PASSWORD|PASSPHRASE|PGPASSWORD|REDISCLI_AUTH|SECRET|TOKEN)$/;
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

function boundedShellAssignmentValueEnd(
  args: string,
  valueStart: number,
  boundary: string | undefined,
): number {
  if (boundary === "'" || boundary === '"') {
    for (let index = valueStart; index < args.length; index += 1) {
      if (args[index] === "\\") {
        index += 1;
        continue;
      }
      if (args[index] === boundary) return index;
    }
    return args.length;
  }

  let quote: "'" | '"' | "`" | null = null;
  let commandSubstitutionDepth = 0;
  let index = valueStart;
  while (index < args.length) {
    const character = args[index]!;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      if (character === "$" && args[index + 1] === "(") {
        commandSubstitutionDepth += 1;
        index += 2;
        continue;
      }
      if (character === ")" && commandSubstitutionDepth > 0) {
        commandSubstitutionDepth -= 1;
      }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "$" && args[index + 1] === "(") {
      commandSubstitutionDepth += 1;
      index += 2;
      continue;
    }
    if (character === ")" && commandSubstitutionDepth > 0) {
      commandSubstitutionDepth -= 1;
      index += 1;
      continue;
    }
    if (commandSubstitutionDepth === 0 && /[\s;&|()<>]/u.test(character)) break;
    index += 1;
  }
  return index;
}

function redactBoundedSensitiveEnvironmentValues(args: string): string {
  let result = "";
  let cursor = 0;
  for (const match of args.matchAll(ENV_ASSIGNMENT_START_PATTERN)) {
    if (!isSensitiveEnvironmentName(match[2])) continue;
    const valueStart = match.index + match[0].length;
    if (valueStart < cursor) continue;
    const valueEnd = boundedShellAssignmentValueEnd(args, valueStart, match[1]);
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
