import { Schema } from "effect";
import { boundedTrimmedNonEmptyString, NonNegativeInt } from "./baseSchemas";

const Id = boundedTrimmedNonEmptyString(200);
export const LiveActivitySource = Schema.Struct({
  hostId: Schema.String.check(Schema.isUUID(4)),
  threadId: Id,
  turnId: Id,
  // The phone's namespaced identifier, for deep linking only. Never a title/path.
  displayId: boundedTrimmedNonEmptyString(500),
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
      ]),
      startedAt: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    }),
  ).check(Schema.isMaxLength(256)),
});
export type LiveActivityHostSnapshot = typeof LiveActivityHostSnapshot.Type;

// Ordinary alert tokens are distinct from ActivityKit tokens. A subscription
// owns one exact turn and survives phone suspension until delivery or expiry.
export const RegisterTurnNotification = Schema.Struct({
  notificationId: Schema.String.check(Schema.isUUID(4)),
  deviceJkt: boundedTrimmedNonEmptyString(100),
  revision: NonNegativeInt,
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64,512}$/)),
  environment: Schema.Literals(["sandbox", "production"]),
  source: LiveActivitySource,
});
export type RegisterTurnNotification = typeof RegisterTurnNotification.Type;

export const RemoveTurnNotifications = Schema.Struct({
  deviceJkt: boundedTrimmedNonEmptyString(100),
  hostId: Schema.optional(Schema.String.check(Schema.isUUID(4))),
});
export type RemoveTurnNotifications = typeof RemoveTurnNotifications.Type;
