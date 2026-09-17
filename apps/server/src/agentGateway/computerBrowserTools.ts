/**
 * Agent-facing tools for the cua-driver CDP browser surface, exposed as
 * `computer_browser_*`.
 *
 * These are deliberately separate from the integrated `browser_*` family:
 * the integrated surface drives a Synara-owned browser through its own host,
 * while this surface dispatches through the desktop driver's CDP engine —
 * the only route that reaches a driver-launched isolated Chromium or an
 * approved existing profile, and the only input route that works on a
 * background Chromium renderer (OS-level events do not reach inactive
 * renderers; Input.dispatchMouseEvent does).
 *
 * Boundary rules this file owns:
 * - `session`, `_session_id`, `_transport_session_id`, and every other
 *   lifecycle field are injected by the host, never taken from model input.
 *   The schemas below simply do not name them.
 * - `target_id`/`tab_id`/refs are opaque session-scoped capabilities; they are
 *   forwarded verbatim and never interpreted as desktop window ids.
 * - Deliberate driver refusals (`structuredContent.status === "refused"`)
 *   are RESULTS, not errors: the model is expected to branch on the refusal
 *   code (for example `browser_requires_setup` → call computer_browser_prepare).
 * - Upload and download paths are canonicalized and must resolve inside the
 *   caller thread's workspace — the driver checks canonicality; the workspace
 *   boundary is Synara's own filesystem policy on top of that.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { Effect } from "effect";

import type { ComputerBrowserToolName } from "@synara/contracts";
import { COMPUTER_BROWSER_DRIVER_NAMES } from "@synara/contracts";

import {
  ComputerBackendError,
  type ComputerBrowserCallResult,
} from "../computer/ComputerBackend.ts";
import { CuaActionError } from "../computer/CuaComputerBackend.ts";
import type { ComputerManager } from "../computer/ComputerManager.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import { mcpToolResultError, type McpToolCallResult } from "./protocol.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";
import { COMPUTER_CONTROL_CAPABILITY } from "./computerTools.ts";

export interface AgentGatewayComputerBrowserToolsOptions {
  readonly manager: ComputerManager;
  /**
   * Same gate the desktop tools use: approval-required sessions prompt per
   * call (task-scoped consent where the gate allows), full-access sessions
   * run without prompting. Absent means no approval can be collected, so
   * every mutating call is refused before dispatch.
   */
  readonly authorizeAction?: (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal: AbortSignal,
  ) => Promise<boolean>;
  /**
   * The caller thread's canonical workspace root, for bounding upload and
   * download paths. Absent or unresolved means the file-transfer tools refuse
   * rather than guess a boundary.
   */
  readonly resolveWorkspaceRoot?: (context: ToolContext) => Effect.Effect<string | null>;
}

/**
 * Reads pass without approval; everything else goes through the gate.
 * `computer_browser_dialog` is read-only only for `action: "inspect"` —
 * accept/dismiss are consequential actions the driver itself classifies R3.
 */
export function computerBrowserToolRequiresApproval(
  name: string,
  args: Record<string, unknown>,
): boolean {
  if (name === "computer_browser_state") return false;
  if (name === "computer_browser_dialog" && args.action === "inspect") return false;
  return true;
}

const TARGET_ID_PROPERTY = {
  type: "string",
  description:
    "Opaque browser target id minted by computer_browser_state. Not a desktop window id.",
} as const;
const TAB_ID_PROPERTY = {
  type: "string",
  description: "Opaque tab id reported by computer_browser_state for the bound target.",
} as const;
const REF_PROPERTY = {
  type: "string",
  description:
    "Page element ref from a computer_browser_state snapshot. Refs die on navigation or a newer snapshot of the same tab.",
} as const;

function approvalUnavailableResult(name: string): McpToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "ComputerApprovalRequired",
            message: `${name} requires explicit user approval, and this provider session has no approval gate. The action was refused before it ran.`,
          },
        }),
      },
    ],
    isError: true,
  };
}

/**
 * The driver's MCP-shaped reply, narrowed onto the MCP content union. Unknown
 * part types are dropped rather than coerced; a call that returned no usable
 * part still surfaces its structured payload as text so the refusal/result is
 * never silently empty.
 */
