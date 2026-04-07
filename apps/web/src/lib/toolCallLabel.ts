import type { ToolLifecycleItemType } from "@t3tools/contracts";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed|done|finished|success|succeeded)\s*$/i, "").trim();
}

export interface ReadableToolTitleInput {
  readonly title?: string | null;
  readonly fallbackLabel: string;
  readonly itemType?: ToolLifecycleItemType | undefined;
  readonly requestKind?: "command" | "file-read" | "file-change" | undefined;
  readonly command?: string | null;
  readonly payload?: Record<string, unknown> | null;
}

export function deriveReadableToolTitle(input: ReadableToolTitleInput): string | null {
  const normalizedTitle = normalizeCompactToolLabel(input.title ?? "");
  const normalizedFallback = normalizeCompactToolLabel(input.fallbackLabel);
  const commandLabel = input.command ? humanizeCommandToolLabel(input.command) : null;
  const commandLike = input.itemType === "command_execution" || input.requestKind === "command";

  if (normalizedTitle.length > 0 && !isGenericToolTitle(normalizedTitle)) {
    return normalizedTitle;
  }

  if (commandLike && commandLabel) {
    return commandLabel;
  }

  const descriptor = normalizeToolDescriptor(extractToolDescriptorFromPayload(input.payload));
  if (descriptor && !isGenericToolTitle(descriptor)) {
    return descriptor;
  }

  if (normalizedFallback.length > 0 && !isGenericToolTitle(normalizedFallback)) {
    return normalizedFallback;
  }
  if (normalizedTitle.length > 0) {
    return normalizedTitle;
  }
  if (normalizedFallback.length > 0) {
    return normalizedFallback;
  }
  return null;
}

function isGenericToolTitle(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    normalized === "tool" ||
    normalized === "tool call" ||
    normalized === "dynamic tool call" ||
    normalized === "mcp tool call" ||
    normalized === "subagent task" ||
    normalized === "command run" ||
    normalized === "ran command" ||
    normalized === "command execution"
  );
}

function normalizeToolDescriptor(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const dedupedTokens: string[] = [];
  for (const token of normalized.split(" ")) {
    if (dedupedTokens.at(-1)?.toLowerCase() === token.toLowerCase()) {
      continue;
    }
    dedupedTokens.push(token);
  }
  const collapsed = dedupedTokens.join(" ").trim();
  if (!collapsed) {
    return null;
  }
  return collapsed.length > 64 ? `${collapsed.slice(0, 61).trimEnd()}...` : collapsed;
}

function extractToolDescriptorFromPayload(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  if (!payload) {
    return null;
  }
  const descriptorKeys = ["kind", "name", "tool", "tool_name", "toolName", "title"];
  const candidates: string[] = [];
  collectDescriptorCandidates(payload, descriptorKeys, candidates, 0);
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized) {
      continue;
    }
    if (isGenericToolTitle(normalizeCompactToolLabel(normalized))) {
      continue;
    }
    return normalized;
  }
  return null;
}

function collectDescriptorCandidates(
  value: unknown,
  keys: ReadonlyArray<string>,
  target: string[],
  depth: number,
) {
  if (depth > 4 || target.length >= 24) {
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      target.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDescriptorCandidates(entry, keys, target, depth + 1);
      if (target.length >= 24) {
        return;
      }
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") {
      const trimmed = (record[key] as string).trim();
      if (trimmed) {
        target.push(trimmed);
      }
    }
  }
  for (const nestedKey of ["item", "data", "event", "payload", "result", "input", "tool", "call"]) {
    if (nestedKey in record) {
      collectDescriptorCandidates(record[nestedKey], keys, target, depth + 1);
      if (target.length >= 24) {
        return;
      }
    }
  }
}

function humanizeCommandToolLabel(rawCommand: string): string {
  const command = unwrapShellCommandIfPresent(rawCommand);
  const [tool, args] = splitToolAndArgs(command);

  switch (tool) {
    case "cat":
    case "nl":
    case "head":
    case "tail":
    case "sed":
    case "less":
    case "more":
      return "Read file";
    case "rg":
    case "grep":
    case "ag":
    case "ack":
      return "Search files";
    case "ls":
      return "List files";
    case "find":
    case "fd":
      return "Find files";
    case "git":
      return humanizeGitCommand(args);
    default:
      return "Run command";
  }
}

function humanizeGitCommand(args: string): string {
  const subcommand = args.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  switch (subcommand) {
    case "status":
      return "Check git status";
    case "diff":
      return "Inspect git diff";
    case "show":
      return "Inspect commit";
    case "log":
      return "Review git history";
    case "add":
      return "Stage changes";
    case "commit":
      return "Commit changes";
    case "push":
      return "Push changes";
    case "pull":
      return "Pull changes";
    case "checkout":
    case "switch":
      return "Switch branch";
    default:
      return "Run git command";
  }
}

function splitToolAndArgs(command: string): [tool: string, args: string] {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return ["", ""];
  }
  const separator = normalized.indexOf(" ");
  if (separator === -1) {
    return [basename(normalized).toLowerCase(), ""];
  }
  const tool = basename(normalized.slice(0, separator)).toLowerCase();
  const args = normalized.slice(separator + 1).trim();
  return [tool, args];
}

function basename(value: string): string {
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function unwrapShellCommandIfPresent(rawCommand: string): string {
  let value = rawCommand.trim();
  if (!value) {
    return value;
  }

  const shellPrefixes = [
    "/usr/bin/bash -lc ",
    "/usr/bin/bash -c ",
    "/bin/bash -lc ",
    "/bin/bash -c ",
    "/usr/bin/zsh -lc ",
    "/usr/bin/zsh -c ",
    "/bin/zsh -lc ",
    "/bin/zsh -c ",
    "/bin/sh -lc ",
    "/bin/sh -c ",
    "bash -lc ",
    "bash -c ",
    "zsh -lc ",
    "zsh -c ",
    "sh -lc ",
    "sh -c ",
  ];

  const lowered = value.toLowerCase();
  for (const prefix of shellPrefixes) {
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    value = value.slice(prefix.length).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).trim();
    }
    value = value.replace(/^cd\s+[^;&|]+(?:&&|;)\s*/i, "").trim();
    break;
  }

  const pipeIndex = value.indexOf(" | ");
  if (pipeIndex > 0) {
    value = value.slice(0, pipeIndex).trim();
  }

  return value;
}
