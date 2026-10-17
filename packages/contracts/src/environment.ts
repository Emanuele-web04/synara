import { Schema } from "effect";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
});
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  accountProfileSync: Schema.optional(Schema.Boolean),
  remoteConnections: Schema.optional(Schema.Boolean),
  remoteResources: Schema.optional(Schema.Boolean),
  remoteUnavailableReason: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  channel: Schema.optional(Schema.Literals(["stable", "beta", "canary", "dev"])),
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  capabilities: ExecutionEnvironmentCapabilities,
  /**
   * An anonymous id of the physical computer (its hardware id, salted and hashed), shared
   * by every Synara install on it. Lets a client recognize two pairings of the same Mac
   * while two Macs with the same name stay apart. Absent when the platform will not say.
   */
  machineId: Schema.optional(TrimmedNonEmptyString),
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;
