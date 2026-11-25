// FILE: codexStderr.ts
// Purpose: Classify Codex text/JSON diagnostics consistently at ingestion and historical rendering.
// Layer: Shared runtime utility; no logging or process ownership.

import { MCP_CONNECTOR_SERVER_NAME_SUFFIX, SYNARA_MCP_SERVER_NAME } from "./mcpConnectors";
import { stripTerminalControlSequences } from "./text";

// Stored on persisted warning rows that came from Codex stderr.
export const CODEX_STDERR_NATIVE_EVENT_TYPE = "codex.process/stderr";

const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(\S+):\s+(.*)$/;
// Plain (non-log) stderr is mostly progress chatter; only error-like lines are worth a row.
const ERROR_LIKE_LINE = /error|failed|fatal|panic|exception|denied|refused/i;
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

// This startup notice describes opt-in configuration, not a failure of the task.
export function isCodexUnstableFeaturesWarning(message: string): boolean {
  return (
    message.trimStart().startsWith("Under-development features enabled:") &&
    message.includes("suppress_unstable_features_warning = true")
  );
}

// Keep the legacy opt-out intact; this diagnostic is also sent as configWarning and warning.
export function isCodexMultiAgentDeprecationWarning(message: string): boolean {
  return (
    message ===
    "`[features].multi_agent` is deprecated. It still controls the V1 fallback. `[agents].enabled = false` disables subagent tools even when the model selects a subagent version, unless `[features].multi_agent_v2` is enabled."
  );
}

function isUserConfiguredMcpServer(server: string): boolean {
  return server !== SYNARA_MCP_SERVER_NAME && !server.endsWith(MCP_CONNECTOR_SERVER_NAME_SUFFIX);
}

export function isCodexUserMcpOAuthStartupError(server: string, error: string): boolean {
  return (
    isUserConfiguredMcpServer(server) &&
    error ===
      `The ${server} MCP server requires OAuth reauthentication. Run \`codex mcp login ${server}\`.`
  );
}

// Read only the recognized refusal body, never infer a server from an anonymous worker log.
export function readCodexMcpSubscriptionError(message: string): string | undefined {
  const quotedResponse = /UnexpectedServerResponse\(("(?:[^"\\]|\\.)*")\)$/.exec(message)?.[1];
  if (quotedResponse) {
    try {
      message = JSON.parse(quotedResponse);
    } catch {
      return;
    }
  }
  const body = /HTTP 403: (\{\s*"error"\s*:\s*"(?:[^"\\]|\\.)*"\s*\})/.exec(message)?.[1];
  if (!body) return;
  try {
    const error: unknown = JSON.parse(body).error;
    if (
      typeof error === "string" &&
      /^(?:subscription_inactive|subscription_required): /.test(error)
    )
      return error;
  } catch {
    return;
  }
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
// `errorLikePlainLinesOnly` is opt-in and meant for raw Codex process stderr only: other
// providers' warnings pass through this function too and must keep their plain text.
export function classifyCodexStderr(
  line: string,
  mirroredUserConfigPath?: string,
  options?: { errorLikePlainLinesOnly?: boolean },
):
  | { kind: "notice"; message: string; configWarning?: true; mcpSubscriptionError?: string }
  | { kind: "user-mcp-oauth"; server: string }
  | null {
  line = normalizeCodexProcessLine(line);
  if (isIgnorableCodexProcessLine(line)) return null;
  const log = readLog(line);
  if (isCodexUnstableFeaturesWarning(log?.message ?? line)) return null;
  if (log) {
    // The overlay already loads these settings at user level. Codex can rediscover
    // the source file as a project config; only that duplicate notice is harmless.
    if (
      mirroredUserConfigPath &&
      log.target === "codex_app_server" &&
      log.message.startsWith(
        `Ignored unsupported project-local config keys in ${mirroredUserConfigPath}: `,
      ) &&
      log.message.endsWith(
        "If you want these settings to apply, manually set them in your user-level config.toml.",
      )
    )
      return null;
    if (log.level !== "ERROR" || BENIGN_ERRORS.some((snippet) => log.message.includes(snippet)))
      return null;
    const server = /\bcodex_rmcp_client::oauth\S*:.*?\bfor server ([A-Za-z0-9_.-]+)/.exec(
      `${log.target}: ${log.message}`,
    )?.[1];
    if (server && isUserConfiguredMcpServer(server)) {
      return { kind: "user-mcp-oauth", server };
    }
  }
  if (!log && options?.errorLikePlainLinesOnly && !ERROR_LIKE_LINE.test(line)) return null;
  const mcpSubscriptionError =
    log?.target === "rmcp::transport::worker" &&
    log.message.startsWith(
      "worker quit with fatal: Transport channel closed, when UnexpectedServerResponse(",
    )
      ? readCodexMcpSubscriptionError(log.message)
      : undefined;
  return {
    kind: "notice",
    message: normalizeCodexUserVisibleErrorMessage(line),
    ...(log?.target === "codex_app_server" && isCodexMultiAgentDeprecationWarning(log.message)
      ? { message: log.message, configWarning: true as const }
      : {}),
    ...(mcpSubscriptionError ? { mcpSubscriptionError } : {}),
  };
}
