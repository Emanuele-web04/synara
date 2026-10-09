import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type DesktopBridge,
  type OrchestrationEvent,
  type ProductAnalyticsFeature,
  type ProductAnalyticsInput,
  type ProductAnalyticsMode,
} from "@synara/contracts";
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
