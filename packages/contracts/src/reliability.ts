import * as Schema from "effect/Schema";

// Keep new Remote host failure signals on the desktop Beta channel.
const BETA_HOST_RELIABILITY_CODES = [
  "remote.admission_refused",
  "remote.authorization_failed",
  "remote.authorization_denied",
  "remote.authorization_subscription_required",
  "remote.tunnel_provision_failed",
  "remote.connector_exited",
] as const;

export const RELIABILITY_CODES = [
  "backend.exit_before_ready",
  "backend.exit_after_ready",
  "backend.spawn_failed",
  "backend.event_loop_stall",
  "app.renderer_crashed",
  "app.main_unhandled",
  "recovery.crash_resume_accepted",
  "recovery.crash_resume_skipped",
  "recovery.crash_resume_failed",
  "recovery.shutdown_event_timeout",
  "recovery.restart_reconciliation_failed",
  "chat.settlement_unavailable",
  "account.refresh_rate_limited",
  "account.refresh_rejected",
  "account.refresh_uncertain",
  "remote.device_revoked",
  "remote.ingress_socket_error",
  "remote.tunnel_socket_error",
  ...BETA_HOST_RELIABILITY_CODES,
  "billing.redirect_failed",
  "migration.startup_blocked",
  "migration.recovery_failed",
  "provider.event_retry",
  "provider.event_quarantined",
  "provider.turn_start_failed",
] as const;

export const ReliabilityCode = Schema.Literals(RELIABILITY_CODES);
export type ReliabilityCode = typeof ReliabilityCode.Type;
export const isReliabilityCode = Schema.is(ReliabilityCode);

export const ReliabilityInput = Schema.Struct({ code: ReliabilityCode }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type ReliabilityInput = typeof ReliabilityInput.Type;
export const decodeReliabilityInput = Schema.decodeUnknownSync(ReliabilityInput);

export const ReliabilityDay = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((day) => {
    const date = new Date(`${day}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
  }),
);

export const isReliabilityDay = Schema.is(ReliabilityDay);

export const ReliabilityReleaseVersion = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:beta|remote|alpha|canary|rc)\.(?:0|[1-9][0-9]*))?$/,
  ),
);

export const isReliabilityReleaseVersion = Schema.is(ReliabilityReleaseVersion);

export const ReliabilityPlatform = Schema.Literals(["darwin", "win32", "linux", "other"]);
export type ReliabilityPlatform = typeof ReliabilityPlatform.Type;
export const isReliabilityPlatform = Schema.is(ReliabilityPlatform);

export const ReliabilityChannel = Schema.Literals(["stable", "beta", "remote"]);
export type ReliabilityChannel = typeof ReliabilityChannel.Type;
export const isReliabilityChannel = Schema.is(ReliabilityChannel);

const betaHostReliabilityCodes: ReadonlySet<ReliabilityCode> = new Set(BETA_HOST_RELIABILITY_CODES);

/** Legacy codes retain their existing channels. New host failure codes are Beta-only. */
export function isReliabilityCodeAllowedForChannel(
  code: ReliabilityCode,
  channel: ReliabilityChannel,
): boolean {
  return channel === "beta" || !betaHostReliabilityCodes.has(code);
}

export const RELIABILITY_MAX_RECORD_AGE_DAYS = 7;
export const RELIABILITY_MAX_EVENTS_PER_POST = 50;
export const RELIABILITY_MAX_BODY_BYTES = 64 * 1024;

/** A short-lived random receipt deduplicates delivery without identifying an installation. */
export const ReliabilityRecord = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID(4)),
  day: ReliabilityDay,
  code: ReliabilityCode,
  channel: ReliabilityChannel,
  appVersion: ReliabilityReleaseVersion,
  platform: ReliabilityPlatform,
})
  .check(
    Schema.makeFilter(({ code, channel }) => isReliabilityCodeAllowedForChannel(code, channel)),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type ReliabilityRecord = typeof ReliabilityRecord.Type;
export const decodeReliabilityRecord = Schema.decodeUnknownSync(ReliabilityRecord);
