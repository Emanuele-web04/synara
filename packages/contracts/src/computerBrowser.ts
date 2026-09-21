import { Schema } from "effect";

/**
 * Contract surface for the cua-driver browser tool family — the CDP route
 * exposed as `computer_browser_*` on the agent gateway. These are NOT the
 * integrated `browser_*` automation tools (see `browserAutomation*`): the
 * integrated surface owns a Synara-managed browser home, while this family
 * dispatches through the desktop driver's CDP engine, which is the only route
 * that reaches browsers the driver launched or an approved existing profile.
 *
 * The driver is authoritative for opaque capabilities: `target_id` is minted
 * by `get_browser_state`, `tab_id` and page refs are scoped to that session,
 * and refs die on navigation. Nothing here may interpret a browser target as
 * a desktop window id, and nothing here may trust a caller-provided session,
 * transport, or ownership field — the host injects those.
 */

/** Gateway names in registration order; each maps to exactly one driver tool. */
export const COMPUTER_BROWSER_TOOL_NAMES = [
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

export type ComputerBrowserToolName = (typeof COMPUTER_BROWSER_TOOL_NAMES)[number];

/**
 * The pinned driver's closed refusal vocabulary, mirrored for consumers that
 * branch on `structuredContent.refusal.code`. Additive-only upstream; a code
 * outside this set must still surface verbatim, never be coerced into another
 * code or dropped.
 */
export const COMPUTER_BROWSER_REFUSAL_CODES = [
  "browser_route_unavailable",
  "browser_requires_setup",
  "browser_binding_ambiguous",
  "browser_binding_stale",
  "browser_wrong_target_refused",
  "browser_tab_required",
  "browser_tab_not_found",
  "browser_ref_stale",
  "browser_input_trust_unavailable",
  "browser_endpoint_owner_mismatch",
  "browser_consent_required",
  "browser_consent_revoked",
  "browser_reconnect_exhausted",
  "browser_input_incomplete",
  "browser_action_unavailable",
  "browser_origin_outside_scope",
] as const;

export type ComputerBrowserRefusalCode = (typeof COMPUTER_BROWSER_REFUSAL_CODES)[number];

export const ComputerBrowserRefusal = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  detail: Schema.optional(Schema.Unknown),
});
export type ComputerBrowserRefusal = typeof ComputerBrowserRefusal.Type;

/**
 * What a `status:"refused"` call looks like inside `structuredContent`. The
 * driver keeps `isError` unset for deliberate refusals — the refusal IS the
 * result — so gateways must branch on `structuredContent.status`, not on
 * protocol error plumbing.
 */
export const ComputerBrowserRefusedContent = Schema.Struct({
  status: Schema.Literal("refused"),
  refusal: ComputerBrowserRefusal,
});
export type ComputerBrowserRefusedContent = typeof ComputerBrowserRefusedContent.Type;

/**
 * `structuredContent.status` values the pinned driver emits across the
 * browser family. `completed` marks terminal successes whose payload shape is
 * per-tool; tools may also emit other success markers, so treat the set as
 * open — the only status a consumer may assume is `refused`.
 */
export const ComputerBrowserResultStatus = Schema.String;

/**
 * The driver returns browser state (`get_browser_state`) as structured
 * content containing at least a minted `target_id` and a `tabs` inventory.
 * Everything beyond that is engine-version data: this schema declares the
 * fields Synara itself reads and leaves the rest opaque.
 */
export const ComputerBrowserTabInfo = Schema.Struct({
  tab_id: Schema.String,
});
export type ComputerBrowserTabInfo = typeof ComputerBrowserTabInfo.Type;

export const ComputerBrowserState = Schema.Struct({
  target_id: Schema.String,
  tabs: Schema.Array(ComputerBrowserTabInfo),
});
export type ComputerBrowserState = typeof ComputerBrowserState.Type;

/** Tool-name → driver-name mapping. Kept next to the names it constrains. */
export const COMPUTER_BROWSER_DRIVER_NAMES: Record<ComputerBrowserToolName, string> = {
  computer_browser_state: "get_browser_state",
  computer_browser_prepare: "browser_prepare",
  computer_browser_navigate: "browser_navigate",
  computer_browser_click: "browser_click",
  computer_browser_type: "browser_type",
  computer_browser_dialog: "browser_dialog",
  computer_browser_upload: "browser_set_input_files",
  computer_browser_download: "browser_download",
  computer_browser_pointer: "browser_pointer",
  computer_browser_press: "browser_type",
};
