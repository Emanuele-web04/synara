import {
  ORCHESTRATION_WS_METHODS,
  STATIC_KEYBINDING_COMMANDS,
  WS_METHODS,
  type DesktopBridge,
  type OrchestrationEvent,
  type ProductAnalyticsFeature,
  type ProductAnalyticsInput,
  type ProductAnalyticsMode,
  type ProductAnalyticsTurnFailure,
  type ReliabilityCode,
} from "@synara/contracts";
import { isBuiltInComposerSlashCommandName } from "@synara/shared/composerSlashCommands";
import { readWorkspaceFrame } from "./hosts/workspaceFrame";

/** Only trusted app workspace frames may use the controlling window's consent. */
export function productAnalyticsBridge(): DesktopBridge["productAnalytics"] {
  try {
    if (typeof window === "undefined") return undefined;
    return readWorkspaceFrame()
      ? window.parent.desktopBridge?.productAnalytics
      : window.desktopBridge?.productAnalytics;
  } catch {
    return undefined;
  }
}

export function trackProductAnalytics(input: ProductAnalyticsInput): void {
  try {
    productAnalyticsBridge()?.track(input);
  } catch {
    // Analytics never changes the operation it observes.
  }
}

export function trackReliabilityIssue(code: ReliabilityCode): void {
  trackProductAnalytics({ event: "reliability.issue", outcome: "failed", reliabilityCode: code });
}

const BUILT_IN_SHORTCUTS = new Set<string>(STATIC_KEYBINDING_COMMANDS);
const countedShortcutEvents = new WeakSet<object>();

/** Counts a resolved shortcut once per key press; numbered jumps share one name. */
export function trackShortcutCommand(event: object, command: string): void {
  if (countedShortcutEvents.has(event)) return;
  countedShortcutEvents.add(event);
  const name = BUILT_IN_SHORTCUTS.has(command) ? command.replace(/\.\d+$/, "") : "custom";
  trackProductAnalytics({
    event: "command.used",
    outcome: "succeeded",
    command: `shortcut:${name}`,
  });
}

/** Counts a slash command; only built-in names are kept. */
export function trackSlashCommand(command: string): void {
  const name = command.trim().replace(/^\/+/, "").toLowerCase();
  trackProductAnalytics({
    event: "command.used",
    outcome: "succeeded",
    command: `slash:${isBuiltInComposerSlashCommandName(name) ? name : "custom"}`,
  });
}

/** Classifies intent only; no route, RPC arguments, names or identifiers are sent. */
export function productRpcActivity(
  method: string,
  params: unknown,
): Pick<ProductAnalyticsInput, "event" | "feature"> | undefined {
  try {
    if (!productAnalyticsBridge()) return;
    if (method === WS_METHODS.hostsRemoteAccess) {
      if (
        (params as { request?: { operation?: unknown } } | undefined)?.request?.operation === "pair"
      )
        return { event: "connection.pair" };
      return;
    }
    if (method === WS_METHODS.hostsConfirmSyncKey) return { event: "connection.pair" };
    if (method !== ORCHESTRATION_WS_METHODS.dispatchCommand) return;
    const type = (params as { command?: { type?: unknown } } | undefined)?.command?.type;
    if (type === "thread.turn.start") return { event: "chat.request" };
    if (type === "project.create") return { event: "feature.used", feature: "project" };
  } catch {
    // Malformed inputs are still handled by the normal RPC boundary.
  }
}

export function trackProductNavigation(pathname: string): void {
  const section = pathname.split("/")[1];
  const features: Record<string, ProductAnalyticsFeature> = {
    settings: "settings",
    inbox: "inbox",
    tasks: "tasks",
    kanban: "tasks",
    hubs: "hubs",
    groups: "hubs",
    browser: "browser",
    search: "search",
  };
  const feature = features[section ?? ""];
  if (feature) trackProductAnalytics({ event: "feature.used", outcome: "succeeded", feature });
}

const TOKEN_LIMIT = 1_000_000_000_000;
function count(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= TOKEN_LIMIT
    ? value
    : undefined;
}

