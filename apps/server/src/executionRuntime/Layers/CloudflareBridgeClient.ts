/**
 * CloudflareBridgeClientLive - The bridge client route logic.
 *
 * Implements every `CloudflareBridgeClient` method on top of
 * `CloudflareBridgeConnection`: it builds the path, decodes the typed response
 * against the `@t3tools/contracts` bridge schema, and maps a non-2xx status to a
 * `CloudflareBridgeError`. It holds no transport concern (no URLs, no token, no
 * sockets) — that all lives in the connection — so the same logic is exercised
 * against the real bridge and the in-process fake.
 *
 * @module CloudflareBridgeClientLive
 */
import {
  BridgeExecResult,
  BridgeFileReadResult,
  BridgeInstance,
  BridgeRenewActivityResult,
  BridgeRoute,
  type ExecutionInstanceId,
} from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";

import { CloudflareBridgeError } from "../Errors.ts";
import {
  CloudflareBridgeClient,
  type CloudflareBridgeClientShape,
} from "../Services/CloudflareBridgeClient.ts";
import {
  CloudflareBridgeConnection,
  type CloudflareBridgeHttpResponse,
} from "../Services/CloudflareBridgeConnection.ts";
import { makeCloudflareTerminalTransport } from "./cloudflareTerminalTransport.ts";

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
};

const instancePath = (instanceId: ExecutionInstanceId, suffix = ""): string =>
  `/instances/${encodeURIComponent(String(instanceId))}${suffix}`;

const makeCloudflareBridgeClient = Effect.gen(function* () {
  const connection = yield* CloudflareBridgeConnection;

  /** Map a non-2xx status to a tagged error; otherwise decode the body. */
  const decodeOk = <A>(
    operation: string,
    schema: Schema.Codec<A, unknown, never, never>,
    response: CloudflareBridgeHttpResponse,
  ): Effect.Effect<A, CloudflareBridgeError> => {
    if (response.status < 200 || response.status >= 300) {
      return Effect.fail(
        new CloudflareBridgeError({
          operation,
          status: response.status,
          detail: describeErrorBody(response.json),
        }),
      );
    }
    return Schema.decodeUnknownEffect(schema)(response.json).pipe(
      Effect.mapError(
        (error) =>
          new CloudflareBridgeError({
            operation,
            status: response.status,
            detail: `malformed response: ${error.message}`,
          }),
      ),
    );
  };

  const expectOk = (
    operation: string,
    response: CloudflareBridgeHttpResponse,
  ): Effect.Effect<void, CloudflareBridgeError> => {
    if (response.status < 200 || response.status >= 300) {
      return Effect.fail(
        new CloudflareBridgeError({
          operation,
          status: response.status,
          detail: describeErrorBody(response.json),
        }),
      );
    }
    return Effect.void;
  };

  const createInstance: CloudflareBridgeClientShape["createInstance"] = (request) =>
    connection
      .request({ method: "POST", path: "/instances", body: request })
      .pipe(Effect.flatMap((response) => decodeOk("createInstance", BridgeInstance, response)));

  const getInstance: CloudflareBridgeClientShape["getInstance"] = (instanceId) =>
    connection
      .request({ method: "GET", path: instancePath(instanceId) })
      .pipe(Effect.flatMap((response) => decodeOk("getInstance", BridgeInstance, response)));

  const exec: CloudflareBridgeClientShape["exec"] = (instanceId, request) =>
    connection
      .request({ method: "POST", path: instancePath(instanceId, "/exec"), body: request })
      .pipe(Effect.flatMap((response) => decodeOk("exec", BridgeExecResult, response)));

  const readFile: CloudflareBridgeClientShape["readFile"] = (input) =>
    connection
      .request({
        method: "GET",
        path: instancePath(input.instanceId, "/files"),
        query: { path: input.path },
      })
      .pipe(
        Effect.flatMap((response) => decodeOk("readFile", BridgeFileReadResult, response)),
        Effect.map((result) => fromBase64(result.contentBase64)),
      );

  const writeFile: CloudflareBridgeClientShape["writeFile"] = (input) =>
    connection
      .request({
        method: "PUT",
        path: instancePath(input.instanceId, "/files"),
        body: { path: input.path, contentBase64: toBase64(input.content) },
      })
      .pipe(Effect.flatMap((response) => expectOk("writeFile", response)));

  const exposePort: CloudflareBridgeClientShape["exposePort"] = (instanceId, request) =>
    connection
      .request({ method: "POST", path: instancePath(instanceId, "/ports"), body: request })
      .pipe(Effect.flatMap((response) => decodeOk("exposePort", BridgeRoute, response)));

  const setNetworkPolicy: CloudflareBridgeClientShape["setNetworkPolicy"] = (instanceId, request) =>
    connection
      .request({ method: "PUT", path: instancePath(instanceId, "/network-policy"), body: request })
      .pipe(Effect.flatMap((response) => expectOk("setNetworkPolicy", response)));

  const renewActivity: CloudflareBridgeClientShape["renewActivity"] = (instanceId, request) =>
    connection
      .request({
        method: "POST",
        path: instancePath(instanceId, "/renew-activity"),
        body: request,
      })
      .pipe(
        Effect.flatMap((response) =>
          decodeOk("renewActivity", BridgeRenewActivityResult, response),
        ),
      );

  const openTerminal: CloudflareBridgeClientShape["openTerminal"] = (input) => {
    const query: Record<string, string> = {
      cols: String(input.cols),
      rows: String(input.rows),
    };
    if (input.command !== null) {
      query.command = input.command;
    }
    if (input.cwd !== null) {
      query.cwd = input.cwd;
    }
    return connection
      .connectWebSocket({ path: instancePath(input.instanceId, "/terminal"), query })
      .pipe(Effect.flatMap((socket) => makeCloudflareTerminalTransport(socket)));
  };

  const deleteInstance: CloudflareBridgeClientShape["deleteInstance"] = (instanceId) =>
    connection
      .request({ method: "DELETE", path: instancePath(instanceId) })
      .pipe(Effect.flatMap((response) => expectOk("deleteInstance", response)));

  return {
    createInstance,
    getInstance,
    exec,
    readFile,
    writeFile,
    exposePort,
    setNetworkPolicy,
    renewActivity,
    openTerminal,
    deleteInstance,
  } satisfies CloudflareBridgeClientShape;
});

/** Best-effort human description of a bridge error body for an error detail. */
const describeErrorBody = (json: unknown): string => {
  if (json !== null && typeof json === "object" && "error" in json) {
    const error = (json as { readonly error?: unknown }).error;
    const detail = (json as { readonly detail?: unknown }).detail;
    const base = typeof error === "string" ? error : "bridge_error";
    return typeof detail === "string" && detail.length > 0 ? `${base}: ${detail}` : base;
  }
  return "bridge_error";
};

export const CloudflareBridgeClientLive = Layer.effect(
  CloudflareBridgeClient,
  makeCloudflareBridgeClient,
);
