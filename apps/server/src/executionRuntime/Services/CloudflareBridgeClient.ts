/**
 * CloudflareBridgeClient - Server-internal boundary for talking to the
 * Cloudflare Runtime Bridge Worker over authenticated HTTP/WS.
 *
 * The bridge client owns the wire: it attaches the bearer token, encodes/decodes
 * the `@t3tools/contracts` bridge shapes, and exposes one method per bridge route
 * (create / get / exec / read-write files / expose port / network policy / renew
 * activity / delete) plus an interactive terminal transport. The Cloudflare
 * `ExecutionRuntimeProviderAdapter` is built entirely on this client, so the
 * adapter never constructs URLs or speaks HTTP directly.
 *
 * Terminal sessions return the same `JsonRpcLineTransport` value the Codex
 * session consumes, with the bridge's terminal WebSocket forwarded into the
 * transport's in-memory queues — the remote forwarding seam, identical in shape
 * to the fake-remote adapter's local-process forwarding.
 *
 * @module CloudflareBridgeClient
 */
import type {
  BridgeCreateInstanceRequest,
  BridgeExecRequest,
  BridgeExecResult,
  BridgeExposePortRequest,
  BridgeInstance,
  BridgeNetworkPolicyRequest,
  BridgeRenewActivityRequest,
  BridgeRenewActivityResult,
  BridgeRoute,
  ExecutionInstanceId,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { JsonRpcLineTransport } from "../../provider/process/JsonRpcLineTransport.ts";
import type { CloudflareBridgeError } from "../Errors.ts";

export interface CloudflareTerminalOpenInput {
  readonly instanceId: ExecutionInstanceId;
  readonly command: string | null;
  readonly args: ReadonlyArray<string>;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string | null;
}

export interface CloudflareFileReadInput {
  readonly instanceId: ExecutionInstanceId;
  readonly path: string;
}

export interface CloudflareFileWriteInput {
  readonly instanceId: ExecutionInstanceId;
  readonly path: string;
  /** Raw bytes; the client base64-encodes them for the wire. */
  readonly content: Uint8Array;
}

export interface CloudflareBridgeClientShape {
  /** POST /instances — provision a new bridge instance. */
  readonly createInstance: (
    request: BridgeCreateInstanceRequest,
  ) => Effect.Effect<BridgeInstance, CloudflareBridgeError>;
  /** GET /instances/:id — read the current instance record. */
  readonly getInstance: (
    instanceId: ExecutionInstanceId,
  ) => Effect.Effect<BridgeInstance, CloudflareBridgeError>;
  /** POST /instances/:id/exec — fire-and-collect command. */
  readonly exec: (
    instanceId: ExecutionInstanceId,
    request: BridgeExecRequest,
  ) => Effect.Effect<BridgeExecResult, CloudflareBridgeError>;
  /** GET /instances/:id/files — read a file. */
  readonly readFile: (
    input: CloudflareFileReadInput,
  ) => Effect.Effect<Uint8Array, CloudflareBridgeError>;
  /** PUT /instances/:id/files — write a file. */
  readonly writeFile: (
    input: CloudflareFileWriteInput,
  ) => Effect.Effect<void, CloudflareBridgeError>;
  /** POST /instances/:id/ports — expose a port on demand. */
  readonly exposePort: (
    instanceId: ExecutionInstanceId,
    request: BridgeExposePortRequest,
  ) => Effect.Effect<BridgeRoute, CloudflareBridgeError>;
  /** PUT /instances/:id/network-policy — set the outbound network policy. */
  readonly setNetworkPolicy: (
    instanceId: ExecutionInstanceId,
    request: BridgeNetworkPolicyRequest,
  ) => Effect.Effect<void, CloudflareBridgeError>;
  /** POST /instances/:id/renew-activity — renew the keepalive lease. */
  readonly renewActivity: (
    instanceId: ExecutionInstanceId,
    request: BridgeRenewActivityRequest,
  ) => Effect.Effect<BridgeRenewActivityResult, CloudflareBridgeError>;
  /**
   * Open the interactive terminal WebSocket and return a line transport whose
   * inbound stream carries terminal output and whose `send` writes stdin frames.
   * Closing the transport closes the socket.
   */
  readonly openTerminal: (
    input: CloudflareTerminalOpenInput,
  ) => Effect.Effect<JsonRpcLineTransport, CloudflareBridgeError>;
  /** DELETE /instances/:id — destroy the instance. Idempotent. */
  readonly deleteInstance: (
    instanceId: ExecutionInstanceId,
  ) => Effect.Effect<void, CloudflareBridgeError>;
}

export class CloudflareBridgeClient extends ServiceMap.Service<
  CloudflareBridgeClient,
  CloudflareBridgeClientShape
>()("t3/executionRuntime/Services/CloudflareBridgeClient") {}
