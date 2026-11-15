// FILE: wsOwnerOnly.ts
// Purpose: Owner-role admission and account identity filtering for WebSocket RPC.
// Layer: server transport support
//
// Distinct from the external-MCP guard in wsRpc.ts, which additionally
// requires a loopback-only instance: the account RPCs are owner-only on any
// bind — the machine account is owner state on remote hosts too — so the
// check here is the session role and nothing else.

import { type ServerProviderStatus, WsRpcError } from "@synara/contracts";
import { Effect } from "effect";

import { withoutProviderAccountIdentity } from "./provider/providerStatusCache";
import { CurrentWsSessionRole, type WsSessionRole } from "./wsConnectionSessions";

export function isOwnerRole(role: WsSessionRole): boolean {
  return role === "owner";
}

/** Paired clients need provider availability. Sign-in identity belongs to the owner. */
export const projectProviderStatusesForWsSession = (
  statuses: ReadonlyArray<ServerProviderStatus>,
) =>
  Effect.gen(function* () {
    const role = yield* CurrentWsSessionRole;
    return isOwnerRole(role) ? statuses : statuses.map(withoutProviderAccountIdentity);
  });

/**
 * Fails with an authorization `WsRpcError` unless the connection's session
 * role is `owner`. Connections without a registered session keep the
 * conservative default role `client` and are refused.
 */
export const requireOwnerRole: Effect.Effect<void, WsRpcError> = Effect.gen(function* () {
  if (!isOwnerRole(yield* CurrentWsSessionRole)) {
    return yield* Effect.fail(
      new WsRpcError({ message: "Owner authorization is required for this operation." }),
    );
  }
});
