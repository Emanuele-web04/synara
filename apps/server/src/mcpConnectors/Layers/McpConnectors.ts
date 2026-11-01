/**
 * McpConnectorsLive - Connectors backed by the server secret store.
 *
 * The whole connector document (names, URLs, OAuth tokens) is one secret-store
 * entry: a 0600 file in this app's data home. Connected connectors are handed
 * to AgentGatewayCredentials so new provider sessions receive their proxies.
 *
 * @module mcpConnectors/Layers/McpConnectors
 */
import { MCP_CONNECTORS_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { Effect, Layer } from "effect";

import { version } from "../../../package.json" with { type: "json" };
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { createLogger } from "../../logger.ts";
import { jsonRpcErrorResult } from "../proxy.ts";
import { McpConnectorFailure, McpConnectorRuntime } from "../runtime.ts";
import {
  McpConnectorError,
  McpConnectors,
  type McpConnectorsShape,
} from "../Services/McpConnectors.ts";

export const MCP_CONNECTORS_SECRET_NAME = "mcp-connectors";
const log = createLogger("mcp-connectors");
export const MCP_CONNECTOR_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";

/** The redirect URL on the port this server listens on (the gateway's origin). */
export function mcpConnectorRedirectUrl(mcpEndpointUrl: string): string {
  return `${new URL(mcpEndpointUrl).origin}${MCP_CONNECTOR_OAUTH_CALLBACK_PATH}`;
}

const toConnectorError = (fallback: string) => (cause: unknown) =>
  new McpConnectorError({
    message: cause instanceof McpConnectorFailure ? cause.message : fallback,
    ...(cause instanceof McpConnectorFailure && cause.code ? { code: cause.code } : {}),
    cause,
  });

export const makeMcpConnectors = (options: { readonly enabled?: boolean } = {}) =>
  Effect.gen(function* () {
    const enabled = options.enabled ?? isServerBetaFeatureEnabled(MCP_CONNECTORS_BETA_FEATURE);
    const secretStore = yield* ServerSecretStore;
    const credentials = yield* AgentGatewayCredentials;

    const runtime = new McpConnectorRuntime({
      load: () =>
        Effect.runPromise(
          secretStore
            .get(MCP_CONNECTORS_SECRET_NAME)
            .pipe(Effect.map((bytes) => (bytes ? new TextDecoder().decode(bytes) : null))),
        ),
      save: (document) =>
        Effect.runPromise(
          secretStore.set(MCP_CONNECTORS_SECRET_NAME, new TextEncoder().encode(document)),
        ),
      redirectUrl: () => mcpConnectorRedirectUrl(credentials.mcpEndpointUrl),
      publish: (registrations) => credentials.setConnectorServers?.(registrations),
      clientVersion: version,
      logWarning: (message, fields) => log.warn(message, fields),
    });
    // Restore only this app's connector document; Stable and Beta have separate homes.
    if (enabled) yield* Effect.promise(() => runtime.init());

    const unavailable = Effect.fail(
      new McpConnectorError({ message: "Connectors are unavailable on this server." }),
    );

    return {
      enabled,
      list: () => (enabled ? Effect.sync(() => runtime.list()) : unavailable),
      connect: (input) =>
        enabled
          ? Effect.tryPromise({
              try: () => runtime.connect(input),
              catch: toConnectorError("Synara could not connect this server."),
            })
          : unavailable,
      setup: () =>
        enabled
          ? Effect.sync(() => ({
              redirectUrl: mcpConnectorRedirectUrl(credentials.mcpEndpointUrl),
            }))
          : unavailable,
      disconnect: (connectorId) =>
        enabled
          ? Effect.tryPromise({
              try: () => runtime.disconnect(connectorId),
              catch: toConnectorError("Synara could not disconnect this server."),
            })
          : unavailable,
      completeAuthorization: (query) =>
        enabled
          ? Effect.tryPromise(() => runtime.completeAuthorization(query)).pipe(
              Effect.catch(() =>
                Effect.succeed({
                  ok: false as const,
                  title: "Connection failed",
                  message: "Synara could not finish the sign-in. Try connecting again.",
                }),
              ),
            )
          : Effect.succeed({
              ok: false as const,
              title: "Connectors are unavailable",
              message: "This version of Synara does not support connectors.",
            }),
      forward: (connectorId, request) =>
        Effect.tryPromise((signal) => runtime.forward(connectorId, { ...request, signal })).pipe(
          Effect.catch(() =>
            Effect.succeed(
              jsonRpcErrorResult(request.body, "Synara could not forward this request."),
            ),
          ),
        ),
    } satisfies McpConnectorsShape;
  });

export const McpConnectorsLive = Layer.effect(McpConnectors, makeMcpConnectors());
