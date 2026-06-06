import { Schema } from "effect";
import {
  ExecutionInstanceId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RuntimeProcessId,
  RuntimeRouteId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { RuntimeInstanceStatus, RuntimeRole } from "./executionRuntime";

/**
 * Cloudflare Runtime Bridge wire protocol (schema-only).
 *
 * The bridge is a Cloudflare Worker + Durable Object that maps a
 * `runtimeInstanceId` to a running instance and exposes authenticated routes for
 * instance lifecycle, command exec, log streaming, an interactive terminal (over
 * WebSocket), file read/write/watch, exposed ports, network policy, activity
 * renewal, and deletion. Both sides — the Worker handlers in
 * `apps/cloudflare-runtime-bridge` and the Synara `CloudflareBridgeClient`
 * adapter — validate against these shapes, so the contract is the single place
 * the request/response bodies are defined.
 *
 * These are bridge-transport shapes, not orchestration events: the adapter
 * projects them into the execution-runtime read-model server-side. They never
 * extend `ProviderRuntimeEvent`.
 */

/** Wire envelope returned on a failed bridge call (HTTP non-2xx body). */
export const BridgeErrorBody = Schema.Struct({
  error: TrimmedNonEmptyString,
  detail: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type BridgeErrorBody = typeof BridgeErrorBody.Type;

/** Resource limits requested at instance-create time. */
export const BridgeInstanceResources = Schema.Struct({
  cpu: Schema.optional(PositiveInt),
  memoryMb: Schema.optional(PositiveInt),
  diskMb: Schema.optional(PositiveInt),
});
export type BridgeInstanceResources = typeof BridgeInstanceResources.Type;

/**
 * Which lower-level Cloudflare runtime backs an instance. `workspace` is the
 * default sandbox SDK runtime (interactive, file/terminal-capable). `container`
 * is the raw Containers runtime, kept service-oriented (declared ports, no
 * default interactive terminal) rather than the default workspace.
 */
export const BridgeRuntimeFlavor = Schema.Literals(["workspace", "container"]);
export type BridgeRuntimeFlavor = typeof BridgeRuntimeFlavor.Type;

/** POST /instances request body. */
export const BridgeCreateInstanceRequest = Schema.Struct({
  flavor: Schema.optional(BridgeRuntimeFlavor).pipe(
    Schema.withDecodingDefault(() => "workspace" as const),
  ),
  resources: Schema.optional(BridgeInstanceResources),
  /** Ports the instance should expose at create time (containers declare here). */
  ports: Schema.optional(Schema.Array(PositiveInt)).pipe(Schema.withDecodingDefault(() => [])),
  /** Seconds of idle before the bridge may reclaim the instance. */
  idleTimeoutSeconds: Schema.optional(PositiveInt),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)).pipe(
    Schema.withDecodingDefault(() => ({})),
  ),
});
export type BridgeCreateInstanceRequest = typeof BridgeCreateInstanceRequest.Type;

/** An exposed route on a bridge instance. */
export const BridgeRoute = Schema.Struct({
  id: RuntimeRouteId,
  port: PositiveInt,
  url: Schema.NullOr(TrimmedNonEmptyString),
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type BridgeRoute = typeof BridgeRoute.Type;

/** Instance read-model the bridge returns on create/get. */
export const BridgeInstance = Schema.Struct({
  id: ExecutionInstanceId,
  flavor: BridgeRuntimeFlavor,
  status: RuntimeInstanceStatus,
  rootPath: Schema.NullOr(TrimmedNonEmptyString),
  routes: Schema.optional(Schema.Array(BridgeRoute)).pipe(Schema.withDecodingDefault(() => [])),
  failureReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BridgeInstance = typeof BridgeInstance.Type;

/** POST /instances/:id/exec request body (fire-and-collect command). */
export const BridgeExecRequest = Schema.Struct({
  role: Schema.optional(RuntimeRole).pipe(Schema.withDecodingDefault(() => "exec" as const)),
  command: TrimmedNonEmptyString,
  args: Schema.optional(Schema.Array(Schema.String)).pipe(Schema.withDecodingDefault(() => [])),
  /** Workdir relative to the instance root; defaults to the root. */
  cwd: Schema.optional(Schema.NullOr(Schema.String)).pipe(Schema.withDecodingDefault(() => null)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)).pipe(
    Schema.withDecodingDefault(() => ({})),
  ),
});
export type BridgeExecRequest = typeof BridgeExecRequest.Type;

/** Collected result of a fire-and-collect exec. */
export const BridgeExecResult = Schema.Struct({
  processId: RuntimeProcessId,
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
});
export type BridgeExecResult = typeof BridgeExecResult.Type;

/** A single streamed log line from GET /instances/:id/logs (NDJSON). */
export const BridgeLogLine = Schema.Struct({
  processId: Schema.optional(Schema.NullOr(RuntimeProcessId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  stream: Schema.Literals(["stdout", "stderr"]),
  line: Schema.String,
  at: IsoDateTime,
});
export type BridgeLogLine = typeof BridgeLogLine.Type;

/**
 * A frame on the terminal WebSocket. The terminal channel multiplexes input
 * (client->bridge) and output/exit (bridge->client) over one socket. `data`
 * carries already-text-decoded terminal bytes; `resize` carries PTY dimensions;
 * `exit` ends the session. `stdin` is the client write channel. Frames are
 * discriminated by `_tag`.
 */
export const BridgeTerminalFrame = Schema.Union([
  Schema.TaggedStruct("stdin", { data: Schema.String }),
  Schema.TaggedStruct("resize", { cols: PositiveInt, rows: PositiveInt }),
  Schema.TaggedStruct("data", { data: Schema.String }),
  Schema.TaggedStruct("exit", { exitCode: Schema.NullOr(Schema.Int) }),
]);
export type BridgeTerminalFrame = typeof BridgeTerminalFrame.Type;

/** POST /instances/:id/terminal request body (open an interactive session). */
export const BridgeOpenTerminalRequest = Schema.Struct({
  command: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  args: Schema.optional(Schema.Array(Schema.String)).pipe(Schema.withDecodingDefault(() => [])),
  cols: Schema.optional(PositiveInt),
  rows: Schema.optional(PositiveInt),
  cwd: Schema.optional(Schema.NullOr(Schema.String)).pipe(Schema.withDecodingDefault(() => null)),
});
export type BridgeOpenTerminalRequest = typeof BridgeOpenTerminalRequest.Type;

/** GET /instances/:id/files?path=... response (read). */
export const BridgeFileReadResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** Base64-encoded file bytes so binary content survives JSON transport. */
  contentBase64: Schema.String,
  truncated: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type BridgeFileReadResult = typeof BridgeFileReadResult.Type;

/** PUT /instances/:id/files request body (write). */
export const BridgeFileWriteRequest = Schema.Struct({
  path: TrimmedNonEmptyString,
  contentBase64: Schema.String,
});
export type BridgeFileWriteRequest = typeof BridgeFileWriteRequest.Type;

/** A file-change notification on the watch stream (NDJSON). */
export const BridgeFileWatchEvent = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: Schema.Literals(["created", "modified", "deleted"]),
  at: IsoDateTime,
});
export type BridgeFileWatchEvent = typeof BridgeFileWatchEvent.Type;

/** POST /instances/:id/ports request body (expose a port on demand). */
export const BridgeExposePortRequest = Schema.Struct({
  port: PositiveInt,
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
});
export type BridgeExposePortRequest = typeof BridgeExposePortRequest.Type;

/** A single outbound network-policy rule. */
export const BridgeNetworkRule = Schema.Struct({
  action: Schema.Literals(["allow", "deny"]),
  /** Host or CIDR the rule applies to; `*` matches all egress. */
  host: TrimmedNonEmptyString,
});
export type BridgeNetworkRule = typeof BridgeNetworkRule.Type;

/** PUT /instances/:id/network-policy request body. */
export const BridgeNetworkPolicyRequest = Schema.Struct({
  /** Default egress posture when no rule matches. */
  defaultEgress: Schema.Literals(["allow", "deny"]),
  rules: Schema.optional(Schema.Array(BridgeNetworkRule)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
});
export type BridgeNetworkPolicyRequest = typeof BridgeNetworkPolicyRequest.Type;

/** POST /instances/:id/renew-activity request body (keepalive lease). */
export const BridgeRenewActivityRequest = Schema.Struct({
  reason: Schema.Literals(["turn", "terminal", "preview"]),
  /** Additional seconds of liveness this renewal buys. */
  extendSeconds: Schema.optional(PositiveInt),
});
export type BridgeRenewActivityRequest = typeof BridgeRenewActivityRequest.Type;

/** Response to a renew-activity call. */
export const BridgeRenewActivityResult = Schema.Struct({
  expiresAt: Schema.NullOr(IsoDateTime),
  remainingSeconds: Schema.optional(NonNegativeInt),
});
export type BridgeRenewActivityResult = typeof BridgeRenewActivityResult.Type;
