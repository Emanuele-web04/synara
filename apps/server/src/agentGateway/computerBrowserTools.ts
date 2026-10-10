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
 *   forwarded verbatim and never interpreted as desktop window ids. They are
 *   also distinct from each other: results label both, and an omitted `tab_id`
 *   resolves from the target's remembered bind only when unambiguous.
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
import { withModelDesktopObservation } from "../computer/modelDesktopObservation.ts";
import {
  COMPUTER_FOREGROUND_NOT_AUTHORIZED,
  COMPUTER_FOREGROUND_NOT_REQUESTED_CODE,
  type ComputerForegroundAuthorization,
} from "../computer/computerVisibleUse.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import { mcpToolResultError, type McpToolCallResult } from "./protocol.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";
import {
  COMPUTER_CONTROL_CAPABILITY,
  computerApprovalRequiredError,
  computerAuditErrorOutcome,
  cuaActionErrorPayload,
  type AgentGatewayComputerToolsOptions,
} from "./computerTools.ts";
import {
  computerAuditGatewayRequestId,
  summarizeComputerAuditArgs,
  type ComputerAuditEffect,
} from "../computer/computerAuditLog.ts";
import { computerBrowserEffect, computerBrowserFieldReadback } from "./computerBrowserEffect.ts";

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
  /** Visible browser launches need the same user-authored request as native raises. */
  readonly resolveForegroundAuthorization?: (
    context: ToolContext,
  ) => Promise<ComputerForegroundAuthorization>;
  /** Same visible-use approval card the desktop tools show; see computerTools. */
  readonly requestForegroundConsent?: AgentGatewayComputerToolsOptions["requestForegroundConsent"];
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
    "Opaque browser target id minted by computer_browser_state (bt-…). It names the bound browser — never a tab; each tab carries its own tab_id. Not a desktop window id.",
} as const;
const TAB_ID_PROPERTY = {
  type: "string",
  description:
    "Opaque tab id from the bind result's tabs[].tab_id (tab-…). May be omitted when the target has exactly one tab, or one active tab — the gateway resolves it. Never pass target_id here.",
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
        text: JSON.stringify({ error: computerApprovalRequiredError(name) }),
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

/**
 * What one successful bind/snapshot told this server about a target's tabs.
 * Target ids are opaque and per-session, so entries are scoped to the caller
 * thread and capped — a long-lived server must not grow this without bound.
 */
interface BrowserTabRecord {
  readonly tab_id: string;
  readonly active?: boolean;
  readonly title?: string;
  readonly url?: string;
}

/** The tab an omitted `tab_id` resolves to: the only one, or the only active one. */
function resolvableTab(tabs: readonly BrowserTabRecord[]): BrowserTabRecord | undefined {
  if (tabs.length === 1) return tabs[0];
  const active = tabs.filter((tab) => tab.active === true);
  return active.length === 1 ? active[0] : undefined;
}

const MAX_LISTED_TABS = 10;
const MAX_REMEMBERED_TABS = 100;
const KNOWN_TARGETS_PER_THREAD = 4;
const KNOWN_THREADS_MAX = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function browserTabsFrom(
  structured: Record<string, unknown> | undefined,
): readonly BrowserTabRecord[] {
  const tabs = structured?.tabs;
  if (!Array.isArray(tabs)) return [];
  return tabs
    .flatMap((entry): BrowserTabRecord[] => {
      if (!isRecord(entry) || typeof entry.tab_id !== "string" || entry.tab_id.length === 0)
        return [];
      return [
        {
          tab_id: entry.tab_id,
          ...(typeof entry.active === "boolean" ? { active: entry.active } : {}),
          ...(typeof entry.title === "string" ? { title: entry.title } : {}),
          ...(typeof entry.url === "string" ? { url: entry.url } : {}),
        },
      ];
    })
    .slice(0, MAX_REMEMBERED_TABS);
}

function describeTabs(tabs: readonly BrowserTabRecord[]): string {
  const listed = tabs.slice(0, MAX_LISTED_TABS);
  const parts = listed.map((tab) => `"${tab.tab_id}"${tab.active === true ? " (active)" : ""}`);
  const remaining = tabs.length - listed.length;
  return `${parts.join(", ")}${remaining > 0 ? ` and ${remaining} more` : ""}`;
}

function withAppendedText(
  result: ComputerBrowserCallResult,
  line: string,
): ComputerBrowserCallResult {
  const content = [...(result.content ?? [])];
  const index = content.findIndex((part) => part.type === "text" && typeof part.text === "string");
  if (index === -1) return { ...result, content: [...content, { type: "text", text: line }] };
  const part = content[index]!;
  content[index] = { ...part, text: `${String(part.text)}\n${line}` };
  return { ...result, content };
}

function browserRefusalResult(refusal: {
  readonly code: string;
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}): McpToolCallResult {
  return {
    content: [{ type: "text", text: `refused (${refusal.code}): ${refusal.message}` }],
    structuredContent: {
      status: "refused",
      refusal: {
        code: refusal.code,
        message: refusal.message,
        ...(refusal.detail !== undefined ? { detail: refusal.detail } : {}),
      },
    },
  };
}

const EXISTING_PROFILE_UNAVAILABLE =
  'This Computer route cannot attach to your existing browser profile. If a separate browser without your cookies satisfies the task, call computer_browser_prepare({allow_launch:true,profile:{mode:"isolated_new"}}). Use isolated_named with a task-specific name if the profile must survive browser restarts. Do not substitute it when the task requires your existing profile.';

/**
 * The observed packaged E2E passed the bind's target id in the `tab_id` slot
 * ("tab bt-85991064… is not known for target bt-85991064…"), then burned calls
 * on the confusion. The driver refusal is truthful but terse; when the value
 * is provably the target id itself, say which id is which.
 */
function augmentBrowserResult(
  name: ComputerBrowserToolName,
  args: Record<string, unknown>,
  result: ComputerBrowserCallResult,
): ComputerBrowserCallResult {
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  if (structured === undefined) return result;
  if (computerBrowserFieldReadback(name, args, result)) {
    return {
      ...result,
      content: [
        {
          type: "text",
          text: "Field value matched; application effect unverified. Observe once; do not repeat the input automatically.",
        },
        ...(result.content ?? []).filter((part) => part.type !== "text"),
      ],
    };
  }
  const structuredRecord = structured as Record<string, unknown>;
  if (structuredRecord.status === "refused" && isRecord(structuredRecord.refusal)) {
    const refusal = structuredRecord.refusal;
    const code = typeof refusal.code === "string" ? refusal.code : "browser_refused";
    if (name === "computer_browser_prepare" && code === "browser_consent_required") {
      return {
        ...result,
        content: [{ type: "text", text: `refused (${code}): ${EXISTING_PROFILE_UNAVAILABLE}` }],
        structuredContent: {
          ...structuredRecord,
          refusal: { ...refusal, message: EXISTING_PROFILE_UNAVAILABLE },
        },
      };
    }
    if (
      name === "computer_browser_state" &&
      code === "browser_wrong_target_refused" &&
      args.pid !== undefined &&
      args.window_id === undefined
    ) {
      const message =
        "A pid-only bind is for a live driver-owned headless browser. An existing desktop browser " +
        "needs a native-window bind with computer_browser_state({pid,window_id}) and a verified CDP endpoint. " +
        "Only a successful bind returns target_id for computer_browser_navigate and other browser actions. " +
        "If that bind is unavailable, use the exact desktop window through computer_get_state and native " +
        "Computer actions; do not send pid/window_id to browser actions or silently replace the user's profile.";
      return {
        ...result,
        content: [{ type: "text", text: `refused (${code}): ${message}` }],
        structuredContent: {
          ...structuredRecord,
          refusal: { ...refusal, message },
        },
      };
    }
    const tabId = typeof args.tab_id === "string" ? args.tab_id : undefined;
    const targetId = typeof args.target_id === "string" ? args.target_id : undefined;
    const swapped =
      code === "browser_tab_not_found" &&
      tabId !== undefined &&
      (tabId === targetId || tabId.startsWith("bt-"));
    if (swapped) {
      const message =
        `tab_id "${tabId}" is a target id, not a tab id, so it names no tab of target ` +
        `${targetId === undefined ? "that call" : `"${targetId}"`}. target_id identifies the bound browser; ` +
        `each tab carries its own tab_id (tab-…) in the bind result's tabs list. Pass that tab_id here.`;
      return {
        ...result,
        content: [{ type: "text", text: `refused (${code}): ${message}` }],
        structuredContent: {
          ...structuredRecord,
          refusal: { ...refusal, code, message },
        },
      };
    }
    return result;
  }
  const targetId =
    typeof structuredRecord.target_id === "string" ? structuredRecord.target_id : undefined;
  if (targetId === undefined) {
    // Prepare results mint no target yet; label the bind key so the next call
    // cannot mistake the pid for a target or tab id.
    const preparedPid =
      typeof structuredRecord.prepared_pid === "number" ? structuredRecord.prepared_pid : undefined;
    if (name !== "computer_browser_prepare" || preparedPid === undefined) return result;
    return withAppendedText(
      result,
      `ids: prepared_pid=${preparedPid} (a bind key, not a target or tab id); next: computer_browser_state {pid: ${preparedPid}} — a driver-owned headless bind takes pid alone (window_id only for a native browser window); the bind result names target_id and each tab's tab_id.`,
    );
  }
  const tabs = browserTabsFrom(structuredRecord);
  const tabRecord =
    typeof structuredRecord.tab_id === "string"
      ? structuredRecord.tab_id
      : resolvableTab(tabs)?.tab_id;
  const nextStructured: Record<string, unknown> = {
    ...structuredRecord,
    ...(tabRecord !== undefined && typeof structuredRecord.tab_id !== "string"
      ? { tab_id: tabRecord }
      : {}),
  };
  const line =
    tabRecord !== undefined
      ? `ids: target_id=${targetId}; tab_id=${tabRecord}${tabRecord === resolvableTab(tabs)?.tab_id ? " (active)" : ""}`
      : tabs.length > 0
        ? `ids: target_id=${targetId}; tabs: ${describeTabs(tabs)}`
        : `ids: target_id=${targetId}`;
  return { ...withAppendedText(result, line), structuredContent: nextStructured };
}

export function makeAgentGatewayComputerBrowserTools(
  options: AgentGatewayComputerBrowserToolsOptions,
): ReadonlyArray<ToolEntry> {
  const { manager } = options;

  const assertVisibleBrowserAllowed = async (
    context: ToolContext,
    consent?: { readonly args: Record<string, unknown>; readonly signal: AbortSignal },
  ): Promise<void> => {
    const authorization = await Promise.resolve()
      .then(() => options.resolveForegroundAuthorization?.(context))
      .catch(() => COMPUTER_FOREGROUND_NOT_AUTHORIZED);
    if (
      authorization?.userRequestedVisibleUse !== true &&
      !(
        consent !== undefined &&
        options.requestForegroundConsent !== undefined &&
        (await options.requestForegroundConsent(
          "computer_browser_prepare",
          consent.args,
          context,
          consent.signal,
        ))
      )
    ) {
      throw new CuaActionError(
        "Showing a browser window was not allowed for this task (declined, cancelled or " +
          "unanswered). Keep windowed false to work in the background, and do not ask " +
          "again in this turn.",
        "not-dispatched",
        COMPUTER_FOREGROUND_NOT_REQUESTED_CODE,
      );
    }
  };

  /**
   * Target → tabs, per caller thread. A bind mints a fresh target id every
   * call, so this remembers the newest few per thread and refuses to guess
   * past them. It exists for one reason: the driver mints `target_id` and
   * `tab_id` as opaque capabilities with similar-looking values, and a model
   * forced to carry both by hand conflates them. With the bind result
   * remembered, an omitted `tab_id` resolves locally — no extra driver call,
   * no guessing, and the driver stays authoritative for everything else.
   */
  const knownTargets = new Map<string, Map<string, readonly BrowserTabRecord[]>>();

  const rememberTargetTabs = (
    threadId: string,
    structured: Record<string, unknown> | undefined,
  ): void => {
    const targetId = typeof structured?.target_id === "string" ? structured.target_id : undefined;
    const tabs = browserTabsFrom(structured);
    if (targetId === undefined || tabs.length === 0) return;
    let byTarget = knownTargets.get(threadId);
    if (byTarget === undefined) {
      byTarget = new Map();
      knownTargets.set(threadId, byTarget);
      while (knownTargets.size > KNOWN_THREADS_MAX) {
        knownTargets.delete(knownTargets.keys().next().value!);
      }
    } else {
      knownTargets.delete(threadId);
      knownTargets.set(threadId, byTarget);
    }
    byTarget.delete(targetId);
    byTarget.set(targetId, [...tabs]);
    while (byTarget.size > KNOWN_TARGETS_PER_THREAD) {
      byTarget.delete(byTarget.keys().next().value!);
    }
  };

  /**
   * Fill an omitted `tab_id` from the target's last bind result. Refuses —
   * with the tab listing — when the target is unknown to this thread or its
   * tabs offer no single default. Bind mode (pid/window_id) is left alone.
   */
  const resolveOmittedTabId = (
    threadId: string,
    args: Record<string, unknown>,
  ):
    | { readonly kind: "unchanged" }
    | { readonly kind: "resolved"; readonly args: Record<string, unknown> }
    | {
        readonly kind: "refused";
        readonly refusal: {
          readonly code: string;
          readonly message: string;
          readonly detail?: Record<string, unknown>;
        };
      } => {
    if (typeof args.tab_id === "string" && args.tab_id.length > 0) return { kind: "unchanged" };
    const targetId = typeof args.target_id === "string" ? args.target_id : undefined;
    if (targetId === undefined) return { kind: "unchanged" };
    if (args.pid !== undefined || args.window_id !== undefined) return { kind: "unchanged" };
    const tabs = knownTargets.get(threadId)?.get(targetId) ?? [];
    if (tabs.length === 0) {
      return {
        kind: "refused",
        refusal: {
          code: "browser_tab_required",
          message:
            `no tab_id was given and this thread has no bind result for target "${targetId}" ` +
            `to resolve one from. Bind the browser first with computer_browser_state (pid alone for ` +
            `a driver-owned headless browser; pid + window_id for a native window); ` +
            `its result lists every tab's tab_id.`,
        },
      };
    }
    const tab = resolvableTab(tabs);
    if (tab !== undefined) return { kind: "resolved", args: { ...args, tab_id: tab.tab_id } };
    return {
      kind: "refused",
      refusal: {
        code: "browser_tab_required",
        message:
          `no tab_id was given and target "${targetId}" has ${tabs.length} tabs with no single ` +
          `active tab to default to. Pass the tab_id you want: ${describeTabs(tabs)}.`,
        detail: { tabs },
      },
    };
  };

  const handle =
    (name: ComputerBrowserToolName) => (args: Record<string, unknown>, context: ToolContext) => {
      // The resolved form is what dispatch, approval, and audit all see: an
      // omitted tab_id is never a different call, just a less explicit one.
      let effectiveArgs: Record<string, unknown> = args;
      // Mutating browser calls audit exactly like the desktop family; the
      // read-only state snapshot and the dialog inspect stay out.
      const audited = computerBrowserToolRequiresApproval(name, args);
      const audit = (outcome: {
        readonly effect: ComputerAuditEffect;
        readonly code?: string;
      }): void => {
        if (!audited) return;
        const pid =
          typeof effectiveArgs.pid === "number" &&
          Number.isSafeInteger(effectiveArgs.pid) &&
          effectiveArgs.pid > 0
            ? effectiveArgs.pid
            : undefined;
        const windowId =
          typeof effectiveArgs.window_id === "number" &&
          Number.isSafeInteger(effectiveArgs.window_id)
            ? `cua:${pid ?? 0}:${effectiveArgs.window_id}`
            : typeof effectiveArgs.window_id === "string"
              ? effectiveArgs.window_id
              : undefined;
        manager.recordComputerAudit({
          tool: name,
          ...computerAuditGatewayRequestId(context.jsonRpcRequestId),
          threadId: context.callerThreadId,
          ...(context.callerTurnId ? { turnId: context.callerTurnId } : {}),
          args: summarizeComputerAuditArgs(effectiveArgs),
          ...(pid !== undefined || windowId !== undefined
            ? {
                target: {
                  ...(pid !== undefined ? { pid } : {}),
                  ...(windowId !== undefined ? { windowId } : {}),
                },
              }
            : {}),
          effect: outcome.effect,
          ...(outcome.code !== undefined ? { code: outcome.code } : {}),
        });
      };
      return Effect.tryPromise({
        try: async (abortSignal) => {
          if (name !== "computer_browser_state" && name !== "computer_browser_prepare") {
            const hasTarget = typeof args.target_id === "string" && args.target_id.trim() !== "";
            if (!hasTarget || args.pid !== undefined || args.window_id !== undefined) {
              const refusal = {
                code: "browser_target_required",
                message:
                  "Browser actions require the target_id returned by a successful computer_browser_state " +
                  "bind; pid and native window_id are not browser target capabilities. Bind once using " +
                  "computer_browser_state, then use its target_id and tab_id. If the bind was refused, " +
                  "these actions cannot control that browser: use the exact desktop window and native " +
                  "Computer actions, or report the limitation. No browser was launched or changed.",
              };
              audit({ effect: "refused", code: refusal.code });
              return browserRefusalResult(refusal);
            }
          }
          const resolution = resolveOmittedTabId(context.callerThreadId, args);
          if (resolution.kind === "refused") {
            if (computerBrowserToolRequiresApproval(name, args)) {
              audit({ effect: "refused", code: resolution.refusal.code });
            }
            return browserRefusalResult(resolution.refusal);
          }
          if (resolution.kind === "resolved") effectiveArgs = resolution.args;
          if (name === "computer_browser_press") {
            effectiveArgs = { ...effectiveArgs, mode: "keystrokes", text: "\n" };
          }
          const visibleLaunch =
            name === "computer_browser_prepare" && effectiveArgs.windowed === true;
          // The Linux host refuses every visible launch, so the user is never
          // asked to approve one there.
          const asksForVisibleUse =
            options.requestForegroundConsent !== undefined && manager.agentDialect === "macos";
          // Without a way to ask, refuse before asking the user to approve a
          // call that cannot run.
          if (visibleLaunch && !asksForVisibleUse) await assertVisibleBrowserAllowed(context);
          if (computerBrowserToolRequiresApproval(name, effectiveArgs)) {
            if (!options.authorizeAction) {
              audit({ effect: "refused", code: "approval_unavailable" });
              return approvalUnavailableResult(name);
            }
            const approved = await options.authorizeAction(
              name,
              effectiveArgs,
              context,
              abortSignal,
            );
            if (!approved) {
              audit({ effect: "refused", code: "approval_denied" });
              return mcpToolResultError(
                "Computer browser action was denied or cancelled; no input was sent.",
              );
            }
          }
          // Visible-use consent follows routine approval, as on the desktop tools.
          if (visibleLaunch && asksForVisibleUse)
            await assertVisibleBrowserAllowed(context, {
              args: effectiveArgs,
              signal: abortSignal,
            });
          await Effect.runPromise(context.assertCallerTurnActive(), { signal: abortSignal });
          abortSignal.throwIfAborted();
          const boundedArgs = await boundBrowserPaths(
            name,
            effectiveArgs,
            context,
            abortSignal,
            options.resolveWorkspaceRoot,
          );
          const dispatch = () =>
            manager.browserCall(
              context.callerThreadId,
              context.callerTurnId ?? undefined,
              COMPUTER_BROWSER_DRIVER_NAMES[name],
              boundedArgs,
              abortSignal,
              // Approval and the browser queue can both outlive visible-use
              // intent. Check the shared resolver at actual queue admission.
              visibleLaunch ? () => assertVisibleBrowserAllowed(context) : undefined,
            );
          const result = await (name === "computer_browser_state"
            ? withModelDesktopObservation(dispatch)
            : dispatch());
          // A deliberate driver refusal is a successful call with a refused
          // payload; both halves land in the audit record's effect + code.
          const structured =
            result.structuredContent !== null && typeof result.structuredContent === "object"
              ? (result.structuredContent as Record<string, unknown>)
              : undefined;
          rememberTargetTabs(context.callerThreadId, structured);
          audit(computerBrowserEffect(name, boundedArgs, result));
          return browserResultToMcp(augmentBrowserResult(name, effectiveArgs, result));
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (!(error instanceof ComputerBackendError && error.controlRevoked)) {
            audit(computerAuditErrorOutcome(error));
          }
          const failure =
            error instanceof CuaActionError
              ? {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify(cuaActionErrorPayload(error)),
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
    };

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
      `Observe or bind a browser through the desktop driver's CDP route. Two modes: pass pid to bind a prepared browser — window_id only for a native browser window; a driver-owned browser launched by computer_browser_prepare is headless and binds from pid alone with binding_route "driver_owned_headless" — or pass the target_id + tab_id it minted to snapshot one tab: a semantic outline, element refs, and optionally a viewport screenshot (include_screenshot). The bind result is explicit: target_id names the bound browser; each entry of tabs carries its own tab_id. tab_id may be omitted when the target has one (or one active) tab — the gateway resolves it; an ambiguous target refuses with its tab listing. Element refs stay valid until that tab navigates or a newer snapshot supersedes them. This is NOT the integrated browser_* surface: use it when the browser was launched or attached through the driver.`,
      {
        type: "object",
        properties: {
          pid: {
            type: "integer",
            description:
              "Browser process id to bind: the prepare result's prepared_pid for a driver-owned headless browser, or a native browser window's process.",
          },
          window_id: {
            type: "integer",
            description:
              "Native window id owned by pid — bind mode for a native browser window. Omit it for a driver-owned headless browser (prepared with an isolated profile); the bind is minted from the driver's own CDP endpoint.",
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
      `Prepare driver-owned isolated Chromium (profile.mode "isolated_new" or "isolated_named", allow_launch:true), headless by default. Or detect an existing endpoint with pid (+ window_id), allow_launch:false and no strategy. Linux control requires the verified driver and packaged host's confirmed direct-X11 Escape listener; only owned isolated headless targets support mutation. Wayland/XWayland and standalone hosts permit reads/passive prepare only. Linux refuses visible launch and personal-profile control. On macOS, windowed:true needs the user's request to watch or their approval on the card Synara shows; a decline returns foreground_not_requested. Prefer "isolated_named" to preserve a profile across restarts; "isolated_new" starts empty. Use prepared_pid with computer_browser_state. Existing-profile attachment needs a consent grant this embedding cannot host (browser_consent_required).`,
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
          windowed: {
            type: "boolean",
            description:
              "Default false: isolated headless. Linux requires a verified driver and confirmed direct-X11 Escape listener, and refuses true. On macOS, true opens a window only when the user asks to watch; full access is insufficient.",
          },
          profile: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                enum: ["isolated_new", "isolated_named"],
                description:
                  '"isolated_named" keeps a named profile across browser restarts — recommended for multi-step work such as a cart; "isolated_new" starts from an empty profile every launch.',
              },
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
      "Navigate one tab of a bound browser target to a new URL (http, https, or about only). Pass the bind result's target_id and the tab's own tab_id; tab_id may be omitted when the target has one (or one active) tab. Invalidates every element ref for the tab — take a fresh computer_browser_state snapshot before interacting again.",
      {
        type: "object",
        properties: {
          target_id: TARGET_ID_PROPERTY,
          tab_id: TAB_ID_PROPERTY,
          url: { type: "string", description: "Destination URL (http:, https:, or about:)." },
        },
        required: ["target_id", "url"],
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
        required: ["target_id"],
        additionalProperties: false,
      },
    ),
    entry(
      "computer_browser_type",
      "Type into browser field",
      `Type text into an element by ref inside a bound tab. "insert_text" (default) is a bulk insert; "keystrokes" sends per-character key events. input_route "trusted" (default) uses CDP input; "dom_event" is the background-safe synthetic insertion (insert_text mode only) that cannot raise a standalone browser window — dispatch is read back from the element, so verify the page's own postcondition with a fresh snapshot. Set replace true to select the field's whole content first — with empty text this clears it.`,
      {
        type: "object",
        properties: {
          target_id: TARGET_ID_PROPERTY,
          tab_id: TAB_ID_PROPERTY,
          ref: REF_PROPERTY,
          text: { type: "string", description: "Text to type." },
          mode: { type: "string", enum: ["insert_text", "keystrokes"] },
          input_route: {
            type: "string",
            enum: ["trusted", "dom_event"],
            description:
              '"trusted" (default): CDP Input events. "dom_event": synthetic full-background DOM insertion for input, textarea, and contenteditable refs (insert_text only); dispatch is proven by a live element read-back, not by the application accepting the text — verify with a fresh snapshot.',
          },
          replace: {
            type: "boolean",
            description: "Select existing field content first so text replaces it.",
          },
        },
        required: ["target_id", "ref", "text"],
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
        required: ["target_id", "action"],
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
        required: ["target_id", "ref", "files"],
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
        required: ["target_id", "ref", "destination_root"],
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
        required: ["target_id", "action"],
        additionalProperties: false,
      },
    ),
    entry(
      "computer_browser_press",
      "Press key in browser tab",
      `Submit a focused browser field: sends Enter through the driver's trusted keystroke path (mode "keystrokes", text "\\n"). Works headless with no window activation. Use after computer_browser_type to submit search or a form. Pass the bind result's target_id and the tab's own tab_id; tab_id may be omitted when the target has one (or one active) tab.`,
      {
        type: "object",
        properties: {
          target_id: TARGET_ID_PROPERTY,
          tab_id: TAB_ID_PROPERTY,
          ref: REF_PROPERTY,
        },
        required: ["target_id", "ref"],
        additionalProperties: false,
      },
    ),
  ];
}
