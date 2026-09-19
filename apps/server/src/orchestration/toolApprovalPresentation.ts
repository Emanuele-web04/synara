// FILE: toolApprovalPresentation.ts
// Purpose: Builds the durable presentation of a tool-approval card from a
// `request.opened` runtime event.
// Layer: orchestration projection helper
//
// A tool approval is the one card where the thing being described is also the
// thing asking for permission: an MCP server supplies its own `_meta.tool_name`
// and `_meta.tool_params_display`. Those fields are display copy from an
// untrusted party, so they never replace what Synara knows from the request
// itself, they are always attributed to the server that sent them, and they are
// bounded before they reach the durable activity payload.

const TOOL_APPROVAL_REQUEST_TYPES = new Set(["tool_approval", "dynamic_tool_call"]);

/** Enough rows to describe a call; a tool with more is summarized, not dumped. */
const MAX_PARAMETER_ROWS = 12;
/** Approval cards show one compact line per parameter. */
const MAX_PARAMETER_VALUE_CHARS = 240;
const MAX_PARAMETER_NAME_CHARS = 64;

/**
 * Identifier segments that mean "this value is a credential".
 *
 * Deliberately stricter than the logging sanitizer's substring match
 * (`agentGateway/diagnosticSanitizer.ts`): this text is shown to a human who is
 * deciding whether to allow a call, so redacting `keyboard` because it contains
 * `key` would hide the very thing they are judging. Matching whole identifier
 * segments keeps `api_key`, `authToken` and `Authorization` redacted while
 * leaving ordinary parameters readable.
 */
const SENSITIVE_PARAMETER_SEGMENTS = new Set([
  "auth",
  "authorization",
  "apikey",
  "bearer",
  "credential",
  "credentials",
  "cookie",
  "key",
  "keys",
  "passphrase",
  "passwd",
  "password",
  "pwd",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

const REDACTED_PARAMETER_VALUE = "[redacted]";

export interface ToolApprovalParameterDisplay {
  readonly name: string;
  readonly value: string;
  readonly displayName?: string;
}

export interface ToolApprovalPresentation {
  /** The tool being approved, preferring the name Synara read off the request. */
  readonly toolName?: string;
  /** Who is asking: the MCP server when known, otherwise the provider runtime. */
  readonly toolSource: string;
  readonly toolParamsDisplay?: ReadonlyArray<ToolApprovalParameterDisplay>;
  /**
   * True when the rendered name or parameters came from the runtime's own
   * `_meta` rather than from the request Synara parsed. The card attributes
   * those fields to `toolSource` instead of presenting them as fact.
   */
  readonly toolDetailsReported?: boolean;
}

export function isToolApprovalRequestType(requestType: string | undefined): boolean {
  return requestType !== undefined && TOOL_APPROVAL_REQUEST_TYPES.has(requestType);
}

export function buildToolApprovalPresentation(input: {
  readonly requestType: string | undefined;
  readonly providerDisplayName: string;
  readonly args: unknown;
}): ToolApprovalPresentation | undefined {
  if (!isToolApprovalRequestType(input.requestType)) {
    return undefined;
  }
  const args = asRecord(input.args);
  const metadata = asRecord(args?._meta);

  // Claude's `canUseTool` hands Synara the tool name and the raw input; Codex
  // forwards an MCP elicitation whose only tool identity lives in `_meta`.
  const requestToolName = asNonEmptyString(args?.toolName);
  const reportedToolName = asNonEmptyString(metadata?.tool_name);
  const toolName = requestToolName ?? reportedToolName;

  const requestParameters = parameterRowsFromToolInput(asRecord(args?.input));
  const reportedParameters = requestParameters
    ? undefined
    : parameterRowsFromReportedDisplay(metadata?.tool_params_display);
  const toolParamsDisplay = requestParameters ?? reportedParameters;

  const reportedNameUsed = requestToolName === undefined && reportedToolName !== undefined;
  const toolDetailsReported = reportedNameUsed || reportedParameters !== undefined;

  return {
    ...(toolName ? { toolName } : {}),
    toolSource:
      asNonEmptyString(args?.serverName) ??
      mcpServerFromToolName(requestToolName) ??
      input.providerDisplayName,
    ...(toolParamsDisplay ? { toolParamsDisplay } : {}),
    ...(toolDetailsReported ? { toolDetailsReported: true } : {}),
  };
}

/** `mcp__<server>__<tool>` is how both Claude and Codex namespace MCP tools. */
function mcpServerFromToolName(toolName: string | undefined): string | undefined {
  const match = toolName?.match(/^mcp__([^_](?:[^_]|_(?!_))*)__/u);
  return match?.[1];
}

function parameterRowsFromToolInput(
  input: Record<string, unknown> | undefined,
): ReadonlyArray<ToolApprovalParameterDisplay> | undefined {
  if (input === undefined) {
    return undefined;
  }
  return boundParameterRows(Object.entries(input).map(([name, value]) => ({ name, value })));
}

function parameterRowsFromReportedDisplay(
  value: unknown,
): ReadonlyArray<ToolApprovalParameterDisplay> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return boundParameterRows(
    value.flatMap((entry) => {
      const record = asRecord(entry);
      const name = asNonEmptyString(record?.name);
      if (record === undefined || name === undefined) {
        return [];
      }
      const displayName = asNonEmptyString(record.display_name ?? record.displayName);
      return [
        {
          name,
          value: record.value,
          ...(displayName ? { displayName } : {}),
        },
      ];
    }),
  );
}

function boundParameterRows(
  rows: ReadonlyArray<{
    readonly name: string;
    readonly value: unknown;
    readonly displayName?: string;
  }>,
): ReadonlyArray<ToolApprovalParameterDisplay> | undefined {
  const bounded = rows.slice(0, MAX_PARAMETER_ROWS).map((row) => {
    const display: { name: string; value: string; displayName?: string } = {
      name: truncate(row.name, MAX_PARAMETER_NAME_CHARS),
      // A credential must not be written to the durable activity payload at
      // all: approval cards are persisted and replayed into the timeline.
      value: isSensitiveParameterName(row.name)
        ? REDACTED_PARAMETER_VALUE
        : truncate(stringifyParameterValue(row.value), MAX_PARAMETER_VALUE_CHARS),
    };
    if (row.displayName) {
      display.displayName = truncate(row.displayName, MAX_PARAMETER_NAME_CHARS);
    }
    return display;
  });
  if (rows.length > MAX_PARAMETER_ROWS) {
    bounded.push({
      name: `… ${rows.length - MAX_PARAMETER_ROWS} more parameters`,
      value: "",
    });
  }
  return bounded.length > 0 ? bounded : undefined;
}

export function isSensitiveParameterName(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^a-zA-Z0-9]+/u)
    .some((segment) => SENSITIVE_PARAMETER_SEGMENTS.has(segment.toLowerCase()));
}

function stringifyParameterValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
