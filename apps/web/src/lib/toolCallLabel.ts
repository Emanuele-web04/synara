// FILE: toolCallLabel.ts
// Purpose: Normalizes generic tool-call titles and humanizes command executions for timeline rows.
// Layer: UI utility
// Exports: deriveReadableToolTitle, deriveReadableCommandDisplay, command icon classifiers, deriveInlineCommandCall, normalizeCompactToolLabel, isGenericToolTitle, extractWebFetchUrl
// Depends on: @synara/contracts tool lifecycle item types

import type { ToolLifecycleItemType } from "@synara/contracts";

export function normalizeCompactToolLabel(value: string): string {
  return value
    .replace(/\s+(?:complete|completed|done|finished|success|succeeded|started|running)\s*$/i, "")
    .trim();
}

// Web-fetch tool calls (e.g. Claude's `WebFetch`) arrive as generic dynamic tool
// calls whose detail is the raw `ToolName: {json}` argument summary. Recognizing
// them lets the timeline surface the target site (favicon + URL) instead of the
// raw JSON arguments.
const WEB_FETCH_TOOL_NAMES = new Set(["webfetch", "fetch", "urlfetch", "fetchurl", "httpfetch"]);

function isWebFetchToolName(toolName: string | null | undefined): boolean {
  if (!toolName) {
    return false;
  }
  const normalized = toolName.toLowerCase().replace(/[^a-z]/g, "");
  if (WEB_FETCH_TOOL_NAMES.has(normalized)) {
    return true;
  }
  return (
    normalized.includes("fetch") &&
    (normalized.includes("web") || normalized.includes("url") || normalized.includes("http"))
  );
}

// Pulls the first http(s) URL out of a web-fetch tool call's argument summary.
// Prefers the JSON `url`/`uri` field (the actual shape) and falls back to a bare
// URL token so a slightly different summary still resolves. Returns null for
// non-fetch tools or when no usable URL is present, so callers fall back to the
// generic tool-call rendering.
export function extractWebFetchUrl(input: {
  readonly toolName?: string | null | undefined;
  readonly detail?: string | null | undefined;
}): string | null {
  if (!isWebFetchToolName(input.toolName)) {
    return null;
  }
  const detail = input.detail;
  if (!detail) {
    return null;
  }
  const fieldMatch = /"(?:url|uri)"\s*:\s*"([^"]+)"/i.exec(detail);
  const candidate =
    fieldMatch?.[1]?.trim() ??
    /https?:\/\/[^\s"'<>)\]}]+/i.exec(detail)?.[0]?.replace(/[.,;:!?]+$/, "");
  if (candidate && /^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  return null;
}

// Turns internal MCP identifiers into readable inline labels for timeline rows.
function humanizeMcpToolIdentifier(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("mcp__")) {
    return null;
  }

  const [, server, tool, ...rest] = trimmed.split("__");
  const normalizedServer = humanizeMcpToken(server);
  const normalizedTool = [tool, ...rest]
    .map((part) => humanizeMcpToken(part))
    .filter((part) => part.length > 0)
    .join(" ");

  if (!normalizedServer || !normalizedTool) {
    return null;
  }
  return `${normalizedServer}: ${normalizedTool}`;
}

function humanizeMcpServerTool(server: string, tool: string): string | null {
  const normalizedServer = humanizeMcpToken(server);
  const normalizedTool = humanizeMcpToken(tool);
  if (!normalizedServer || !normalizedTool) {
    return null;
  }
  return `${normalizedServer}: ${normalizedTool}`;
}

export interface ReadableToolTitleInput {
  readonly title?: string | null;
  readonly fallbackLabel: string;
  readonly itemType?: ToolLifecycleItemType | undefined;
  readonly requestKind?: "command" | "file-read" | "file-change" | undefined;
  readonly command?: string | null;
  readonly payload?: Record<string, unknown> | null;
  readonly isRunning?: boolean;
}