// Provider error codes (Claude SDK assistant errors, Codex error info) to fixed categories.
const TURN_FAILURE_BY_ERROR_CODE: Record<string, ProductAnalyticsTurnFailure> = {
  edge_blocked: "edge_blocked",
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  cloud_credential_error: "auth",
  unauthorized: "auth",
  account_on_hold: "account",
  verification_required: "account",
  billing_error: "billing",
  rate_limit: "rate_limit",
  rateLimitExceeded: "rate_limit",
  usageLimitExceeded: "usage_limit",
  overloaded: "overloaded",
  server_overloaded: "overloaded",
  server_error: "server_error",
  internalServerError: "server_error",
  invalid_request: "invalid_request",
  badRequest: "invalid_request",
  model_not_found: "model_unavailable",
  contextWindowExceeded: "context_limit",
  max_output_tokens: "output_limit",
  httpConnectionFailed: "network",
  responseStreamConnectionFailed: "network",
  responseStreamDisconnected: "network",
};

/**
 * Why a turn failed or was interrupted by an error, as a fixed category. A cancelled
 * turn without an error code is a user stop and has no failure.
 */
export function productTurnFailure(input: {
  readonly outcome: "failed" | "cancelled";
  readonly errorCode: unknown;
  readonly httpStatus: number | undefined;
}): ProductAnalyticsTurnFailure | undefined {
  const code = typeof input.errorCode === "string" ? input.errorCode : undefined;
  if (code === undefined && input.outcome === "cancelled") return undefined;
  const mapped = code === undefined ? undefined : TURN_FAILURE_BY_ERROR_CODE[code];
  if (mapped) return mapped;
  const status = input.httpStatus;
  if (status === 401) return "auth";
  if (status === 429) return "rate_limit";
  if (status !== undefined && status >= 500) return "server_error";
  return "other";
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/** Observed live completions only: snapshots/history must never inflate adoption. */
export class ProductTurnObserver {
  private readonly startedAt = Date.now();
  private readonly seen = new Set<string>();

  observe(event: OrchestrationEvent, mode: ProductAnalyticsMode): void {
    if (event.type !== "thread.activity-appended") return;
    const activity = event.payload.activity;
    const occurredAt = Date.parse(activity.createdAt);
    if (
      activity.kind !== "turn.completed" ||
      !Number.isFinite(occurredAt) ||
      occurredAt < this.startedAt
    )
      return;
    const bridge = productAnalyticsBridge();
    if (!bridge) return;
    // Read persisted consent before maintaining analytics-specific deduplication state.
    void bridge
      .getState()
      .then(({ enabled }) => {
        if (!enabled) {
          this.seen.clear();
          return;
        }
        const key = `${event.payload.threadId}:${activity.turnId ?? activity.id}`;
        if (this.seen.has(key)) return;
        const rawPayload = activity.payload;
        if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return;
        const payload = rawPayload as Record<string, unknown>;
        const outcome =
          payload.state === "completed"
            ? "succeeded"
            : payload.state === "failed"
              ? "failed"
              : payload.state === "cancelled" || payload.state === "interrupted"
                ? "cancelled"
                : undefined;
        if (!outcome) return;
        const input: ProductAnalyticsInput = {
          event: "turn.completed",
          outcome,
          mode,
          provider:
            payload.provider === "codex"
              ? "codex"
              : payload.provider === "claudeAgent"
                ? "claude"
                : "other",
        };
        if (outcome !== "succeeded") {
          // Error text never leaves the app: only the category and the HTTP status.
          const status = httpStatus(payload.httpStatus);
          const failure = productTurnFailure({
            outcome,
            errorCode: payload.errorCode,
            httpStatus: status,
          });
          if (failure !== undefined) {
            Object.assign(input, {
              failure,
              ...(status !== undefined ? { httpStatus: status } : {}),
            });
          }
        }
        // Read values only; model dictionary keys can be user-defined and never leave the app.
        const modelUsage = payload.modelUsage;
        if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
          const rows = Object.values(modelUsage);
          if (rows.length > 0 && rows.length <= 64) {
            const sum = (field: string): number | undefined => {
              let total = 0;
              for (const row of rows) {
                if (!row || typeof row !== "object" || Array.isArray(row)) return;
                const value = count((row as Record<string, unknown>)[field]);
                if (value === undefined) return;
                total += value;
              }
              return count(total);
            };
            const inputTokens = sum("inputTokens");
            const outputTokens = sum("outputTokens");
            const cachedInputTokens = sum("cacheReadInputTokens");
            if (inputTokens !== undefined) Object.assign(input, { inputTokens });
            if (outputTokens !== undefined) Object.assign(input, { outputTokens });
            if (cachedInputTokens !== undefined) Object.assign(input, { cachedInputTokens });
          }
        }
        this.seen.add(key);
        if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
        bridge.track(input);
      })
      .catch(() => undefined);
  }
}
