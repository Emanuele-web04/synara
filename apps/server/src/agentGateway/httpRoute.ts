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
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AGENT_GATEWAY_MCP_PATH } from "./Layers/AgentGatewayCredentials";
import { AgentGateway } from "./Services/AgentGateway";

const postRouteLayer = HttpRouter.add(
  "POST",
  AGENT_GATEWAY_MCP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const gateway = yield* AgentGateway;
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    if (body === null) {
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON body." } },
        { status: 400 },
      );
    }
    const result = yield* gateway.handleMcpPost({
      authorizationHeader: request.headers.authorization,
      body,
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
