// FILE: codexStderr.ts
// Purpose: Classify Codex text/JSON diagnostics consistently at ingestion and historical rendering.
// Layer: Shared runtime utility; no logging or process ownership.

import { MCP_CONNECTOR_SERVER_NAME_SUFFIX, SYNARA_MCP_SERVER_NAME } from "./mcpConnectors";
import { stripTerminalControlSequences } from "./text";

const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(\S+):\s+(.*)$/;
const BENIGN_ERRORS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];

export function normalizeCodexProcessLine(line: string): string {
  return stripTerminalControlSequences(line).trim();
}

export function isIgnorableCodexProcessLine(line: string): boolean {
  return !line || /^(?:\^C)?Token usage:/i.test(line);
}

// Require a complete log envelope; arbitrary JSON and malformed output remain visible.
function readLog(line: string): { level: string; target: string; message: string } | undefined {
  const match = LOG_LINE.exec(line);
  if (match) return { level: match[2]!, target: match[3]!, message: match[4]! };
  if (!line.startsWith("{")) return;
  try {
    const log = JSON.parse(line);
    const message = log?.fields?.message ?? log?.fields?.error;
    if (
      typeof log?.timestamp !== "string" ||
      typeof log?.target !== "string" ||
      !/^(TRACE|DEBUG|INFO|WARN|ERROR)$/.test(log?.level) ||
      typeof message !== "string"
    )
      return;
    return { level: log.level, target: log.target, message };
  } catch {
    return;
  }
}

export function normalizeCodexUserVisibleErrorMessage(rawMessage: string): string {
  const line = normalizeCodexProcessLine(rawMessage);
  // Extract complete JSON log messages; preserve unrecognized output for inspection.
  const message = line.startsWith("{") ? (readLog(line)?.message ?? line) : line;
  const duplicate = /failed to parse function arguments: duplicate field `([^`]+)`/i.exec(message);
  return duplicate
    ? `Tool call failed because the same argument was sent twice (${duplicate[1]}).`
    : message;
}

// A user-configured MCP OAuth failure is reported to the host logger, not every chat.
export function classifyCodexStderr(
  line: string,
): { kind: "notice"; message: string } | { kind: "user-mcp-oauth"; server: string } | null {
  line = normalizeCodexProcessLine(line);
  if (isIgnorableCodexProcessLine(line)) return null;
  const log = readLog(line);
  if (log) {
    if (log.level !== "ERROR" || BENIGN_ERRORS.some((snippet) => log.message.includes(snippet)))
      return null;
    const server = /\bcodex_rmcp_client::oauth\S*:.*?\bfor server ([A-Za-z0-9_.-]+)/.exec(
      `${log.target}: ${log.message}`,
    )?.[1];
    if (
      server &&
      server !== SYNARA_MCP_SERVER_NAME &&
      !server.endsWith(MCP_CONNECTOR_SERVER_NAME_SUFFIX)
    ) {
      return { kind: "user-mcp-oauth", server };
    }
  }
  return { kind: "notice", message: normalizeCodexUserVisibleErrorMessage(line) };
}
