import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns";
import {
  isToolLifecycleItemType,
  type OrchestrationMessage,
  type ProviderRuntimeEvent,
  type ProviderRuntimeRequestOpenedEvent,
} from "@synara/contracts";

export interface AutoToolCall {
  readonly tool: string;
  readonly args: string;
}
export interface AutoHistoryEntry extends AutoToolCall {
  readonly result: string;
}

/** Exact serialization from the pinned auto-0.4b-2 model card. */
export function buildAutoInput(
  userRequest: string,
  history: readonly AutoHistoryEntry[],
  call: AutoToolCall,
): string {
  const parts = [
    "### PROPOSED TOOL CALL",
    `tool: ${call.tool}`,
    `args: ${call.args}`,
    "",
    "### USER REQUEST",
    userRequest,
    "",
    "### AGENT HISTORY",
  ];
  if (history.length === 0) parts.push("(no prior actions)");
  else
    history.forEach((entry, index) =>
      parts.push(`[${index + 1}] ${entry.tool}(${entry.args})\n-> ${entry.result}`),
    );
  return parts.join("\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function serialize(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const ACP_PROVIDERS = new Set(["cursor", "grok", "droid", "devin"]);

function acpCall(data: Record<string, unknown>): AutoToolCall | undefined {
  if (data.rawInput === undefined) return;
  const rawInput = record(data.rawInput);
  const tool = typeof rawInput?._toolName === "string" ? rawInput._toolName : data.kind;
  if (typeof tool !== "string" || !tool.trim()) return;
  return { tool, args: serialize(data.rawInput) };
}

export function proposedCall(event: ProviderRuntimeRequestOpenedEvent): AutoToolCall | undefined {
  const args = record(event.payload.args);
  if (!args || args.incompleteContext === true) return;
  // Permission-profile expansion, authentication, and structured user input
  // always remain interactive, even if they carry tool-like metadata.
  const ordinaryApproval = [
    "command_execution_approval",
    "exec_command_approval",
    "file_read_approval",
    "file_change_approval",
    "apply_patch_approval",
  ].includes(event.payload.requestType);
  if (!ordinaryApproval && event.payload.requestType !== "unknown") return;
  if (!ordinaryApproval && (event.provider === "codex" || event.provider === "claudeAgent")) return;
  if (
    ["claudeAgent", "pi", "antigravity"].includes(event.provider) &&
    typeof args.toolName === "string" &&
    args.input !== undefined
  ) {
    if (
      ["AskUserQuestion", "ExitPlanMode", "ask_question", "ask_permission"].includes(args.toolName)
    )
      return;
    return { tool: args.toolName, args: serialize(args.input) };
  }
  if (ACP_PROVIDERS.has(event.provider)) {
    // An ACP accept may fall back to allow_always. A local classifier may only
    // grant this call, so require an actual request-scoped option.
    if (
      !Array.isArray(args.options) ||
      !args.options.some((option) => record(option)?.kind === "allow_once")
    )
      return;
    const tool = record(args.toolCall);
    return tool ? acpCall(tool) : undefined;
  }
  if (event.provider === "opencode") {
    const tool = record(args.localAutoTool);
    if (
      !tool ||
      typeof tool.permission !== "string" ||
      ["external_directory", "doom_loop", "question"].includes(tool.permission) ||
      typeof tool.toolName !== "string" ||
      tool.input === undefined
    )
      return;
    return { tool: tool.toolName, args: serialize(tool.input) };
  }
  if (
    event.provider === "codex" &&
    (typeof args.command === "string" || Array.isArray(args.command))
  ) {
    return { tool: "exec_command", args: serialize(args) };
  }
  // A file-change approval often contains only a reason/path, not the patch.
  // Never substitute that summary for the proposed mutation.
  if (event.provider === "codex" && (typeof args.patch === "string" || record(args.changes))) {
    return { tool: "apply_patch", args: serialize(args) };
  }
}

function historyCall(
  event: Extract<ProviderRuntimeEvent, { type: "item.completed" }>,
): AutoHistoryEntry | undefined {
  const data = record(event.payload.data);
  if (!data) return;
  if (
    (event.provider === "claudeAgent" || event.provider === "pi") &&
    typeof data.toolName === "string" &&
    data.input !== undefined &&
    data.result !== undefined
  ) {
    return { tool: data.toolName, args: serialize(data.input), result: serialize(data.result) };
  }
  if (ACP_PROVIDERS.has(event.provider)) {
    const call = acpCall(data);
    const output = data.rawOutput ?? data.content;
    return call && output !== undefined ? { ...call, result: serialize(output) } : undefined;
  }
  if (event.provider === "opencode") {
    const state = record(data.state);
    const output = state?.output ?? state?.error;
    if (typeof data.toolName === "string" && data.input !== undefined && output !== undefined)
      return { tool: data.toolName, args: serialize(data.input), result: serialize(output) };
  }
  if (
    event.provider === "antigravity" &&
    typeof data.toolName === "string" &&
    data.rawInput !== undefined &&
    data.rawOutput !== undefined
  ) {
    return {
      tool: data.toolName,
      args: serialize(data.rawInput),
      result: serialize(data.rawOutput),
    };
  }
  if (event.provider === "codex") {
    const source = record(data.item) ?? data;
    if (source.command !== undefined && source.aggregatedOutput !== undefined) {
      return {
        tool: "exec_command",
        args: serialize({
          command: source.command,
          ...(source.cwd !== undefined ? { cwd: source.cwd } : {}),
        }),
        result: serialize({ output: source.aggregatedOutput, exitCode: source.exitCode }),
      };
    }
    if (
      typeof source.tool === "string" &&
      source.arguments !== undefined &&
      (source.result !== undefined || source.error !== undefined)
    ) {
      return {
        tool: source.tool,
        args: serialize(source.arguments),
        result: serialize(source.result ?? source.error),
      };
    }
    if (source.changes !== undefined) {
      return {
        tool: "apply_patch",
        args: serialize(source.changes),
        result: String(source.status ?? event.payload.status ?? "completed"),
      };
    }
  }
}

export function classifierContext(input: {
  readonly request: ProviderRuntimeRequestOpenedEvent;
  readonly events: readonly ProviderRuntimeEvent[];
  readonly messages: readonly OrchestrationMessage[];
  readonly turns: readonly ProjectionTurn[];
}): string | undefined {
  const call = proposedCall(input.request);
  if (
    !call ||
    !input.request.turnId ||
    input.messages.some((message) => message.source !== "native")
  )
    return;
  const dispatched = new Set(
    input.turns.filter((turn) => turn.turnId).map((turn) => turn.pendingMessageId),
  );
  const users = input.messages.filter(
    (message) =>
      message.role === "user" &&
      message.createdAt <= input.request.createdAt &&
      (dispatched.has(message.id) || message.startsNewTurn === false),
  );
  if (
    users.length === 0 ||
    users.some(
      (message) =>
        !message.text.trim() ||
        (message.attachments?.length ?? 0) > 0 ||
        message.source !== "native" ||
        (message.dispatchOrigin !== undefined && message.dispatchOrigin !== "user"),
    )
  )
    return;
  // Every dispatched turn must still have its journal start. Retention,
  // imports, handoffs, and missing provider history cannot become empty history.
  const starts = new Set(
    input.events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
  );
  if (
    !starts.has(input.request.turnId) ||
    input.turns.some((turn) => turn.turnId && !starts.has(turn.turnId))
  )
    return;
  const history: AutoHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const event of input.events) {
    if (event.provider !== input.request.provider || event.threadId !== input.request.threadId)
      return;
    if (event.type === "item.completed" && event.payload.itemType === "context_compaction") return;
    if (event.type !== "item.completed" || !isToolLifecycleItemType(event.payload.itemType))
      continue;
    if (!event.itemId) return;
    if (seen.has(event.itemId)) continue;
    seen.add(event.itemId);
    const entry = historyCall(event);
    if (!entry) return;
    history.push(entry);
  }
  const userRequest = users.map((message) => message.text).join("\n\n");
  const text = buildAutoInput(userRequest, history, call);
  return Buffer.byteLength(text) <= 2 * 1024 * 1024 ? text : undefined;
}
