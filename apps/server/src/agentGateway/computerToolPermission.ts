import type { ProviderInteractionMode, RuntimeMode } from "@synara/contracts";

/** Exact tool names owned by Synara's capability-gated Computer gateway. */
export const SYNARA_COMPUTER_TOOL_NAMES = [
  "computer_activate_window",
  "computer_click",
  "computer_drag",
  "computer_get_accessibility_tree",
  "computer_get_cursor_position",
  "computer_get_screen_size",
  "computer_get_state",
  "computer_help",
  "computer_inspect",
  "computer_spaces",
  "computer_invoke_menu",
  "computer_kill_app",
  "computer_launch_app",
  "computer_list_apps",
  "computer_list_windows",
  "computer_move_cursor",
  "computer_paste",
  "computer_perform_action",
  "computer_press_key",
  "computer_read_clipboard",
  "computer_run",
  "computer_screenshot",
  "computer_scroll",
  "computer_select_text",
  "computer_set_app_visibility",
  "computer_set_value",
  "computer_set_window_frame",
  "computer_set_window_minimized",
  "computer_type_text",
  "computer_verify_state",
  "computer_wait",
  "computer_write_clipboard",
  "computer_zoom",
  // The cua-driver CDP browser family. Deliberately inside the Computer
  // namespace: these are the same capability (computer:control), the same
  // approval gate, and the same denial-card path as the desktop tools — they
  // merely dispatch over CDP rather than OS events. They must never collide
  // with the integrated `browser_*` surface, which is a different host.
  "computer_browser_state",
  "computer_browser_prepare",
  "computer_browser_navigate",
  "computer_browser_click",
  "computer_browser_type",
  "computer_browser_dialog",
  "computer_browser_upload",
  "computer_browser_download",
  "computer_browser_pointer",
  "computer_browser_press",
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
 * Namespace-insensitive matcher for Computer calls at the gateway boundary.
 *
 * A session that was never granted computer control must still surface the
 * denial card path when the model reaches for a Computer tool, or the attempt
 * dies as a silent tool error and the user never learns control is off.
 *
 * Gateway transport (all MCP providers): `makeAgentGatewayMcpTransport`
 * (`apps/server/src/agentGateway/mcpTransport.ts`) denies an unknown tool
 * name with `capability_denied` plus the denial hook only when
 * `isComputerToolName` matches. Wired in
 * `apps/server/src/agentGateway/Layers/AgentGateway.ts` as the catalog
 * membership test OR this family matcher, so a prefixed spelling from a
 * session that never saw the catalog —
 * `synara_computer_click`, `mcp__synara__computer_click` — still reaches
 * the denial hook and the card.
 *
 * Pi's native projection adds specialist forwarders only when its leased
 * catalog advertises Computer control. Disabled sessions carry no Computer
 * fallback schemas; stale calls reaching this boundary still receive the same
 * capability denial as other MCP clients.
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
 * Any tool Synara's agent gateway serves under its reserved MCP server name —
 * the whole `synara_*` catalog (thread, project, automation, diagnostics,
 * computer). The session token is what authorizes each call server-side, so
 * providers that were granted the gateway may let these names skip their own
 * interactive permission prompt when the start input opts in
 * (`ProviderSessionStartInput.autoApproveSynaraTools`).
 *
 * Name matching accepts both spellings the provider can report: the fully
 * qualified `mcp__synara__*` name and the bare `synara_*` name (the gateway's
 * catalog names are already namespaced). Other MCP servers' tools keep the
 * ordinary permission path.
 */
export function isSynaraGatewayToolName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("mcp__synara__") || normalized.startsWith("synara_");
}

/**
 * Namespace-insensitive matcher across the fields a provider permission
 * prompt may report a tool name through — the direct name, or a tool-name
 * field nested in raw input / metadata the way some adapters deliver MCP
 * calls.
 */
export function isSynaraGatewayToolCall(input: {
  readonly name?: unknown;
  readonly title?: unknown;
  readonly rawInput?: unknown;
  readonly metadata?: unknown;
}): boolean {
  const explicitName = typeof input.name === "string" ? input.name : undefined;
  if (explicitName !== undefined) return isSynaraGatewayToolName(explicitName);

  const rawToolName = firstRecordString(input.rawInput, ["_toolName", "toolName", "tool_name"]);
  if (rawToolName !== undefined) return isSynaraGatewayToolName(rawToolName);

  const metadataToolName = firstRecordString(input.metadata, [
    "_toolName",
    "toolName",
    "tool_name",
  ]);
  if (metadataToolName !== undefined) return isSynaraGatewayToolName(metadataToolName);

  return isSynaraGatewayToolName(input.title);
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
