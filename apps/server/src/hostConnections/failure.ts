import { HOST_SESSION_CLOSE_AUTH_FAILED, HOST_SESSION_CLOSE_REVOKED } from "@synara/contracts";
import { WsCompatibilityError, type HostConnectionState } from "@synara/contracts";
import { AccountApiError } from "@synara/shared/account";
import { Schema } from "effect";
import { SessionExpiredError } from "../accountAuth";
import { HostDialError } from "./dialer";

/** A changed or absent durable trust relationship requires an explicit owner action. */
export class RemoteHostTrustError extends Error {}

export function classifyConnectionFailure(error: unknown): HostConnectionState {
  for (let value: unknown = error, depth = 0; value && depth < 6; depth++) {
    if (value instanceof RemoteHostTrustError) return "revoked";
    if (
      value instanceof Error &&
      "code" in value &&
      [
        "CERT_HAS_EXPIRED",
        "CERT_SIGNATURE_FAILURE",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "ERR_TLS_CERT_ALTNAME_INVALID",
      ].includes(String(value.code))
    )
      return "revoked";
    if (
      value instanceof HostDialError &&
      ([HOST_SESSION_CLOSE_AUTH_FAILED, HOST_SESSION_CLOSE_REVOKED] as number[]).includes(
        value.detail.closeCode ?? 0,
      )
    )
      return "revoked";
    if (Schema.is(WsCompatibilityError)(value)) return "incompatible";
    if (value instanceof SessionExpiredError) return "needs-sign-in";
    if (value instanceof AccountApiError) {
      if (
        value.code === "device_not_registered" ||
        value.code === "device_revoked" ||
        value.code === "not_host_owner"
      )
        return "revoked";
      if (value.status === 401) return "needs-sign-in";
    }
    value = value instanceof Error ? value.cause : undefined;
  }
  // Published routes can disappear temporarily while the host or connector restarts.
  return "reconnecting";
}
