import * as Schema from "effect/Schema";

export const ProductAnalyticsEvent = Schema.Literals([
  "app.open",
  "feature.used",
  "connection.pair",
  "connection.connect",
  "connection.reconnect",
  "chat.request",
  "turn.completed",
  "performance.startup",
]);
export type ProductAnalyticsEvent = typeof ProductAnalyticsEvent.Type;

export const ProductAnalyticsOutcome = Schema.Literals([
  "started",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ProductAnalyticsOutcome = typeof ProductAnalyticsOutcome.Type;

export const ProductAnalyticsFeature = Schema.Literals([
  "chat",
  "connections",
  "inbox",
  "tasks",
  "hubs",
  "browser",
  "settings",
  "search",
  "project",
]);
export type ProductAnalyticsFeature = typeof ProductAnalyticsFeature.Type;

export const ProductAnalyticsMode = Schema.Literals(["local", "remote"]);
export type ProductAnalyticsMode = typeof ProductAnalyticsMode.Type;
export const ProductAnalyticsProvider = Schema.Literals(["codex", "claude", "other"]);
export type ProductAnalyticsProvider = typeof ProductAnalyticsProvider.Type;

const DurationMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400_000 }));
const TokenCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000_000 }));
export const ProductAnalyticsChannel = Schema.Literals(["stable", "beta"]);
export type ProductAnalyticsChannel = typeof ProductAnalyticsChannel.Type;
export const ProductAnalyticsSurface = Schema.Literals(["desktop", "ios", "ipados"]);
export type ProductAnalyticsSurface = typeof ProductAnalyticsSurface.Type;
export const ProductAnalyticsPlatform = Schema.Literals([
  "darwin",
  "win32",
  "linux",
  "ios",
  "ipados",
  "other",
]);
export type ProductAnalyticsPlatform = typeof ProductAnalyticsPlatform.Type;

export const ProductAnalyticsInput = Schema.Struct({
  event: ProductAnalyticsEvent,
  outcome: ProductAnalyticsOutcome,
  feature: Schema.optional(ProductAnalyticsFeature),
  mode: Schema.optional(ProductAnalyticsMode),
  provider: Schema.optional(ProductAnalyticsProvider),
  durationMs: Schema.optional(DurationMs),
  inputTokens: Schema.optional(TokenCount),
  outputTokens: Schema.optional(TokenCount),
  cachedInputTokens: Schema.optional(TokenCount),
});
export type ProductAnalyticsInput = typeof ProductAnalyticsInput.Type;

export const ProductAnalyticsEnvelope = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  ts: Schema.String,
  installId: Schema.String,
  channel: ProductAnalyticsChannel,
  surface: ProductAnalyticsSurface,
  platform: ProductAnalyticsPlatform,
  appVersion: Schema.String,
  event: ProductAnalyticsEvent,
  outcome: ProductAnalyticsOutcome,
  feature: Schema.optional(ProductAnalyticsFeature),
  mode: Schema.optional(ProductAnalyticsMode),
  provider: Schema.optional(ProductAnalyticsProvider),
  durationMs: Schema.optional(DurationMs),
  inputTokens: Schema.optional(TokenCount),
  outputTokens: Schema.optional(TokenCount),
  cachedInputTokens: Schema.optional(TokenCount),
});
export type ProductAnalyticsEnvelope = typeof ProductAnalyticsEnvelope.Type;

export interface ProductAnalyticsConsentState {
  readonly enabled: boolean;
}

export interface DesktopProductAnalyticsBridge {
  getState: () => Promise<ProductAnalyticsConsentState>;
  setEnabled: (enabled: boolean) => Promise<ProductAnalyticsConsentState>;
  track: (input: ProductAnalyticsInput) => void;
}
