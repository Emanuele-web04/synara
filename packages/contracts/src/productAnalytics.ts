// Product analytics carries only closed categories and installation-local identity.
// Login and billing identifiers do not belong in this cross-process contract.
import * as Schema from "effect/Schema";
import { STATIC_KEYBINDING_COMMANDS } from "./keybindings";
import { ReliabilityCode } from "./reliability";

export const ANONYMOUS_PRODUCT_EVENTS = [
  "remote.pairing-approved",
  "remote.connection-succeeded",
  "remote.reconnection-succeeded",
  "remote.connection-timeout",
  "app.crash",
] as const;
export const ANONYMOUS_PRODUCT_RETRY_DAYS = 7;

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
  ...ANONYMOUS_PRODUCT_EVENTS,
  "chat.request",
  "turn.completed",
  "performance.startup",
  "reliability.issue",
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
import { BUILT_IN_COMPOSER_SLASH_COMMANDS } from "./composerSlashCommands";

export const PRODUCT_ANALYTICS_COMMANDS = [
  ...new Set(
    STATIC_KEYBINDING_COMMANDS.map((command) => `shortcut:${command.replace(/\.\d+$/, "")}`),
  ),
  "shortcut:custom",
  ...BUILT_IN_COMPOSER_SLASH_COMMANDS.map((command) => `slash:${command}`),
  "slash:custom",
];
const productCommands = new Set(PRODUCT_ANALYTICS_COMMANDS);
export function isProductAnalyticsCommand(value: unknown): value is string {
  return typeof value === "string" && productCommands.has(value);
}
const ProductAnalyticsCommand = Schema.Literals(PRODUCT_ANALYTICS_COMMANDS);

const DurationMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400_000 }));
const TokenCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000_000 }));
export const ProductAnalyticsChannel = Schema.Literals(["stable", "beta", "remote"]);
export type ProductAnalyticsChannel = typeof ProductAnalyticsChannel.Type;

/** A random receipt deduplicates delivery and has no installation or account scope. */
export const AnonymousProductRecord = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  // The queue uses ts for expiry. On this wire it carries only a UTC day.
  ts: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
    Schema.makeFilter((day) => {
      const date = new Date(day);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
    }),
  ),
  event: Schema.Literals(ANONYMOUS_PRODUCT_EVENTS),
  channel: ProductAnalyticsChannel,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AnonymousProductRecord = typeof AnonymousProductRecord.Type;
export const decodeAnonymousProductRecord = Schema.decodeUnknownSync(AnonymousProductRecord);

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
  reliabilityCode: Schema.optional(ReliabilityCode),
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

// Cohort metadata is generated by the installation sender, never the renderer input.
export const PRODUCT_COHORT_WINDOWS = { new: [0, 0], week1: [7, 13], month1: [30, 36] } as const;
export const ProductAnalyticsCohortStage = Schema.Literals(["new", "week1", "month1"]);
export type ProductAnalyticsCohortStage = typeof ProductAnalyticsCohortStage.Type;

export const ProductAnalyticsEnvelope = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  ts: Schema.String,
  installId: Schema.String,
  cohortDay: Schema.optional(Schema.String),
  cohortStage: Schema.optional(ProductAnalyticsCohortStage),
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
}
