/**
 * HTTP route for the Synara agent gateway MCP endpoint.
 *
 * Registers `POST /mcp` (streamable-HTTP MCP, stateless JSON responses) plus
 * spec-mandated method handling for GET/DELETE. Authentication is a
 * per-session bearer token minted by AgentGatewayCredentials and injected into
 * provider sessions; the global server auth stack is deliberately not used
 * here because provider child processes have no session cookies.
 *
 * @module agentGateway/httpRoute
 */
import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AGENT_GATEWAY_MCP_PATH } from "./Layers/AgentGatewayCredentials";
import { AgentGateway } from "./Services/AgentGateway";
import { AgentGatewayCredentials } from "./Services/AgentGatewayCredentials";
import { extractBearerToken } from "./bearerToken.ts";

export const AGENT_GATEWAY_MCP_MAX_BODY_BYTES = 1024 * 1024;

const BODY_TOO_LARGE = Symbol("AgentGatewayMcpBodyTooLarge");

export type McpBodyReadResult =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" };

export function readMcpJsonBody(
  request: HttpServerRequest.HttpServerRequest,
  maxBytes = AGENT_GATEWAY_MCP_MAX_BODY_BYTES,
): Effect.Effect<McpBodyReadResult> {
  const declaredLength = Number.parseInt(request.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return Effect.succeed({ kind: "too-large" });
  }

  return request.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Buffer[], totalBytes: 0 }),
      (state, chunk) => {
        const totalBytes = state.totalBytes + chunk.byteLength;
        if (totalBytes > maxBytes) {
          return Effect.fail(BODY_TOO_LARGE);
        }
        state.chunks.push(Buffer.from(chunk));
        return Effect.succeed({ chunks: state.chunks, totalBytes });
      },
    ),
    Effect.flatMap(({ chunks, totalBytes }) =>
      Effect.try({
        try: () => ({
          kind: "ok" as const,
          body: JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown,
        }),
        catch: () => new Error("Invalid JSON body."),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed<McpBodyReadResult>(
        error === BODY_TOO_LARGE ? { kind: "too-large" } : { kind: "invalid" },
      ),
    ),
  );
}

function unauthorizedResponse() {
  return HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message:
          "caller_session_inactive: Missing, revoked, or invalid provider-session credential.",
      },
    },
    { status: 401 },
  );
}

const postRouteLayer = HttpRouter.add(
  "POST",
  AGENT_GATEWAY_MCP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const gateway = yield* AgentGateway;
    const credentials = yield* AgentGatewayCredentials;
    const token = extractBearerToken(request.headers.authorization);
    if (!token || credentials.verifySession(token) === null) {
      return unauthorizedResponse();
    }

    const bodyResult = yield* readMcpJsonBody(request);
    if (bodyResult.kind === "too-large") {
      return HttpServerResponse.jsonUnsafe(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request body exceeds the 1 MiB limit." },
        },
        { status: 413 },
      );
    }
    if (bodyResult.kind === "invalid") {
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON body." } },
        { status: 400 },
      );
    }
    const result = yield* gateway.handleMcpPost({
      authorizationHeader: request.headers.authorization,
      body: bodyResult.body,
    });
    if (result.body === undefined) {
      return HttpServerResponse.empty({ status: result.status });
    }
    return HttpServerResponse.jsonUnsafe(result.body, { status: result.status });
  }),
);

// The streamable-HTTP transport allows servers to reject GET (no
// server-initiated stream) with 405; DELETE is session teardown, and this
// server is stateless, so both are explicit non-endpoints.
const getRouteLayer = HttpRouter.add(
  "GET",
  AGENT_GATEWAY_MCP_PATH,
  Effect.succeed(
    HttpServerResponse.text("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    }),
  ),
);

const deleteRouteLayer = HttpRouter.add(
  "DELETE",
  AGENT_GATEWAY_MCP_PATH,
  Effect.succeed(HttpServerResponse.empty({ status: 405 })),
);

export const agentGatewayRouteLayer = Layer.mergeAll(
  postRouteLayer,
  getRouteLayer,
  deleteRouteLayer,
);
