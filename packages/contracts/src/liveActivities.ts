import { Schema } from "effect";
import { boundedTrimmedNonEmptyString, NonNegativeInt } from "./baseSchemas";

const Id = boundedTrimmedNonEmptyString(200);
const PushWatchId = Schema.String.check(Schema.isUUID(4));
const DeviceJkt = boundedTrimmedNonEmptyString(100);
const DisplayId = boundedTrimmedNonEmptyString(500);

// Uncompressed X9.63 P-256 public key, encoded as unpadded base64url.
const CompletionPreviewKey = Schema.String.check(Schema.isPattern(/^B[A-Za-z0-9_-]{86}$/));
export const CompletionPreviewRecipient = Schema.Struct({
  key: CompletionPreviewKey,
  proof: Schema.String.check(
    Schema.isMaxLength(3000),
    Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  ),
});
export type CompletionPreviewRecipient = typeof CompletionPreviewRecipient.Type;

export const CompletionPreviewEnvelope = Schema.Struct({
  v: Schema.Literal(1),
  ephemeralKey: CompletionPreviewKey,
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16}$/)),
  ciphertext: Schema.String.check(
    Schema.isMinLength(22),
    Schema.isMaxLength(2000),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  ),
});
export type CompletionPreviewEnvelope = typeof CompletionPreviewEnvelope.Type;

const CompletionPreviewBinding = {
  notificationId: PushWatchId,
  deviceJkt: DeviceJkt,
  threadId: Id,
  turnId: Id,
  displayId: DisplayId,
};
export const CompletionPreviewWatch = Schema.Struct({
  ...CompletionPreviewBinding,
  preview: CompletionPreviewRecipient,
});
export type CompletionPreviewWatch = typeof CompletionPreviewWatch.Type;

export const CompletionPreviewHostReport = Schema.Struct({
  ...CompletionPreviewBinding,
  effectiveTurnId: Id,
  recipientKey: CompletionPreviewKey,
  preview: CompletionPreviewEnvelope,
});
export type CompletionPreviewHostReport = typeof CompletionPreviewHostReport.Type;
export const COMPLETION_PREVIEW_PROOF_TYPE = "synara-notification-preview+jwt";
export const COMPLETION_PREVIEW_DOMAIN = "synara-notification-preview/v1";
export const LiveActivitySource = Schema.Struct({
  hostId: Schema.String.check(Schema.isUUID(4)),
  threadId: Id,
  turnId: Id,
  // The phone's namespaced identifier, for deep linking only. Never a title/path.
  displayId: DisplayId,
});
export type LiveActivitySource = typeof LiveActivitySource.Type;
export const RegisterLiveActivity = Schema.Struct({
  activityId: Schema.String.check(Schema.isUUID(4)),
  deviceJkt: boundedTrimmedNonEmptyString(100),
  revision: NonNegativeInt,
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64,512}$/)),
  environment: Schema.Literals(["sandbox", "production"]),
  sources: Schema.Array(LiveActivitySource).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});
export type RegisterLiveActivity = typeof RegisterLiveActivity.Type;
export const LiveActivityHostSnapshot = Schema.Struct({
  sequence: NonNegativeInt,
  turns: Schema.Array(
    Schema.Struct({
      threadId: Id,
      turnId: Id,
      state: Schema.Literals([
        "running",
        "needsApproval",
        "needsInput",
        "ready",
        "failed",
        "stopped",
        "usageLimit",
        "resuming",
      ]),
      // Waiting has no running clock. Epoch seconds are converted only at the APNs boundary.
      startedAt: Schema.optional(
        Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
      ),
      usageLimitResetAt: Schema.optional(
        Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
      ),
      // The original subscription remains exact; this is its recorded recovery descendant only.
      effectiveTurnId: Schema.optional(Id),
    }),
  ).check(Schema.isMaxLength(256)),
  previews: Schema.optional(
    Schema.Array(CompletionPreviewHostReport).check(Schema.isMaxLength(64)),
  ),
});
export type LiveActivityHostSnapshot = typeof LiveActivityHostSnapshot.Type;

// Ordinary alert tokens are distinct from ActivityKit tokens. A subscription
// owns one exact turn and survives phone suspension until delivery or expiry.
export const RegisterTurnNotification = Schema.Struct({
  notificationId: PushWatchId,
  deviceJkt: DeviceJkt,
  revision: NonNegativeInt,
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64,512}$/)),
  environment: Schema.Literals(["sandbox", "production"]),
  source: LiveActivitySource,
  preview: Schema.optional(CompletionPreviewRecipient),
});
export type RegisterTurnNotification = typeof RegisterTurnNotification.Type;

export const RemoveTurnNotifications = Schema.Struct({
  deviceJkt: boundedTrimmedNonEmptyString(100),
  hostId: Schema.optional(Schema.String.check(Schema.isUUID(4))),
});
export type RemoveTurnNotifications = typeof RemoveTurnNotifications.Type;
