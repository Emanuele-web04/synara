/**
 * Classification of Claude tool calls into canonical runtime item and approval
 * types, plus tool lifecycle presentation helpers (titles, summaries, todo
 * normalization). Known first-party Claude Code tools resolve through an
 * explicit table; substring heuristics remain only as a fallback for tools we
 * don't know by name (MCP tools, plugin tools, future additions).
 */
import type {
  CanonicalItemType,
  CanonicalRequestType,
  RuntimeContentStreamKind,
} from "@t3tools/contracts";
import { trimOrNull } from "@t3tools/shared/model";

export type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

// First-party Claude Code tool names (case-insensitive) with their canonical
// item type. Heuristics below only apply to names absent from this table.
const KNOWN_CLAUDE_TOOL_ITEM_TYPES: ReadonlyMap<string, CanonicalItemType> = new Map([
  ["task", "collab_agent_tool_call"],
  ["agent", "collab_agent_tool_call"],
  ["workflow", "collab_agent_tool_call"],
  ["sendmessage", "collab_agent_tool_call"],
  ["bash", "command_execution"],
  ["bashoutput", "command_execution"],
  ["killbash", "command_execution"],
  ["killshell", "command_execution"],
  ["edit", "file_change"],
  ["multiedit", "file_change"],
  ["write", "file_change"],
  ["notebookedit", "file_change"],
  ["read", "dynamic_tool_call"],
  ["notebookread", "dynamic_tool_call"],
  ["glob", "dynamic_tool_call"],
  ["grep", "dynamic_tool_call"],
  ["websearch", "web_search"],
  ["webfetch", "web_search"],
  ["todowrite", "plan"],
  ["todoread", "plan"],
  ["taskoutput", "dynamic_tool_call"],
  ["taskstop", "dynamic_tool_call"],
  ["slashcommand", "dynamic_tool_call"],
  ["skill", "dynamic_tool_call"],
  ["listmcpresources", "mcp_tool_call"],
  ["readmcpresource", "mcp_tool_call"],
  ["askuserquestion", "dynamic_tool_call"],
  ["exitplanmode", "plan"],
]);

// First-party tools that only read state. Network tools (WebSearch, WebFetch)
// are deliberately excluded — their approvals must not be labeled file reads.
const KNOWN_READ_ONLY_CLAUDE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "notebookread",
  "glob",
  "grep",
  "bashoutput",
  "taskoutput",
  "todoread",
  "listmcpresources",
  "readmcpresource",
]);

function classifyToolItemTypeHeuristically(normalized: string): CanonicalItemType {
  if (normalized.includes("todo")) {
    return "plan";
  }
  if (
    normalized.includes("agent") ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent") ||
    normalized.includes("workflow")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  return (
    KNOWN_CLAUDE_TOOL_ITEM_TYPES.get(normalized) ?? classifyToolItemTypeHeuristically(normalized)
  );
}

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  if (KNOWN_CLAUDE_TOOL_ITEM_TYPES.has(normalized)) {
    return KNOWN_READ_ONLY_CLAUDE_TOOLS.has(normalized);
  }
  return (
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const serialized = JSON.stringify(input);
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

// Tools whose result is surfaced through a dedicated runtime channel — AskUserQuestion
// via the user-input request flow, ExitPlanMode via the proposed-plan flow — must NOT
// also emit a generic tool-call lifecycle item, or the timeline shows a redundant
// "ToolName: {json}" row alongside the real interaction surface.
export function isClientSurfacedClaudeTool(toolName: string): boolean {
  return toolName === "AskUserQuestion" || toolName === "ExitPlanMode";
}

// Stable per-call identity stamped on every tool lifecycle event's data so the client
// can collapse started/updated/completed (and dedupe parallel calls) by tool-call id
// instead of relying on row adjacency. Mirrors the shape other adapters emit (Pi/Grok).
export function toolLifecycleEventData(
  tool: {
    readonly itemId: string;
    readonly toolName: string;
    readonly input: Record<string, unknown>;
  },
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    toolCallId: tool.itemId,
    callId: tool.itemId,
    toolName: tool.toolName,
    input: tool.input,
    ...extra,
  };
}

export function normalizeClaudeTodoStatus(value: unknown): "pending" | "inProgress" | "completed" {
  if (value === "completed") {
    return "completed";
  }
  if (value === "in_progress") {
    return "inProgress";
  }
  return "pending";
}

export function normalizeClaudeTodoTasks(input: Record<string, unknown>): {
  readonly tasks: ReadonlyArray<{
    readonly task: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} | null {
  const todos = Array.isArray(input.todos) ? input.todos : null;
  if (!todos) {
    return null;
  }

  const tasks = todos
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const todo = entry as Record<string, unknown>;
      const status = normalizeClaudeTodoStatus(todo.status);
      const content = trimOrNull(typeof todo.content === "string" ? todo.content : null);
      const activeForm = trimOrNull(typeof todo.activeForm === "string" ? todo.activeForm : null);
      const task = status === "inProgress" ? (activeForm ?? content) : (content ?? activeForm);
      if (!task) {
        return null;
      }
      return {
        task,
        status,
      };
    })
    .filter(
      (
        task,
      ): task is {
        readonly task: string;
        readonly status: "pending" | "inProgress" | "completed";
      } => task !== null,
    );

  return tasks.length > 0 ? { tasks } : null;
}

export function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "plan":
      return "Plan";
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

export function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

export function toolResultStreamKind(
  itemType: CanonicalItemType,
): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}
