// FILE: providerLaunchArgs.ts
// Purpose: Parse user-supplied provider CLI launch args into argv tokens.
// Layer: Shared runtime utility
// Exports: ProviderLaunchArgsError, parseProviderLaunchArgs, buildCodexAppServerArgs

export class ProviderLaunchArgsError extends Error {
  readonly _tag = "ProviderLaunchArgsError";

  constructor(message: string) {
    super(message);
    this.name = "ProviderLaunchArgsError";
  }
}

export interface ParsedProviderLaunchArgs {
  readonly prefix: readonly string[];
  readonly suffix: readonly string[];
}

/**
 * Tokenize a launch-args string with POSIX-style quoting, without shell expansion.
 *
 * Only a fully unquoted, unescaped -- token splits global flags (inserted before
 * the provider subcommand) from subcommand flags (appended after it).
 */
export function parseProviderLaunchArgs(input: string): ParsedProviderLaunchArgs {
  const tokens = tokenizeProviderLaunchArgs(input);
  const separator = tokens.findIndex((token) => token.isSeparator);
  const values = tokens.map((token) => token.value);
  if (separator === -1) {
    return { prefix: values, suffix: [] };
  }
  return {
    prefix: values.slice(0, separator),
    suffix: values.slice(separator + 1),
  };
}

/** Build codex <prefix> app-server <suffix> from an optional launch-args string. */
export function buildCodexAppServerArgs(launchArgs?: string): string[] {
  const { prefix, suffix } = parseProviderLaunchArgs(launchArgs ?? "");
  return [...prefix, "app-server", ...suffix];
}

interface LaunchArgToken {
  readonly value: string;
  readonly isSeparator: boolean;
}

function tokenizeProviderLaunchArgs(input: string): LaunchArgToken[] {
  const tokens: LaunchArgToken[] = [];
  let current = "";
  let tokenStarted = false;
  let protectedToken = false;
  let quote: "'" | '"' | null = null;

  const finishToken = () => {
    if (!tokenStarted) return;
    tokens.push({ value: current, isSeparator: current === "--" && !protectedToken });
    current = "";
    tokenStarted = false;
    protectedToken = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote === "'") {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === "\\") {
      const next = input[index + 1];
      if (next === undefined) {
        throw new ProviderLaunchArgsError("Codex launch args end with a dangling backslash.");
      }
      if (quote === '"' && !["$", '"', "\\", "\x60", "\n"].includes(next)) {
        current += char;
        continue;
      }
      index += 1;
      if (next === "\n") continue;
      current += next;
      tokenStarted = true;
      protectedToken = true;
      continue;
    }

    if (quote === '"') {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      protectedToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      finishToken();
      continue;
    }
    current += char;
    tokenStarted = true;
  }

  if (quote !== null) {
    throw new ProviderLaunchArgsError("Codex launch args have an unmatched " + quote + " quote.");
  }
  finishToken();
  return tokens;
}
