import {
  ExternalMcpCreateIntegrationInput,
  ExternalMcpPairInput,
  ExternalMcpRefreshPairingInput,
  ExternalMcpRevokeIntegrationInput,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { readMcpJsonBody } from "../agentGateway/httpRoute.ts";
import { extractBearerToken } from "../agentGateway/bearerToken.ts";
import { makeEffectAuthRequest } from "../auth/effectHttp.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { isLoopbackHost } from "../startupAccess.ts";
import { ExternalMcpGateway } from "./Services/ExternalMcpGateway.ts";
import { ExternalMcpService } from "./Services/ExternalMcpService.ts";
import { computeExternalMcpRuntimeProof, externalMcpRuntimeSecret } from "./runtimeProof.ts";

export const EXTERNAL_MCP_PATH = "/mcp/external";
export const EXTERNAL_MCP_MAX_BODY_BYTES = 256 * 1024;
const MANAGEMENT_MAX_BODY_BYTES = 32 * 1024;

const decodeCreateIntegration = Schema.decodeUnknownEffect(ExternalMcpCreateIntegrationInput);
const decodeRevokeIntegration = Schema.decodeUnknownEffect(ExternalMcpRevokeIntegrationInput);
const decodePair = Schema.decodeUnknownEffect(ExternalMcpPairInput);
const decodeRefreshPairing = Schema.decodeUnknownEffect(ExternalMcpRefreshPairingInput);
const decodeRuntimeChallenge = Schema.decodeUnknownEffect(
  Schema.Struct({
    nonce: Schema.String.check(Schema.isMinLength(24)).check(Schema.isMaxLength(128)),
  }),
);

const localExternalMcpEnabled = Effect.gen(function* () {
  const config = yield* ServerConfig;
  return isLoopbackHost(config.host) && config.publicUrl === undefined;
});

const disabledResponse = () =>
  HttpServerResponse.jsonUnsafe(
    { error: "External MCP is available only from a loopback-only Synara instance." },
    { status: 404 },
  );

const externalUnauthorized = () =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message:
          "external_credential_invalid: Missing, expired, revoked, or invalid external MCP credential.",
      },
    },
    { status: 401 },
  );

const postExternalMcp = HttpRouter.add(
  "POST",
  EXTERNAL_MCP_PATH,
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    const request = yield* HttpServerRequest.HttpServerRequest;
    const externalMcp = yield* ExternalMcpService;
    const gateway = yield* ExternalMcpGateway;
    const token = extractBearerToken(request.headers.authorization);
    const client = token
      ? yield* externalMcp.verifyCredential(token).pipe(Effect.option)
      : Option.none();
    if (Option.isNone(client)) {
      return externalUnauthorized();
    }
    const body = yield* readMcpJsonBody(request, EXTERNAL_MCP_MAX_BODY_BYTES);
    if (body.kind === "too-large") {
      return HttpServerResponse.jsonUnsafe(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request body exceeds the 256 KiB limit." },
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
    const result = yield* gateway.handleVerifiedPost({
      client: client.value,
      body: body.body,
    });
    return result.body === undefined
      ? HttpServerResponse.empty({ status: result.status })
      : HttpServerResponse.jsonUnsafe(result.body, { status: result.status });
  }),
);

const externalMethodNotAllowed = (method: "GET" | "DELETE") =>
  HttpRouter.add(
    method,
    EXTERNAL_MCP_PATH,
    Effect.gen(function* () {
      if (!(yield* localExternalMcpEnabled)) return disabledResponse();
      return HttpServerResponse.text("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }),
  );

const requireOwner = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
  if (session.role !== "owner") {
    return yield* Effect.fail({ message: "Owner session required.", status: 403 as const });
  }
});

const managementError = (error: unknown) => {
  const value = error as { readonly message?: string; readonly status?: number };
  return HttpServerResponse.jsonUnsafe(
    { error: value.message ?? "External MCP management request failed." },
    { status: value.status ?? 500 },
  );
};

const readManagementBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* readMcpJsonBody(request, MANAGEMENT_MAX_BODY_BYTES);
  if (body.kind === "too-large") {
    return yield* Effect.fail({ message: "Request body too large.", status: 413 as const });
  }
  if (body.kind === "invalid") {
    return yield* Effect.fail({ message: "Invalid JSON body.", status: 400 as const });
  }
  return body.body;
});

const listIntegrations = HttpRouter.add(
  "GET",
  "/api/mcp/external/integrations",
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    yield* requireOwner;
    const externalMcp = yield* ExternalMcpService;
    return HttpServerResponse.jsonUnsafe(yield* externalMcp.listIntegrations());
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

const createIntegration = HttpRouter.add(
  "POST",
  "/api/mcp/external/integrations",
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    yield* requireOwner;
    const externalMcp = yield* ExternalMcpService;
    const input = yield* decodeCreateIntegration(yield* readManagementBody).pipe(
      Effect.mapError(() => ({ message: "Invalid integration request.", status: 400 as const })),
    );
    return HttpServerResponse.jsonUnsafe(yield* externalMcp.createIntegration(input));
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

const revokeIntegration = HttpRouter.add(
  "POST",
  "/api/mcp/external/integrations/revoke",
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    yield* requireOwner;
    const externalMcp = yield* ExternalMcpService;
    const input = yield* decodeRevokeIntegration(yield* readManagementBody).pipe(
      Effect.mapError(() => ({ message: "Invalid revoke request.", status: 400 as const })),
    );
    return HttpServerResponse.jsonUnsafe({
      revoked: yield* externalMcp.revokeIntegration(input.integrationId),
    });
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

const refreshPairing = HttpRouter.add(
  "POST",
  "/api/mcp/external/integrations/pairing",
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    yield* requireOwner;
    const externalMcp = yield* ExternalMcpService;
    const input = yield* decodeRefreshPairing(yield* readManagementBody).pipe(
      Effect.mapError(() => ({
        message: "Invalid refresh-pairing request.",
        status: 400 as const,
      })),
    );
    return HttpServerResponse.jsonUnsafe(yield* externalMcp.refreshPairing(input));
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

const runtimeChallenge = HttpRouter.add(
  "POST",
  "/api/mcp/external/runtime-challenge",
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    const input = yield* decodeRuntimeChallenge(yield* readManagementBody).pipe(
      Effect.mapError(() => ({ message: "Invalid runtime challenge.", status: 400 as const })),
    );
    return HttpServerResponse.jsonUnsafe({
      proof: computeExternalMcpRuntimeProof(externalMcpRuntimeSecret, input.nonce),
    });
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

const pairIntegration = HttpRouter.add(
  "POST",
  "/api/mcp/external/pair",
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    const externalMcp = yield* ExternalMcpService;
    const input = yield* decodePair(yield* readManagementBody).pipe(
      Effect.mapError(() => ({ message: "Invalid pairing request.", status: 400 as const })),
    );
    return HttpServerResponse.jsonUnsafe(
      yield* externalMcp.pair(input.pairingCode, input.credential),
    );
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

export const externalMcpRouteLayer = Layer.mergeAll(
  postExternalMcp,
  externalMethodNotAllowed("GET"),
  externalMethodNotAllowed("DELETE"),
  listIntegrations,
  createIntegration,
  revokeIntegration,
  refreshPairing,
  runtimeChallenge,
  pairIntegration,
);
