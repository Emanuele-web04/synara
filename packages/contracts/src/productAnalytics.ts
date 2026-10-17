import * as Schema from "effect/Schema";

export const ProductAnalyticsEvent = Schema.Literals([
  "app.open",
  // Once per UTC day while the app runs, so long sessions still count as active days.
  "app.active",
  "feature.used",
  // A built-in shortcut or slash command; see ProductAnalyticsCommand.
  "command.used",
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
/** Why a connection, pairing or request failed. A fixed category, never error text. */
export const ProductAnalyticsReason = Schema.Literals([
  "unreachable",
  "not_accepting",
  "account_unavailable",
  "host_unlinked",
  "pairing_required",
  "incompatible",
  "timeout",
  "invalid_code",
  "rejected",
  "other",
]);
export type ProductAnalyticsReason = typeof ProductAnalyticsReason.Type;
/**
 * `shortcut:<built-in command>` or `slash:<built-in command>`; anything a user
 * defined is reported as `custom`, so no free text enters this field.
 */
export const PRODUCT_ANALYTICS_COMMAND_PATTERN = /^(shortcut|slash):[a-z][A-Za-z0-9.-]{0,47}$/;
const ProductAnalyticsCommand = Schema.String.check(
  Schema.isPattern(PRODUCT_ANALYTICS_COMMAND_PATTERN),
);

const DurationMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400_000 }));
const TokenCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000_000 }));
export const ProductAnalyticsChannel = Schema.Literals(["stable", "beta", "remote"]);
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
  reason: Schema.optional(ProductAnalyticsReason),
  command: Schema.optional(ProductAnalyticsCommand),
  durationMs: Schema.optional(DurationMs),
  inputTokens: Schema.optional(TokenCount),
  outputTokens: Schema.optional(TokenCount),
  cachedInputTokens: Schema.optional(TokenCount),
});
export type ProductAnalyticsInput = typeof ProductAnalyticsInput.Type;

/**
 * Counts people across their devices without naming them: the first 32 hex
 * characters of SHA-256("synara-usage-v1:" + account user id).
 */
export const PRODUCT_ANALYTICS_ACCOUNT_HASH_PREFIX = "synara-usage-v1:";

export const ProductAnalyticsEnvelope = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  ts: Schema.String,
  installId: Schema.String,
  accountHash: Schema.optional(Schema.String),
  channel: ProductAnalyticsChannel,
  surface: ProductAnalyticsSurface,
  platform: ProductAnalyticsPlatform,
  appVersion: Schema.String,
  event: ProductAnalyticsEvent,
  outcome: ProductAnalyticsOutcome,
  feature: Schema.optional(ProductAnalyticsFeature),
  mode: Schema.optional(ProductAnalyticsMode),
  provider: Schema.optional(ProductAnalyticsProvider),
  reason: Schema.optional(ProductAnalyticsReason),
  command: Schema.optional(ProductAnalyticsCommand),
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
  /** The signed-in account's user id, or null after sign-out; only its hash is kept. */
  setAccount?: (userId: string | null) => void;
}
