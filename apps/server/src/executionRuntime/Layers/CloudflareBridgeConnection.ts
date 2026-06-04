/**
 * CloudflareBridgeConnectionLive - The real bridge transport.
 *
 * HTTP round-trips go through Effect `HttpClient` with the bearer token attached;
 * the terminal WebSocket is a `ws` socket with the token on the `Authorization`
 * header and `?token=` query (browsers cannot set WS handshake headers, so the
 * query is the fallback the bridge also accepts). Both the base URL and token are
 * read from env via `Config`, so this layer only constructs when the bridge is
 * configured — real provider calls are gated behind credentials.
 *
 * @module CloudflareBridgeConnectionLive
 */
import { Config, Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as NodeWS from "ws";

import { CloudflareBridgeError } from "../Errors.ts";
import {
  CloudflareBridgeConnection,
  type CloudflareBridgeConnectionShape,
  type CloudflareBridgeHttpResponse,
} from "../Services/CloudflareBridgeConnection.ts";
import type { BridgeWebSocket } from "./cloudflareTerminalTransport.ts";

const BridgeEnvConfig = Config.all({
  baseUrl: Config.string("SYNARA_CLOUDFLARE_BRIDGE_URL"),
  token: Config.string("SYNARA_CLOUDFLARE_BRIDGE_TOKEN"),
});

const buildUrl = (
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, string>> | undefined,
): string => {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
};

/** Rebuild an http(s) base URL as ws(s) for the WebSocket handshake. */
const toWebSocketUrl = (httpUrl: string): string =>
  httpUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const makeCloudflareBridgeConnection = Effect.gen(function* () {
  const { baseUrl, token } = yield* BridgeEnvConfig.asEffect();
  const httpClient = yield* HttpClient.HttpClient;

  const request: CloudflareBridgeConnectionShape["request"] = (input) =>
    Effect.gen(function* () {
      const url = buildUrl(baseUrl, input.path, input.query);
      const base = HttpClientRequest.make(input.method)(url).pipe(
        HttpClientRequest.bearerToken(token),
      );
      const withBody =
        input.body === undefined
          ? Effect.succeed(base)
          : HttpClientRequest.bodyJson(base, input.body);

      const response = yield* withBody.pipe(
        Effect.flatMap((req) => httpClient.execute(req)),
        Effect.mapError(
          (error) =>
            new CloudflareBridgeError({
              operation: `${input.method} ${input.path}`,
              status: null,
              detail: redactToken(String(error), token),
            }),
        ),
      );

      // An empty body (e.g. some 204s) decodes as null rather than failing.
      const json = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      return { status: response.status, json } satisfies CloudflareBridgeHttpResponse;
    });

  const connectWebSocket: CloudflareBridgeConnectionShape["connectWebSocket"] = (input) =>
    Effect.callback<BridgeWebSocket, CloudflareBridgeError>((resume) => {
      const httpUrl = buildUrl(baseUrl, input.path, { ...input.query, token });
      const socket = new NodeWS.WebSocket(toWebSocketUrl(httpUrl), {
        headers: { authorization: `Bearer ${token}` },
      });
      const onOpen = () => {
        cleanup();
        resume(Effect.succeed(adaptWebSocket(socket)));
      };
      const onError = (error: Error) => {
        cleanup();
        resume(
          Effect.fail(
            new CloudflareBridgeError({
              operation: `WS ${input.path}`,
              status: null,
              detail: redactToken(error.message, token),
            }),
          ),
        );
      };
      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      socket.on("open", onOpen);
      socket.on("error", onError);
    });

  return { request, connectWebSocket } satisfies CloudflareBridgeConnectionShape;
});

/** Wrap a `ws` socket as the minimal duplex surface the terminal transport drives. */
const adaptWebSocket = (socket: NodeWS.WebSocket): BridgeWebSocket => ({
  send: (data) => socket.send(data),
  close: () => socket.close(),
  onMessage: (handler) => {
    socket.on("message", (data: NodeWS.RawData) => handler(data.toString()));
  },
  onClose: (handler) => {
    socket.on("close", () => handler());
  },
});

const redactToken = (value: string, token: string): string =>
  token.length === 0 ? value : value.split(token).join("***");

export const CloudflareBridgeConnectionLive = Layer.effect(
  CloudflareBridgeConnection,
  makeCloudflareBridgeConnection,
);
