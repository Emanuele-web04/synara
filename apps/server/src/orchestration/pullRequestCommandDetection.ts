// FILE: pullRequestCommandDetection.ts
// Purpose: Recognize a pull request an agent created with `gh pr create` from a finished
//          command item, so the PR is linked even when the agent forgets the link tool.
// Layer: Server orchestration (pure)
// Exports: detectCreatedPullRequestUrls
//
// Conservative by design: a missed link only loses the safety net (the agent tool and branch
// discovery still apply), while a false link attaches somebody else's PR to the thread.

const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+(?:-[a-z]*c[a-z]*)\s+(['"])([\s\S]*)\1\s*$/i;
// `gh pr create` at a shell command position: start of the command or after a separator,
// optionally behind env assignments and simple prefix commands.
const CREATE_COMMAND =
  /(?:^|[;&|(\n]|&&|\|\|)\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|env|time|nohup|command)\s+)*(?:\S*\/)?gh\s+pr\s+create\b/g;
// Commands that print other PRs make the output ambiguous.
const LISTS_PULL_REQUESTS = /\bgh\s+(?:pr\s+(?:list|view|status|checks|diff)|search\s+prs|api)\b/;
// GitHub prints the created PR URL alone on its own line.
const URL_LINE = /^[ \t]*(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+)[ \t]*$/gm;

const COMMAND_KEYS = ["command", "cmd"] as const;
const COMMAND_CONTAINER_KEYS = ["item", "input", "arguments", "args", "params", "rawInput", "call"];
const OUTPUT_KEYS = new Set([
  "aggregatedOutput",
  "aggregated_output",
  "formattedOutput",
  "formatted_output",
  "output",
  "rawOutput",
  "raw_output",
  "result",
  "stdout",
]);
const MAX_OUTPUT_CHARS = 200_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function commandText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join(" ").trim() || null;
  }
  return null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function findCommand(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  for (const key of COMMAND_KEYS) {
    const command = commandText(data[key]);
    if (command) return command;
  }
  for (const key of COMMAND_CONTAINER_KEYS) {
    const nested = parseJsonRecord(data[key]);
    if (!nested) continue;
    const command = findCommand(nested);
    if (command) return command;
  }
  return null;
}

interface OutputBuffer {
  readonly parts: string[];
  chars: number;
}

function collectStrings(value: unknown, out: OutputBuffer, depth: number): void {
  if (depth > 5 || out.chars > MAX_OUTPUT_CHARS) return;
  if (typeof value === "string") {
    out.parts.push(value);
    out.chars += value.length;
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const entry of Object.values(record)) collectStrings(entry, out, depth + 1);
}

function collectOutput(value: unknown, out: OutputBuffer, depth: number): void {
  const record = asRecord(value);
  if (!record || depth > 3) return;
  for (const [key, entry] of Object.entries(record)) {
    if (OUTPUT_KEYS.has(key)) {
      collectStrings(entry, out, 0);
    } else if (key === "item") {
      collectOutput(entry, out, depth + 1);
    }
  }
}

function unwrapShell(command: string): string {
  const match = SHELL_WRAPPER.exec(command);
  return match?.[2] ?? command;
}

// Quoted text and heredoc bodies are arguments (titles, PR bodies), never commands.
function stripArguments(command: string): string {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\s*(?:\n|$)/g, "\n")
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * URLs of pull requests a finished, successful command item created with `gh pr create`.
 * Returns nothing when the command did not create a PR at a command position, also listed
 * PRs, mentions the URL itself, or printed more PR URLs than it ran create commands.
 */
export function detectCreatedPullRequestUrls(payload: {
  readonly itemType: string;
  readonly status?: string | undefined;
  readonly data?: unknown;
}): string[] {
  if (payload.itemType !== "command_execution" || payload.status === "failed") return [];
  const data = asRecord(payload.data);
  const rawCommand = findCommand(data);
  if (!rawCommand) return [];
  const command = stripArguments(unwrapShell(rawCommand));
  const createCount = command.match(CREATE_COMMAND)?.length ?? 0;
  if (createCount === 0 || LISTS_PULL_REQUESTS.test(command)) return [];

  const outputs: OutputBuffer = { parts: [], chars: 0 };
  collectOutput(data, outputs, 0);
  const urls = new Set<string>();
  for (const output of outputs.parts) {
    for (const match of output.matchAll(URL_LINE)) urls.add(match[1]!);
  }
  if (urls.size === 0 || urls.size > createCount) return [];
  const mentioned = [...urls].some((url) => rawCommand.includes(url));
  return mentioned ? [] : [...urls];
}
