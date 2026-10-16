/**
 * HTTP routes for Connectors (Beta).
 *
 * - `GET /oauth/mcp/callback`: the OAuth redirect target. The browser carries
 *   no Synara session, so the single-use `state` minted with the sign-in is
 *   the only authority here.
 * - `POST|DELETE /mcp/connectors/:connectorId`: the MCP endpoint provider
 *   sessions call, authenticated with the same per-session bearer as `/mcp`.
 *   `GET` answers 405: the gateway offers no standalone SSE stream.
 *
 * @module mcpConnectors/httpRoute
 */
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { readMcpJsonBody } from "../agentGateway/httpRoute.ts";
import { AGENT_GATEWAY_CONNECTORS_PATH } from "../agentGateway/Layers/AgentGatewayCredentials.ts";
import { AgentGatewayCredentials } from "../agentGateway/Services/AgentGatewayCredentials.ts";
import { extractBearerToken } from "../agentGateway/bearerToken.ts";
import { MCP_CONNECTOR_OAUTH_CALLBACK_PATH } from "./Layers/McpConnectors.ts";
import type { McpConnectorProxyResult } from "./proxy.ts";
import type { McpConnectorCallbackOutcome } from "./runtime.ts";
import { McpConnectors } from "./Services/McpConnectors.ts";

const CONNECTOR_ROUTE = `${AGENT_GATEWAY_CONNECTORS_PATH}/:connectorId`;

const notFound = () => HttpServerResponse.text("Not Found", { status: 404 });

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderConnectorCallbackPage(outcome: McpConnectorCallbackOutcome): string {
  const title = outcome.ok ? `${outcome.name} is connected` : outcome.title;
  const message = outcome.ok
    ? "You can close this tab and return to Synara."
    : `${outcome.message} You can close this tab.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Synara</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: Canvas; color: CanvasText; }
main { max-width: 420px; padding: 32px; text-align: center; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
p { margin: 0; opacity: 0.7; line-height: 1.5; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>
`;
}

const callbackRoute = HttpRouter.add(
  "GET",
  MCP_CONNECTOR_OAUTH_CALLBACK_PATH,
  Effect.gen(function* () {
    const connectors = yield* McpConnectors;
    if (!connectors.enabled) return notFound();
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });
    const param = (name: string) => url.searchParams.get(name) ?? undefined;
    const outcome = yield* connectors.completeAuthorization({
      state: param("state"),
      code: param("code"),
      error: param("error"),
      errorDescription: param("error_description"),
    });
    return HttpServerResponse.text(renderConnectorCallbackPage(outcome), {
      status: outcome.ok ? 200 : 400,
      contentType: "text/html; charset=utf-8",
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "Referrer-Policy": "no-referrer",
      },
    });
  }),
);

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

function toHttpResponse(result: McpConnectorProxyResult) {
  const headers = result.sessionId ? { "Mcp-Session-Id": result.sessionId } : undefined;
  switch (result.body.kind) {
    case "json":
      return HttpServerResponse.jsonUnsafe(result.body.value, {
        status: result.status,
        ...(headers ? { headers } : {}),
      });
    case "text":
      return HttpServerResponse.text(result.body.value, {
        status: result.status,
        contentType: result.body.contentType,
        ...(headers ? { headers } : {}),
      });
    case "empty":
      return HttpServerResponse.empty({ status: result.status, ...(headers ? { headers } : {}) });
  }
}

/** Resolves the connector id when the feature is on and the bearer is a live session. */
const authorizeConnectorRequest = Effect.gen(function* () {
  const connectors = yield* McpConnectors;
  if (!connectors.enabled) return { kind: "not-found" as const };
  const request = yield* HttpServerRequest.HttpServerRequest;
  const credentials = yield* AgentGatewayCredentials;
  const token = extractBearerToken(request.headers.authorization);
  if (!token || credentials.verifySession(token) === null) {
    return { kind: "unauthorized" as const };
  }
  const { connectorId } = yield* HttpRouter.params;
  // A live bearer only reaches the connectors its session was given.
  if (!connectorId || !(credentials.canUseConnector?.(token, connectorId) ?? false)) {
    return { kind: "not-found" as const };
  }
  return {
    kind: "ok" as const,
    connectors,
    request,
    connectorId,
    sessionId: request.headers["mcp-session-id"],
    protocolVersion: request.headers["mcp-protocol-version"],
  };
});

const postRoute = HttpRouter.add(
  "POST",
  CONNECTOR_ROUTE,
  Effect.gen(function* () {
    const access = yield* authorizeConnectorRequest;
    if (access.kind === "not-found") return notFound();
    if (access.kind === "unauthorized") return unauthorizedResponse();
    const body = yield* readMcpJsonBody(access.request);
    if (body.kind === "too-large") {
      return HttpServerResponse.jsonUnsafe(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request body exceeds the 1 MiB limit." },
        },
        { status: 413 },
      );
    }
    if (body.kind === "invalid") {
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON body." } },
        { status: 400 },
      );
    }
    const result = yield* access.connectors.forward(access.connectorId, {
      method: "POST",
      body: body.body,
      sessionId: access.sessionId,
      protocolVersion: access.protocolVersion,
    });
    return toHttpResponse(result);
  }),
);

const deleteRoute = HttpRouter.add(
  "DELETE",
  CONNECTOR_ROUTE,
  Effect.gen(function* () {
    const access = yield* authorizeConnectorRequest;
    if (access.kind === "not-found") return notFound();
    if (access.kind === "unauthorized") return unauthorizedResponse();
    if (!access.sessionId) return HttpServerResponse.empty({ status: 400 });
    const result = yield* access.connectors.forward(access.connectorId, {
      method: "DELETE",
      sessionId: access.sessionId,
      protocolVersion: access.protocolVersion,
    });
    return HttpServerResponse.empty({ status: result.status === 404 ? 404 : 204 });
  }),
);

const getRoute = HttpRouter.add(
  "GET",
  CONNECTOR_ROUTE,
  Effect.gen(function* () {
    const connectors = yield* McpConnectors;
    if (!connectors.enabled) return notFound();
    return HttpServerResponse.empty({ status: 405, headers: { Allow: "POST, DELETE" } });
  }),
);

export const mcpConnectorsRouteLayer = Layer.mergeAll(
  callbackRoute,
  postRoute,
  deleteRoute,
  getRoute,
);
