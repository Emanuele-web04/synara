import type { ProviderInteractionMode, RuntimeMode } from "@synara/contracts";

/** Exact tool names owned by Synara's capability-gated Computer gateway. */
export const SYNARA_COMPUTER_TOOL_NAMES = [
  "computer_activate_window",
  "computer_click",
  "computer_double_click",
  "computer_drag",
  "computer_get_screen_size",
  "computer_get_state",
  "computer_hotkey",
  "computer_input_paused",
  "computer_launch_app",
  "computer_list_windows",
  "computer_move_cursor",
  "computer_perform_action",
  "computer_press_key",
  "computer_read_clipboard",
  "computer_right_click",
  "computer_screenshot",
  "computer_scroll",
  "computer_set_value",
  "computer_triple_click",
  "computer_type_text",
  "computer_wait",
  "computer_write_clipboard",
] as const;

export type SynaraComputerToolName = (typeof SYNARA_COMPUTER_TOOL_NAMES)[number];

const SYNARA_COMPUTER_TOOL_NAME_SET = new Set<string>(SYNARA_COMPUTER_TOOL_NAMES);

function recordString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = Reflect.get(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Accept only the canonical gateway name or the exact provider qualifications
 * used for Synara's reserved MCP server. A similarly named tool from another
 * MCP server must continue through the provider's ordinary permission policy.
 */
export function canonicalSynaraComputerToolName(
  value: unknown,
): SynaraComputerToolName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  const canonical = normalized.startsWith("mcp__synara__")
    ? normalized.slice("mcp__synara__".length)
    : normalized.startsWith("synara_")
      ? normalized.slice("synara_".length)
      : normalized;
  return SYNARA_COMPUTER_TOOL_NAME_SET.has(canonical)
    ? (canonical as SynaraComputerToolName)
    : undefined;
}

/**
 * Provider callbacks must carry Synara's namespace themselves. Bare canonical
 * names are safe only after a separate protocol field has proved the server
 * identity (for example Codex's `serverName`).
 */
export function qualifiedSynaraComputerToolName(
  value: unknown,
): SynaraComputerToolName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith("mcp__synara__") && !normalized.startsWith("synara_")) {
    return undefined;
  }
  return canonicalSynaraComputerToolName(normalized);
}

/**
 * Pi silent-loss fallback SPEC: namespace-insensitive Computer family matcher.
 *
 * A session that was never granted computer control must still surface the
 * denial card path when the model reaches for a Computer tool, or the attempt
 * dies as a silent tool error and the user never learns control is off. Two
 * gaps lose it today:
 *
 * 1. Gateway transport (all MCP providers): `makeAgentGatewayMcpTransport`
 *    (`apps/server/src/agentGateway/mcpTransport.ts`) denies an unknown tool
 *    name with `capability_denied` plus the denial hook only when
 *    `isComputerToolName` matches. That predicate is wired in
 *    `apps/server/src/agentGateway/Layers/AgentGateway.ts` as an exact match
 *    against the served catalog names (`computer_click`, ...), so a prefixed
 *    spelling from a session that never saw the catalog —
 *    `synara_computer_click`, `mcp__synara__computer_click` — falls through
 *    to Unknown-tool INVALID_PARAMS with no `computer-control-denied`
 *    activity and no card. Minimal patch at that call site:
 *    `isComputerToolName: (toolName) => isSynaraComputerToolFamilyName(toolName)`.
 * 2. Pi native projection: `buildPiAgentGatewayCustomTools`
 *    (`apps/server/src/provider/Layers/PiAdapter.ts`) projects only the
 *    leased catalog into Pi's custom-tool API, so without computer control
 *    the family is absent and a Pi-local `computer_*` call fails inside the
 *    Pi SDK without ever reaching the gateway transport above. Minimal patch
 *    there: register one fallback custom tool per family name that forwards
 *    to `callAgentGatewayMcpTool`, letting the gateway deny it with the card,
 *    or surface a local `capability_denied` shaped like the gateway's.
 *
 * Entirely-unknown names (`computer_future_tool`, another server's
 * `mcp__other__computer_click`) must keep their current behavior — unknown
 * tools stay INVALID_PARAMS and foreign tools keep the provider's ordinary
 * permission policy — so this matcher accepts only exact owned names in any
 * of the three spellings, never prose around them.
 */
export function isSynaraComputerToolFamilyName(value: unknown): boolean {
  return canonicalSynaraComputerToolName(value) !== undefined;
}

function firstRecordString(value: unknown, keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const candidate = recordString(value, key);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

export function computerToolNameFromProviderPermission(input: {
  readonly name?: unknown;
  readonly title?: unknown;
  readonly rawInput?: unknown;
  readonly metadata?: unknown;
}): SynaraComputerToolName | undefined {
  const explicitName = typeof input.name === "string" ? input.name : undefined;
  if (explicitName !== undefined) return qualifiedSynaraComputerToolName(explicitName);

  const rawToolName = firstRecordString(input.rawInput, ["_toolName", "toolName", "tool_name"]);
  if (rawToolName !== undefined) return qualifiedSynaraComputerToolName(rawToolName);

  const metadataToolName = firstRecordString(input.metadata, [
    "_toolName",
    "toolName",
    "tool_name",
  ]);
  if (metadataToolName !== undefined) return qualifiedSynaraComputerToolName(metadataToolName);

  return qualifiedSynaraComputerToolName(input.title);
}

/**
 * Provider permission prompts are redundant for an active Synara Computer
 * capability: the gateway performs the authoritative task-scoped approval.
 * Plan mode and requests outside an active turn remain fail-closed.
 */
export function shouldAllowSynaraComputerProviderTool(input: {
  readonly computerControlEnabled: boolean;
  readonly activeTurn: boolean;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly permission: Parameters<typeof computerToolNameFromProviderPermission>[0];
}): boolean {
  return (
    input.computerControlEnabled &&
    input.activeTurn &&
    input.runtimeMode === "approval-required" &&
    input.interactionMode === "default" &&
    computerToolNameFromProviderPermission(input.permission) !== undefined
  );
}
