// FILE: terminalThreadTitle.ts
// Purpose: Derives safe terminal-thread titles from terminal input without persisting raw commands.
// Layer: Server terminal helper
// Exports: generic-title checks plus incremental command parsing for terminal writes.

const GENERIC_TERMINAL_THREAD_TITLE = "New terminal";
const MAX_TERMINAL_INPUT_BUFFER_LENGTH = 512;
const MAX_TERMINAL_TITLE_LENGTH = 48;

const WRAPPER_COMMANDS = new Set(["builtin", "command", "env", "noglob", "nocorrect", "sudo"]);
const IGNORED_TERMINAL_TITLE_COMMANDS = new Set([
  ".",
  "alias",
  "cd",
  "clear",
  "exit",
  "export",
  "history",
  "la",
  "ll",
  "logout",
  "ls",
  "pwd",
  "reset",
  "source",
  "unalias",
  "unset",
]);

function truncateTerminalTitle(title: string): string {
  return title.length <= MAX_TERMINAL_TITLE_LENGTH
    ? title
    : title.slice(0, MAX_TERMINAL_TITLE_LENGTH).trimEnd();
}

function normalizeCommandToken(token: string): string {
  const normalizedPath = token.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment) {
      return segment.toLowerCase();
    }
  }
  return normalizedPath.toLowerCase();
}

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escapeNext = false;

  for (const char of command.trim()) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = quote !== "'";
      if (!escapeNext) {
        current += char;
      }
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function stripShellPrefixes(tokens: string[]): string[] {
  let startIndex = 0;
  while (startIndex < tokens.length && isEnvAssignmentToken(tokens[startIndex] ?? "")) {
    startIndex += 1;
  }
  while (
    startIndex < tokens.length &&
    WRAPPER_COMMANDS.has(normalizeCommandToken(tokens[startIndex]!))
  ) {
    startIndex += 1;
    while (startIndex < tokens.length && isEnvAssignmentToken(tokens[startIndex] ?? "")) {
      startIndex += 1;
    }
  }
  return tokens.slice(startIndex);
}

function unwrapExecutorCommand(tokens: string[]): string[] {
  const [first, second, third] = tokens;
  const normalizedFirst = normalizeCommandToken(first ?? "");
  const normalizedSecond = normalizeCommandToken(second ?? "");

  if ((normalizedFirst === "npx" || normalizedFirst === "bunx") && second) {
    return [second, ...tokens.slice(2)];
  }
  if (normalizedFirst === "pnpm" && normalizedSecond === "dlx" && third) {
    return [third, ...tokens.slice(3)];
  }
  if (normalizedFirst === "npm" && normalizedSecond === "exec" && third) {
    return [third, ...tokens.slice(3)];
  }
  return tokens;
}

function derivePackageManagerTitle(tokens: string[]): string | null {
  const [first, second, third] = tokens.map(normalizeCommandToken);
  if (!first || !["bun", "npm", "pnpm", "yarn"].includes(first)) {
    return null;
  }
  if (second && ["create", "dlx", "exec", "run"].includes(second) && third) {
    return `${first} ${second} ${third}`;
  }
  if (second) {
    return `${first} ${second}`;
  }
  return first;
}

export function isGenericTerminalThreadTitle(title: string | null | undefined): boolean {
  return (title ?? "").trim() === GENERIC_TERMINAL_THREAD_TITLE;
}

// Convert a submitted shell command into a short sidebar-safe label.
export function deriveTerminalThreadTitleFromCommand(command: string): string | null {
  const strippedCommand = command.trim();
  if (strippedCommand.length === 0) {
    return null;
  }

  const baseTokens = stripShellPrefixes(tokenizeShellCommand(strippedCommand));
  if (baseTokens.length === 0) {
    return null;
  }

  const tokens = unwrapExecutorCommand(baseTokens);
  const normalizedTokens = tokens.map(normalizeCommandToken);
  const first = normalizedTokens[0];
  const second = normalizedTokens[1];

  if (!first || IGNORED_TERMINAL_TITLE_COMMANDS.has(first)) {
    return null;
  }
  if (first === "codex" || first === "codex-cli") {
    return "Codex CLI";
  }
  if (
    first === "claude" ||
    first === "claude-code" ||
    first === "claude_code" ||
    (first === "claude" && second === "code")
  ) {
    return "Claude Code";
  }
  if (first === "git") {
    return truncateTerminalTitle(second ? `git ${second}` : "git");
  }

  const packageManagerTitle = derivePackageManagerTitle(tokens);
  if (packageManagerTitle) {
    return truncateTerminalTitle(packageManagerTitle);
  }

  const genericTitle = normalizedTokens.slice(0, 2).join(" ").trim();
  return genericTitle.length > 0 ? truncateTerminalTitle(genericTitle) : null;
}

// Consume terminal input incrementally and emit a title only when Enter submits a command.
export function consumeTerminalThreadTitleInput(
  buffer: string,
  data: string,
): { buffer: string; title: string | null } {
  if (data.includes("\u001b")) {
    return { buffer, title: null };
  }

  let nextBuffer = buffer;
  let nextTitle: string | null = null;
  for (const char of data) {
    if (char === "\r" || char === "\n") {
      nextTitle = deriveTerminalThreadTitleFromCommand(nextBuffer);
      nextBuffer = "";
      continue;
    }
    if (char === "\b" || char === "\u007f") {
      nextBuffer = nextBuffer.slice(0, -1);
      continue;
    }
    if (char === "\t") {
      nextBuffer += " ";
      continue;
    }
    if (char === "\u0003" || char === "\u0004" || char === "\u0015") {
      nextBuffer = "";
      continue;
    }
    if (char >= " ") {
      nextBuffer += char;
    }
  }

  return {
    buffer: nextBuffer.slice(-MAX_TERMINAL_INPUT_BUFFER_LENGTH),
    title: nextTitle,
  };
}
