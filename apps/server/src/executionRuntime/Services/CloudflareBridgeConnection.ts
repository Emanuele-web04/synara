/**
 * CloudflareBridgeConnection - The raw transport seam under the bridge client.
 *
 * Splits *how bytes move* (an authenticated HTTP round-trip and a WebSocket
 * connect) from *what the bridge means* (the typed routes in
 * `CloudflareBridgeClient`). Production binds this to Effect `HttpClient` + the
 * `ws` library; the contract test binds an in-process fake that needs no network.
 * Keeping the connection a separate service is what lets the bridge client's
 * route logic be tested without a live bridge or real credentials.
 *
 * @module CloudflareBridgeConnection
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CloudflareBridgeError } from "../Errors.ts";
import type { BridgeWebSocket } from "../Layers/cloudflareTerminalTransport.ts";

export interface CloudflareBridgeHttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path under the bridge base URL, e.g. `/instances/abc/exec`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** JSON-serializable body for POST/PUT. */
  readonly body?: unknown;
}

export interface CloudflareBridgeHttpResponse {
  readonly status: number;
  /** Already-parsed JSON body, or `null` for an empty body. */
  readonly json: unknown;
}

export interface CloudflareBridgeConnectionShape {
  /**
   * Execute one authenticated HTTP round-trip against the bridge. The bearer
   * token is attached here, so the client logic never sees the secret. A
   * transport failure (network, DNS) maps to a `CloudflareBridgeError` with a
   * null status; HTTP error statuses are returned as-is for the client to map.
   */
  readonly request: (
    input: CloudflareBridgeHttpRequest,
  ) => Effect.Effect<CloudflareBridgeHttpResponse, CloudflareBridgeError>;
  /**
   * Open an authenticated WebSocket to a bridge path and return a connected
   * duplex socket the terminal transport drives.
   */
  readonly connectWebSocket: (input: {
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
  }) => Effect.Effect<BridgeWebSocket, CloudflareBridgeError>;
}

export class CloudflareBridgeConnection extends ServiceMap.Service<
  CloudflareBridgeConnection,
  CloudflareBridgeConnectionShape
>()("t3/executionRuntime/Services/CloudflareBridgeConnection") {}
