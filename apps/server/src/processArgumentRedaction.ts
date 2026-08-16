const ENV_ASSIGNMENT_START_PATTERN = /(^|[\s;&|()'"])([A-Za-z_][A-Za-z0-9_]*)(?:\+)?=/g;
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
  type ShellQuote = "'" | '"' | "`";
  type ExpansionClose = ")" | "}" | "))";
  interface ShellExpansion {
    readonly close: ExpansionClose;
    quote: ShellQuote | null;
  }

  const outerBoundaryQuote = boundary === "'" || boundary === '"' ? boundary : null;
  let wordQuote: ShellQuote | null = outerBoundaryQuote;
  const expansions: ShellExpansion[] = [];
  let index = valueStart;

  const expansionAtCursor = (): {
    readonly close: ExpansionClose;
    readonly length: number;
  } | null => {
    if (args.startsWith("$((", index)) return { close: "))", length: 3 };
    if (args.startsWith("$(", index)) return { close: ")", length: 2 };
    if (args.startsWith("${", index)) return { close: "}", length: 2 };
    return null;
  };

  while (index < args.length) {
    const character = args[index]!;
    if (character === "\\") {
      index += 2;
      continue;
    }

    if (expansions.length > 0) {
      const expansion = expansions.at(-1)!;
      if (expansion.quote !== null) {
        if (character === expansion.quote) {
          expansion.quote = null;
          index += 1;
          continue;
        }
        const nestedExpansion = expansion.quote !== "'" ? expansionAtCursor() : null;
        if (nestedExpansion) {
          expansions.push({ close: nestedExpansion.close, quote: null });
          index += nestedExpansion.length;
          continue;
        }
        index += 1;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        expansion.quote = character;
        index += 1;
        continue;
      }
      if (args.startsWith(expansion.close, index)) {
        expansions.pop();
        index += expansion.close.length;
        continue;
      }
      const nestedExpansion = expansionAtCursor();
      if (nestedExpansion) {
        expansions.push({ close: nestedExpansion.close, quote: null });
        index += nestedExpansion.length;
        continue;
      }
      if (character === "(" || character === "{") {
        expansions.push({ close: character === "(" ? ")" : "}", quote: null });
      }
      index += 1;
      continue;
    }

    if (wordQuote !== null) {
      if (character === wordQuote) {
        if (wordQuote === outerBoundaryQuote) return index;
        wordQuote = null;
        index += 1;
        continue;
      }
      const nestedExpansion = wordQuote !== "'" ? expansionAtCursor() : null;
      if (nestedExpansion) {
        expansions.push({ close: nestedExpansion.close, quote: null });
        index += nestedExpansion.length;
        continue;
      }
      index += 1;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      wordQuote = character;
      index += 1;
      continue;
    }
    const expansion = expansionAtCursor();
    if (expansion) {
      expansions.push({ close: expansion.close, quote: null });
      index += expansion.length;
      continue;
    }
    if (/[\s;&|()<>]/u.test(character)) break;
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
