import { randomUUID } from "node:crypto";

import {
  WS_COMPATIBILITY_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_SERVER_CAPABILITIES,
  WsCompatibilityError,
  type WsBootstrapNegotiateInput,
  type WsBootstrapNegotiateResult,
  type WsCompatibilityAction,
} from "@synara/contracts";
import { Effect } from "effect";

import { version as serverBuild } from "../package.json" with { type: "json" };

const serverInstanceId = randomUUID();

function incompatibility(
  action: WsCompatibilityAction,
  message: string,
  code: WsCompatibilityError["code"] = "WS_PROTOCOL_INCOMPATIBLE",
): WsCompatibilityError {
  return new WsCompatibilityError({
    message,
    code,
    retryable: false,
    action,
    serverBuild,
    protocolEpoch: WS_PROTOCOL_EPOCH,
    minRevision: WS_PROTOCOL_MIN_REVISION,
    maxRevision: WS_PROTOCOL_MAX_REVISION,
  });
}

export function negotiateWsCompatibility(
  input: WsBootstrapNegotiateInput,
): Effect.Effect<WsBootstrapNegotiateResult, WsCompatibilityError> {
  if (input.minRevision > input.maxRevision) {
    return Effect.fail(
      incompatibility("reload", "The client sent an invalid WebSocket protocol range."),
    );
  }
  if (input.protocolEpoch !== WS_PROTOCOL_EPOCH) {
    return Effect.fail(
      incompatibility(
        input.protocolEpoch < WS_PROTOCOL_EPOCH ? "update-client" : "update-server",
        `WebSocket protocol epoch ${input.protocolEpoch} is incompatible with server epoch ${WS_PROTOCOL_EPOCH}.`,
      ),
    );
  }

  const lowestCompatibleRevision = Math.max(input.minRevision, WS_PROTOCOL_MIN_REVISION);
  const negotiatedRevision = Math.min(input.maxRevision, WS_PROTOCOL_MAX_REVISION);
  if (negotiatedRevision < lowestCompatibleRevision) {
    return Effect.fail(
      incompatibility(
        input.maxRevision < WS_PROTOCOL_MIN_REVISION ? "update-client" : "update-server",
        `WebSocket protocol revisions ${input.minRevision}-${input.maxRevision} do not overlap server revisions ${WS_PROTOCOL_MIN_REVISION}-${WS_PROTOCOL_MAX_REVISION}.`,
      ),
    );
  }

  const missingCapabilities = input.requiredCapabilities.filter(
    (capability) => !WS_SERVER_CAPABILITIES.some((supported) => supported === capability),
  );
  if (missingCapabilities.length > 0) {
    return Effect.fail(
      incompatibility(
        "update-server",
        `The server is missing required WebSocket capabilities: ${missingCapabilities.join(", ")}.`,
        "WS_CAPABILITIES_INCOMPATIBLE",
      ),
    );
  }

  return Effect.succeed({
    protocolEpoch: WS_PROTOCOL_EPOCH,
    negotiatedRevision,
    serverBuild,
    serverInstanceId,
    capabilities: [...WS_SERVER_CAPABILITIES],
  });
}

export function validateWsFeatureCompatibility(
  searchParams: URLSearchParams,
): WsCompatibilityError | null {
  const epoch = Number(searchParams.get(WS_COMPATIBILITY_QUERY.protocolEpoch));
  const revision = Number(searchParams.get(WS_COMPATIBILITY_QUERY.protocolRevision));
  const clientBuild = searchParams.get(WS_COMPATIBILITY_QUERY.clientBuild)?.trim() ?? "";
  const expectedServerInstanceId =
    searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)?.trim() ?? "";
  if (!Number.isSafeInteger(epoch) || epoch !== WS_PROTOCOL_EPOCH) {
    return incompatibility(
      "reload",
      "Feature RPC rejected before compatible WebSocket protocol negotiation.",
      "WS_NEGOTIATION_REQUIRED",
    );
  }
  if (
    !Number.isSafeInteger(revision) ||
    revision < WS_PROTOCOL_MIN_REVISION ||
    revision > WS_PROTOCOL_MAX_REVISION
  ) {
    return incompatibility(
      revision < WS_PROTOCOL_MIN_REVISION ? "update-client" : "update-server",
      "Feature RPC rejected because its negotiated protocol revision is unsupported.",
    );
  }
  if (clientBuild.length === 0) {
    return incompatibility(
      "reload",
      "Feature RPC rejected because the client build identity is missing.",
      "WS_NEGOTIATION_REQUIRED",
    );
  }
  if (expectedServerInstanceId !== serverInstanceId) {
    return incompatibility(
      "reload",
      "The Synara server restarted during WebSocket negotiation. Reload to reconnect to the new server generation.",
      "WS_SERVER_GENERATION_CHANGED",
    );
  }
  return null;
}

export function makeCurrentWsFeatureCompatibilitySearchParams(
  clientBuild: string,
): URLSearchParams {
  return new URLSearchParams({
    [WS_COMPATIBILITY_QUERY.clientBuild]: clientBuild,
    [WS_COMPATIBILITY_QUERY.protocolEpoch]: String(WS_PROTOCOL_EPOCH),
    [WS_COMPATIBILITY_QUERY.protocolRevision]: String(WS_PROTOCOL_MAX_REVISION),
    [WS_COMPATIBILITY_QUERY.serverInstanceId]: serverInstanceId,
  });
}