function browserResultToMcp(result: ComputerBrowserCallResult): McpToolCallResult {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];
  for (const part of result.content ?? []) {
    if (part.type === "text" && typeof part.text === "string")
      content.push({ type: "text", text: part.text });
    else if (
      part.type === "image" &&
      typeof part.data === "string" &&
      typeof part.mimeType === "string"
    )
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
  }
  const structuredContent =
    result.structuredContent && typeof result.structuredContent === "object"
      ? (result.structuredContent as Record<string, unknown>)
      : undefined;
  return {
    content:
      content.length > 0
        ? content
        : [{ type: "text", text: JSON.stringify(structuredContent ?? { status: "ok" }) }],
    ...(result.isError === true ? { isError: true } : {}),
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

/**
 * Canonicalize one model-supplied filesystem path and prove it resolves inside
 * the workspace. The canonical path is what gets dispatched — a symlink
 * cannot widen the approved set, and the driver's own canonicality check
 * then passes by construction.
 */
async function boundedWorkspacePath(
  raw: unknown,
  workspaceRoot: string,
  field: string,
): Promise<string> {
  if (typeof raw !== "string" || raw.length === 0 || !isAbsolute(raw))
    throw new ToolInputError(`"${field}" must be an absolute path.`);
  const canonical = await realpath(raw).catch(() => {
    throw new ToolInputError(`"${field}" does not resolve to an existing path.`);
  });
  if (canonical !== workspaceRoot && !canonical.startsWith(workspaceRoot + sep))
    throw new ToolInputError(`"${field}" resolves outside the active workspace.`);
  return canonical;
}

/**
 * Upload and download are the only browser tools that touch the caller's
 * filesystem. Every path the driver will touch is canonicalized and
 * containment-checked against the thread's workspace root before dispatch —
 * matching the boundary browser_upload already enforces on the integrated
 * surface.
 */
async function boundBrowserPaths(
  name: ComputerBrowserToolName,
  args: Record<string, unknown>,
  context: ToolContext,
  signal: AbortSignal,
  resolveWorkspaceRoot: AgentGatewayComputerBrowserToolsOptions["resolveWorkspaceRoot"],
): Promise<Record<string, unknown>> {
  if (name !== "computer_browser_upload" && name !== "computer_browser_download") return args;
  const root = resolveWorkspaceRoot
    ? await Effect.runPromise(resolveWorkspaceRoot(context), { signal })
    : null;
  if (!root?.trim())
    throw new ToolInputError(
      "No canonical workspace is available for browser file transfer; the call was refused before it ran.",
    );
  const workspaceRoot = await realpath(root);
  if (name === "computer_browser_upload") {
    const files = args.files;
    if (!Array.isArray(files) || files.length === 0 || files.length > 32)
      throw new ToolInputError('"files" must be an array of 1-32 absolute paths.');
    return {
      ...args,
      files: await Promise.all(
        files.map((file) => boundedWorkspacePath(file, workspaceRoot, "files")),
      ),
    };
  }
  return {
    ...args,
    destination_root: await boundedWorkspacePath(
      args.destination_root,
      workspaceRoot,
      "destination_root",
    ),
  };
}

export function makeAgentGatewayComputerBrowserTools(
  options: AgentGatewayComputerBrowserToolsOptions,
): ReadonlyArray<ToolEntry> {
  const { manager } = options;

  const handle =
    (name: ComputerBrowserToolName) => (args: Record<string, unknown>, context: ToolContext) =>
      Effect.tryPromise({
        try: async (abortSignal) => {
          if (computerBrowserToolRequiresApproval(name, args)) {
            if (!options.authorizeAction) return approvalUnavailableResult(name);
            const approved = await options.authorizeAction(name, args, context, abortSignal);
            if (!approved)
              return mcpToolResultError(
                "Computer browser action was denied or cancelled; no input was sent.",
              );
          }
          await Effect.runPromise(context.assertCallerTurnActive(), { signal: abortSignal });
          abortSignal.throwIfAborted();
          const boundedArgs = await boundBrowserPaths(
            name,
            args,
            context,
            abortSignal,
            options.resolveWorkspaceRoot,
          );
          const result = await manager.browserCall(
            context.callerThreadId,
            context.callerTurnId ?? undefined,
            COMPUTER_BROWSER_DRIVER_NAMES[name],
            boundedArgs,
            abortSignal,
          );
          return browserResultToMcp(result);
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          const failure =
            error instanceof CuaActionError
              ? {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        error: error.code,
                        effect: error.effect,
                        message: error.message,
                        retryAllowed: false,
                      }),
                    },
                  ],
                  isError: true as const,
                }
              : error instanceof ComputerBackendError || error instanceof ToolInputError
                ? mcpToolResultError(error.message)
                : mcpToolResultError(errorText(error));
          return Effect.succeed(failure);
        }),
      );

  const entry = (
    name: ComputerBrowserToolName,
    title: string,
    description: string,
    inputSchema: Record<string, unknown>,
    annotations: Record<string, unknown> = WRITE_TOOL_ANNOTATIONS,
  ): ToolEntry => ({
    requiredCapability: COMPUTER_CONTROL_CAPABILITY,
    requiresActiveTurn: true,
    definition: { name, description, inputSchema, annotations: { title, ...annotations } },
    handler: handle(name),
  });

  return [
    entry(
      "computer_browser_state",
      "Read browser state",
      `Observe or bind a browser through the desktop driver's CDP route. Two modes: pass pid + window_id of a prepared browser to bind it (after computer_browser_prepare), or pass the target_id + tab_id it minted to snapshot one tab — a semantic outline, element refs, and optionally a viewport screenshot (include_screenshot). Element refs stay valid until that tab navigates or a newer snapshot supersedes them. This is NOT the integrated browser_* surface: use it when the browser was launched or attached through the driver.`,
      {
        type: "object",
        properties: {
          pid: {
            type: "integer",
            description:
              "Browser process id to bind (from computer_list_windows / prepare result).",
          },
          window_id: {
            type: "integer",
            description: "Native window id owned by pid — required with pid for bind mode.",
          },
          target_id: TARGET_ID_PROPERTY,
          tab_id: TAB_ID_PROPERTY,
          snapshot_format: {
            type: "string",
            enum: ["dom_refs_v1", "semantic_v2"],
            description: "Snapshot contract version; semantic_v2 is the richer outline.",
          },
          scope_ref: {
            type: "string",
            description: "Limit the observation to this ref's subtree.",
          },
          query: {
            type: "string",
            description: "Read-only match over role, accessible name, and visible text.",
          },
          continuation: {
            type: "string",
            description: "Opaque continuation minted by an earlier semantic_v2 response.",
          },
          include_screenshot: {
            type: "boolean",
            description: "Capture the tab viewport as PNG through CDP.",
          },
        },
        additionalProperties: false,
      },
      READ_ONLY_TOOL_ANNOTATIONS,
    ),
    entry(
      "computer_browser_prepare",
      "Prepare browser",
      `Prepare a driver-owned isolated Chromium for CDP control (profile.mode "isolated_new" or "isolated_named" with allow_launch true), or detect an existing debug endpoint on pid (+ window_id). Returns the endpoint's prepared_pid for binding via computer_browser_state. Attaching to an existing user profile (strategy existing_profile) requires a consent grant this embedding does not host and is refused by the driver with browser_consent_required.`,
      {
        type: "object",
        properties: {
          pid: { type: "integer", description: "Browser process id to prepare or detect." },
          window_id: {
            type: "integer",
            description: "Native window id owned by pid.",
          },
          allow_launch: {
            type: "boolean",
            description: "Permit launching a separate driver-owned isolated Chromium.",
          },
          profile: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["isolated_new", "isolated_named"] },
              name: {
                type: "string",
                description: "Required for isolated_named; 1-64 path-safe ASCII characters.",
              },
            },
            required: ["mode"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    ),
    entry(
      "computer_browser_navigate",
      "Navigate browser tab",
      "Navigate one tab of a bound browser target to a new URL (http, https, or about only). Invalidates every element ref for the tab — take a fresh computer_browser_state snapshot before interacting again.",
      {
        type: "object",
        properties: {
          target_id: TARGET_ID_PROPERTY,
          tab_id: TAB_ID_PROPERTY,
          url: { type: "string", description: "Destination URL (http:, https:, or about:)." },
        },
        required: ["target_id", "tab_id", "url"],
        additionalProperties: false,
      },
    ),
    entry(
      "computer_browser_click",
      "Click in browser tab",
      `Click a page element by ref, or viewport coordinates (x/y in CSS px), inside a bound tab. The default "trusted" route uses CDP input and works on a background renderer; "dom_event" synthesizes a DOM click and proves only dispatch — verify the postcondition with a fresh snapshot.`,
      {
        type: "object",
        properties: {
          target_id: TARGET_ID_PROPERTY,
          tab_id: TAB_ID_PROPERTY,
          ref: REF_PROPERTY,
          x: { type: "number", description: "Viewport x in CSS px — alternative to ref." },
          y: { type: "number", description: "Viewport y in CSS px — alternative to ref." },
          input_route: { type: "string", enum: ["trusted", "dom_event"] },
        },
        required: ["target_id", "tab_id"],
        additionalProperties: false,
      },
    ),
    entry(
      "computer_browser_type",
      "Type into browser field",
      `Type text into an element by ref inside a bound tab. "insert_text" (default) is a bulk insert; "keystrokes" sends per-character key events. Set replace true to select the field's whole content first — with empty text this clears it.`,
      {
        type: "object",
        properties: {
          target_id: TARGET_ID_PROPERTY,
          tab_id: TAB_ID_PROPERTY,
          ref: REF_PROPERTY,
          text: { type: "string", description: "Text to type." },
          mode: { type: "string", enum: ["insert_text", "keystrokes"] },
          replace: {
            type: "boolean",
            description: "Select existing field content first so text replaces it.",
          },
        },
        required: ["target_id", "tab_id", "ref", "text"],
        additionalProperties: false,
      },
    ),
    entry(
      "computer_browser_dialog",
      "Handle browser dialog",
      `Inspect, accept, or dismiss a JavaScript dialog in a bound tab. action "inspect" is read-only and returns the current dialog plus an opaque dialog_id. "accept"/"dismiss" resolve it; prompt_text supplies a prompt's response text. Consequential actions require approval.`,
      {
        type: "object",
        properties: {
          target_id: TARGET_ID_PROPERTY,
          tab_id: TAB_ID_PROPERTY,
          action: { type: "string", enum: ["inspect", "accept", "dismiss"] },
          dialog_id: {
            type: "string",
            description: "Opaque dialog generation returned by action=inspect.",
          },
          prompt_text: {
            type: "string",
            description: "Response text, valid only when accepting a prompt dialog.",
          },
        },
        required: ["target_id", "tab_id", "action"],
        additionalProperties: false,
      },
    ),
    entry(
      "computer_browser_upload",
      "Set file input files",
      `Attach files to a file-upload element (ref) in a bound tab. Every path must be absolute and resolve inside the active workspace — paths are canonicalized before dispatch, and anything resolving outside the workspace is refused before it runs.`,
      {
        type: "object",
        properties: {
          target_id: TARGET_ID_PROPERTY,
          tab_id: TAB_ID_PROPERTY,
          ref: {
            ...REF_PROPERTY,
            description: "Page ref of the file-upload control. " + REF_PROPERTY.description,
          },
          files: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: {
              type: "string",
              description: "Absolute path to one workspace file.",
            },
          },
        },
        required: ["target_id", "tab_id", "ref", "files"],
        additionalProperties: false,
      },
    ),
    entry(
      "computer_browser_download",
      "Download via browser",
      `Trigger one download by activating a live ref, saved inside destination_root. The directory must be absolute and resolve inside the active workspace. Requires approval; the result never echoes the source URL, filename, or destination path back.`,
      {
        type: "object",
        properties: {
          target_id: TARGET_ID_PROPERTY,
          tab_id: TAB_ID_PROPERTY,
          ref: REF_PROPERTY,
          destination_root: {
            type: "string",
            description: "Absolute directory inside the workspace to receive the download.",
          },
        },
        required: ["target_id", "tab_id", "ref", "destination_root"],
        additionalProperties: false,
      },
    ),
    entry(
      "computer_browser_pointer",
      "Browser pointer action",
      `Hover, right-click, double-click, scroll, or drag inside a bound tab. Point at an element by ref or at viewport coordinates (x/y in CSS px); drags take destination_ref or to_x/to_y, scrolls take delta_x/delta_y. Semantic refs must declare the matching pointer capability. Never activates or raises the tab.`,
      {
        type: "object",
        properties: {
          target_id: TARGET_ID_PROPERTY,
          tab_id: TAB_ID_PROPERTY,
          action: {
            type: "string",
            enum: ["hover", "right_click", "double_click", "scroll", "drag"],
          },
          ref: REF_PROPERTY,
          x: { type: "number", description: "Origin viewport x in CSS px." },
          y: { type: "number", description: "Origin viewport y in CSS px." },
          destination_ref: {
            type: "string",
            description: "Drag destination page ref in the same frame.",
          },
          to_x: { type: "number", description: "Drag destination viewport x in CSS px." },
          to_y: { type: "number", description: "Drag destination viewport y in CSS px." },
          delta_x: { type: "number", description: "Horizontal scroll delta in CSS px." },
          delta_y: { type: "number", description: "Vertical scroll delta in CSS px." },
          input_route: { type: "string", enum: ["trusted", "dom_event"] },
        },
        required: ["target_id", "tab_id", "action"],
        additionalProperties: false,
      },
    ),
  ];
}
