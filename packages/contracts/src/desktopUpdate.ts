// Purpose: Bounds desktop updater commands shared by wsRpc and the owned backend IPC channel.
// Layer: Cross-process contracts; updater policy and execution remain in Electron.
import { Schema } from "effect";

import { boundedTrimmedNonEmptyString, NonNegativeInt } from "./baseSchemas";

const Version = boundedTrimmedNonEmptyString(128);
const Message = Schema.String.check(Schema.isMaxLength(4_096));
const RuntimeArch = Schema.Literals(["arm64", "x64", "other"]);

export const DesktopUpdateWireState = Schema.Struct({
  enabled: Schema.Boolean,
  status: Schema.Literals([
    "disabled",
    "idle",
    "checking",
    "up-to-date",
    "available",
    "downloading",
    "downloaded",
    "error",
  ]),
  currentVersion: Version,
  hostArch: RuntimeArch,
  appArch: RuntimeArch,
  runningUnderArm64Translation: Schema.Boolean,
  availableVersion: Schema.NullOr(Version),
  downloadedVersion: Schema.NullOr(Version),
  downloadPercent: Schema.NullOr(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ),
  checkedAt: Schema.NullOr(boundedTrimmedNonEmptyString(128)),
  message: Schema.NullOr(Message),
  errorContext: Schema.NullOr(Schema.Literals(["check", "download", "install"])),
  canRetry: Schema.Boolean,
  installFailureCount: NonNegativeInt,
  flavor: Schema.Literals(["production", "beta", "canary", "cua", "remote"]),
  releaseUrl: Schema.NullOr(boundedTrimmedNonEmptyString(2_048)),
});

export const ServerDesktopUpdateStatus = Schema.Struct({
  supported: Schema.Boolean,
  state: Schema.NullOr(DesktopUpdateWireState),
  busy: Schema.Boolean,
  message: Schema.NullOr(Message),
});
export type ServerDesktopUpdateStatus = typeof ServerDesktopUpdateStatus.Type;

export const ServerDesktopUpdateInput = Schema.Struct({
  action: Schema.Literals(["check", "download", "install"]),
  confirmRestart: Schema.optional(Schema.Literal(true)),
  expectedVersion: Schema.optional(Version),
  // A second request bearing this one-use token acknowledges receipt of the first response.
  restartToken: Schema.optional(boundedTrimmedNonEmptyString(128)),
});
export type ServerDesktopUpdateInput = typeof ServerDesktopUpdateInput.Type;

export const ServerDesktopUpdateResult = Schema.Struct({
  accepted: Schema.Boolean,
  status: ServerDesktopUpdateStatus,
  restartToken: Schema.optional(boundedTrimmedNonEmptyString(128)),
});
export type ServerDesktopUpdateResult = typeof ServerDesktopUpdateResult.Type;

export const DesktopUpdateIpcRequest = Schema.Struct({
  type: Schema.Literal("synara:desktop-update:request"),
  id: boundedTrimmedNonEmptyString(128),
  authority: boundedTrimmedNonEmptyString(256),
  action: Schema.Literals(["status", "check", "download", "install"]),
  expectedVersion: Schema.optional(Version),
  restartToken: Schema.optional(boundedTrimmedNonEmptyString(128)),
});
export type DesktopUpdateIpcRequest = typeof DesktopUpdateIpcRequest.Type;

export const DesktopUpdateIpcResponse = Schema.Struct({
  type: Schema.Literal("synara:desktop-update:response"),
  id: boundedTrimmedNonEmptyString(128),
  result: ServerDesktopUpdateResult,
});