export function deriveReadableToolTitle(input: ReadableToolTitleInput): string | null {
  const normalizedTitle = normalizeCompactToolLabel(input.title ?? "");
  const normalizedFallback = normalizeCompactToolLabel(input.fallbackLabel);
  const commandLabel = input.command
    ? deriveReadableCommandDisplay(input.command, input.isRunning).verb
    : null;
  const commandLike = input.itemType === "command_execution" || input.requestKind === "command";

  // Derive a verbal label from requestKind when the title is generic
  const requestKindLabel = humanizeRequestKind(input.requestKind, input.itemType);

  if (normalizedTitle.length > 0 && !isGenericToolTitle(normalizedTitle)) {
    return normalizedTitle;
  }

  // Use verbal requestKind label before falling back to raw descriptors
  if (requestKindLabel) {
    return requestKindLabel;
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

export interface ReadableCommandDisplay {
  readonly verb: string;
  readonly target: string;
  readonly fullCommand: string;
}

export type CommandVisualKind = "inspect" | "git" | "github" | "terminal";

function humanizeRequestKind(
  requestKind: ReadableToolTitleInput["requestKind"],
  itemType: ReadableToolTitleInput["itemType"],
): string | null {
  if (requestKind === "file-read") return "Read";
  if (requestKind === "file-change" || itemType === "file_change") return "Edited";
  // Don't handle command types here — let humanizeCommandToolLabel produce more specific labels
  if (itemType === "web_search") return "Searched the web";
  if (itemType === "image_generation") return "Generated image";
  if (itemType === "image_view") return "Viewed image";
  if (itemType === "collab_agent_tool_call") return "Agent task";
  return null;
}

export function isGenericToolTitle(value: string): boolean {
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
    normalized === "agent task" ||
    normalized === "subagent task" ||
    normalized === "task" ||
    normalized === "command run" ||
    normalized === "ran command" ||
    normalized === "running command" ||
    normalized === "command execution" ||
    normalized === "file change" ||
    normalized === "find" ||
    normalized === "read file"
  );
}

function normalizeToolDescriptor(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const mcpIdentifier = humanizeMcpToolIdentifier(value);
  if (mcpIdentifier) {
    return mcpIdentifier;
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
  const lowerCollapsed = collapsed.toLowerCase();
  if (lowerCollapsed === "read") {
    return "Read";
  }
  if (lowerCollapsed === "search" || lowerCollapsed === "find" || lowerCollapsed === "searched") {
    return "Search";
  }
  return collapsed.length > 64 ? `${collapsed.slice(0, 61).trimEnd()}...` : collapsed;
}

function humanizeMcpToken(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .split(" ")
    .map((token) => {
      const lower = token.toLowerCase();
      if (lower === "mcp") return "MCP";
      if (token.toUpperCase() === token && token.length <= 5) return token;
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function extractToolDescriptorFromPayload(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  if (!payload) {
    return null;
  }
  const mcpServerTool = extractMcpServerToolDescriptor(payload, 0);
  if (mcpServerTool) {
    return mcpServerTool;
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

function extractMcpServerToolDescriptor(value: unknown, depth: number): string | null {
  if (depth > 4 || !value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractMcpServerToolDescriptor(entry, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.server === "string" && typeof record.tool === "string") {
    return humanizeMcpServerTool(record.server, record.tool);
  }
  for (const nestedKey of ["item", "data", "event", "payload", "result", "input", "call"]) {
    const nested = extractMcpServerToolDescriptor(record[nestedKey], depth + 1);
    if (nested) {
      return nested;
    }
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

// Read-only inspection commands surfaced with the search/magnifying-glass icon in
// the timeline (reads, searches, finds, listings), as opposed to commands that
// mutate or execute, which keep the terminal icon. These sets are the single
// source of truth for both the command labels below and the icon decision.
const READ_FILE_COMMAND_TOOLS = new Set(["cat", "nl", "head", "tail", "sed", "less", "more"]);
const SEARCH_COMMAND_TOOLS = new Set(["rg", "grep", "ag", "ack"]);
const FIND_COMMAND_TOOLS = new Set(["find", "fd"]);
const LIST_COMMAND_TOOLS = new Set(["ls"]);

function isInspectCommandTool(tool: string): boolean {
  return (
    READ_FILE_COMMAND_TOOLS.has(tool) ||
    SEARCH_COMMAND_TOOLS.has(tool) ||
    FIND_COMMAND_TOOLS.has(tool) ||
    LIST_COMMAND_TOOLS.has(tool)
  );
}

// Derives the compact command sentence shown inline while preserving the full command for hover/detail UI.
export function deriveReadableCommandDisplay(
  rawCommand: string,
  isRunning = false,
): ReadableCommandDisplay {
  const command = stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
  const primaryCommand = firstShellCommandSegment(command);
  const [tool, args] = splitToolAndArgs(primaryCommand);

  if (READ_FILE_COMMAND_TOOLS.has(tool)) {
    return {
      verb: isRunning ? "Reading" : "Read",
      target: lastPathComponents(args, "file"),
      fullCommand: rawCommand,
    };
  }
  if (SEARCH_COMMAND_TOOLS.has(tool)) {
    return {
      verb: isRunning ? "Searching" : "Searched",
      target: searchSummary(args),
      fullCommand: rawCommand,
    };
  }
  if (LIST_COMMAND_TOOLS.has(tool)) {
    return {
      verb: isRunning ? "Listing" : "Listed",
      target: lastPathComponents(args, "directory"),
      fullCommand: rawCommand,
    };
  }
  if (FIND_COMMAND_TOOLS.has(tool)) {
    return {
      verb: isRunning ? "Finding" : "Found",
      target: findTarget(args, "files"),
      fullCommand: rawCommand,
    };
  }

  switch (tool) {
    case "mkdir":
      return {
        verb: isRunning ? "Creating" : "Created",
        target: lastPathComponents(args, "directory"),
        fullCommand: rawCommand,
      };
    case "rm":
      return {
        verb: isRunning ? "Removing" : "Removed",
        target: lastPathComponents(args, "file"),
        fullCommand: rawCommand,
      };
    case "cp":
    case "mv":
      return {
        verb: isRunning
          ? tool === "cp"
            ? "Copying"
            : "Moving"
          : tool === "cp"
            ? "Copied"
            : "Moved",
        target: lastPathComponents(args, "file"),
        fullCommand: rawCommand,
      };
    case "git":
      return humanizeGitCommand(args, rawCommand, isRunning);
    case "node":
    case "bun":
    case "deno":
    case "python":
    case "python3":
    case "ruby":
    case "perl":
      return {
        verb: isRunning ? "Running" : "Ran",
        target: inlineScriptTarget(tool, command, args) ?? compactInlineCommand(command),
        fullCommand: rawCommand,
      };
    case "osascript":
      return {
        verb: isRunning ? "Running" : "Ran",
        target: "AppleScript",
        fullCommand: rawCommand,
      };
    default:
      return {
        verb: isRunning ? "Running" : "Ran",
        target: compactInlineCommand(command),
        fullCommand: rawCommand,
      };
  }
}

// Whether a shell command is a read-only inspection (read/search/find/list).
// Reuses the same command unwrapping as deriveReadableCommandDisplay so the
// timeline search icon stays in sync with the derived command label.
export function isInspectCommand(rawCommand: string): boolean {
  return resolveCommandVisualKind(rawCommand) === "inspect";
}

// Classifies command rows for transcript glyphs after peeling away shell/env wrappers.
// This keeps `git -C`, `env ... gh`, and `/bin/zsh -lc "cd ... && git ..."` visually branded.
export function resolveCommandVisualKind(rawCommand: string): CommandVisualKind {
  const command = stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
  const [tool] = splitToolAndArgs(firstShellCommandSegment(command));
  if (isInspectCommandTool(tool)) {
    return "inspect";
  }
  if (tool === "git") {
    return "git";
  }
  if (tool === "gh" || tool === "hub") {
    return "github";
  }
  return "terminal";
}

export function deriveInlineCommandCall(rawCommand: string): string {
  return stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
}

function humanizeGitCommand(
  args: string,
  rawCommand: string,
  isRunning: boolean,
): ReadableCommandDisplay {
  const normalizedArgs = stripGitGlobalOptions(args);
  const subcommand = normalizedArgs.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  switch (subcommand) {
    case "status":
      return {
        verb: isRunning ? "Checking" : "Checked",
        target: "git status",
        fullCommand: rawCommand,
      };
    case "diff":
      return {
        verb: isRunning ? "Comparing" : "Compared",
        target: "changes",
        fullCommand: rawCommand,
      };
    case "show":
      return {
        verb: isRunning ? "Inspecting" : "Inspected",
        target: "commit",
        fullCommand: rawCommand,
      };
    case "log":
      return {
        verb: isRunning ? "Reviewing" : "Reviewed",
        target: "git history",
        fullCommand: rawCommand,
      };
    case "add":
      return {
        verb: isRunning ? "Staging" : "Staged",
        target: "changes",
        fullCommand: rawCommand,
      };
    case "commit":
      return {
        verb: isRunning ? "Committing" : "Committed",
        target: "changes",
        fullCommand: rawCommand,
      };
    case "push":
      return {
        verb: isRunning ? "Pushing" : "Pushed",
        target: "to remote",
        fullCommand: rawCommand,
      };
    case "pull":
      return {
        verb: isRunning ? "Pulling" : "Pulled",
        target: "from remote",
        fullCommand: rawCommand,
      };
    case "checkout":
    case "switch":
      return {
        verb: isRunning ? "Switching to" : "Switched to",
        target: checkoutTarget(args),
        fullCommand: rawCommand,
      };
    default:
      return {
        verb: isRunning ? "Running" : "Ran",
        target: compactInlineCommand(`git ${normalizedArgs}`.trim()),
        fullCommand: rawCommand,
      };
  }
}

function stripGitGlobalOptions(args: string): string {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      index += 2;
      continue;
    }
    if (
      token.startsWith("-C") ||
      token.startsWith("-c") ||
      token.startsWith("--git-dir=") ||
      token.startsWith("--work-tree=")
    ) {
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index).join(" ");
}

function checkoutTarget(args: string): string {
  const branch = tokenizeCommandArgs(args).at(-1)?.trim();
  return branch ? branch : "branch";
}

function lastPathComponents(args: string, fallback: string): string {
  const tokens = tokenizeCommandArgs(args);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!.replace(/^['"]|['"]$/g, "");
    if (!token || token.startsWith("-")) {
      continue;
    }
    return compactPath(token);
  }
  return fallback;
}

function findTarget(args: string, fallback: string): string {
  const tokens = tokenizeCommandArgs(args);
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-")) {
      if (
        token === "-maxdepth" ||
        token === "-mindepth" ||
        token === "-name" ||
        token === "-type" ||
        token === "-path"
      ) {
        skipNext = true;
      }
      continue;
    }
    return compactPath(token);
  }
  return fallback;
}

function compactPath(path: string): string {
  if (path === ".") {
    return "current directory";
  }
  if (path === "..") {
    return "parent directory";
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) {
    return path;
  }
  return parts.slice(-2).join("/");
}

function compactInlineCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 137).trimEnd()}...`;
}

function firstShellCommandSegment(command: string): string {
  const chain = findShellChain(command);
  return chain ? command.slice(0, chain.operatorStart).trim() : command;
}

function inlineScriptTarget(tool: string, command: string, args: string): string | null {
  const normalizedTool = tool === "python3" ? "python" : tool;
  if (containsHeredoc(command) || hasInlineScriptFlag(args)) {
    return `${normalizedTool} script`;
  }
  return null;
}

function containsHeredoc(command: string): boolean {
  return /(^|\s)<<-?\s*['"]?[A-Za-z0-9_]+/.test(command);
}

function hasInlineScriptFlag(args: string): boolean {
  const tokens = tokenizeCommandArgs(args);
  return tokens.some((token) => token === "-e" || token === "-c" || token.startsWith("-e="));
}

function searchSummary(args: string): string {
  const { pattern, path } = extractSearchPatternAndPath(args);
  if (pattern && path) {
    return `for ${pattern} in ${path}`;
  }
  if (pattern) {
    return `for ${pattern}`;
  }
  if (path) {
    return `in ${path}`;
  }
  return "files";
}

function extractSearchPatternAndPath(args: string): {
  pattern: string | null;
  path: string | null;
} {
  const tokens = tokenizeCommandArgs(args);
  let pattern: string | null = null;
  let path: string | null = null;
  let skipNext = false;

  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-")) {
      if (
        token === "-t" ||
        token === "-g" ||
        token === "--type" ||
        token === "--glob" ||
        token === "--max-count"
      ) {
        skipNext = true;
      }
      continue;
    }
    if (!pattern) {
      const normalizedPattern = normalizeSearchPatternToken(token);
      if (!normalizedPattern) {
        const normalizedPath = normalizeSearchPathToken(token);
        if (normalizedPath && (!path || path === "current directory")) {
          path = normalizedPath;
        }
        continue;
      }
      pattern = normalizedPattern;
      continue;
    }
    if (!path || path === "current directory") {
      path = normalizeSearchPathToken(token) ?? path;
      continue;
    }
  }

  if (pattern && path === "current directory" && looksLikeSearchPath(pattern)) {
    path = normalizeSearchPathToken(pattern);
    pattern = null;
  }

  return { pattern, path };
}

function normalizeSearchPatternToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return null;
  }
  if (!/[a-z0-9]/i.test(trimmed)) {
    return null;
  }
  return trimmed.length > 30 ? `${trimmed.slice(0, 27)}...` : trimmed;
}

function normalizeSearchPathToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  return compactPath(trimmed);
}

function looksLikeSearchPath(token: string): boolean {
  return token.includes("/") || token.startsWith(".") || token.includes("\\");
}

function tokenizeCommandArgs(args: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < args.length) {
    while (args[index] === " ") {
      index += 1;
    }
    if (index >= args.length) {
      break;
    }

    const quote = args[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      let token = "";
      while (index < args.length && args[index] !== quote) {
        if (args[index] === "\\" && index + 1 < args.length) {
          token += args[index + 1];
          index += 2;
          continue;
        }
        token += args[index];
        index += 1;
      }
      if (args[index] === quote) {
        index += 1;
      }
      tokens.push(token);
      continue;
    }

    let token = "";
    while (index < args.length && args[index] !== " ") {
      token += args[index];
      index += 1;
    }
    if (token) {
      tokens.push(token);
    }
  }

  return tokens;
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
    value = stripLeadingShellPreambles(value);
    break;
  }

  const pipeIndex = value.search(/\s*\|\s*/);
  if (pipeIndex > 0) {
    value = value.slice(0, pipeIndex).trim();
  }

  return value;
}

function stripLeadingShellPreambles(value: string): string {
  let current = value.trim();
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const chain = findShellChain(current);
    if (!chain) {
      return current;
    }
    const head = current.slice(0, chain.operatorStart).trim();
    if (!isShellSetupPreamble(head)) {
      return current;
    }
    current = current.slice(chain.commandStart).trim();
  }
  return current;
}

function isShellSetupPreamble(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (/^(?:builtin\s+)?cd\s+/.test(normalized)) {
    return true;
  }
  if (/^(?:source|\.)\s+/.test(normalized)) {
    return true;
  }
  if (/^set\s+[-+][A-Za-z]/.test(normalized)) {
    return true;
  }
  if (
    /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=[^\s]+(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]+)*$/.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function findShellChain(value: string): { operatorStart: number; commandStart: number } | null {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const next = value[index + 1];
    if (char === "&" && next === "&") {
      return { operatorStart: index, commandStart: index + 2 };
    }
    if (char === ";") {
      return { operatorStart: index, commandStart: index + 1 };
    }
  }

  return null;
}

function stripCommandDisplayWrappers(command: string): string {
  let current = command.replace(/\s+/g, " ").trim();
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const [tool, args] = splitToolAndArgs(current);
    const next =
      tool === "env"
        ? stripEnvCommand(args)
        : tool === "timeout" || tool === "gtimeout"
          ? stripTimeoutCommand(args)
          : tool === "nice"
            ? stripNiceCommand(args)
            : tool === "arch"
              ? stripArchCommand(args)
              : tool === "command"
                ? args
                : null;
    if (!next || next === current) {
      return current;
    }
    current = next.trim();
  }
  return current;
}

function stripEnvCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
      index += 2;
      continue;
    }
    if (token.startsWith("--unset=") || token.startsWith("--chdir=")) {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripTimeoutCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length && tokens[index]?.startsWith("-")) {
    index += tokens[index] === "-s" || tokens[index] === "-k" ? 2 : 1;
  }
  if (index < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[index]!)) {
    index += 1;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripNiceCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  if (tokens[index] === "-n") {
    index += 2;
  } else {
    while (tokens[index]?.startsWith("-")) {
      index += 1;
    }
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripArchCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (tokens[index]?.startsWith("-")) {
    index += 1;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}
