import { createHash } from "node:crypto";
import { ServiceMap } from "effect";

export type ManagedAttachmentPrincipal =
  | { readonly ownerKind: "session"; readonly ownerId: string }
  | { readonly ownerKind: "local-loopback"; readonly ownerId: "local-loopback" };

export const LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL: ManagedAttachmentPrincipal = {
  ownerKind: "local-loopback",
  ownerId: "local-loopback",
};

/**
 * Request-scoped identity used only for managed binary staging and claim.
 * It is inherited by RPC handler fibers and never enters public commands or
 * persisted orchestration events.
 */
export const CurrentManagedAttachmentPrincipal = ServiceMap.Reference<ManagedAttachmentPrincipal>(
  "synara/attachments/CurrentManagedAttachmentPrincipal",
  { defaultValue: () => LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL },
);

export function attachmentPrincipalForSession(sessionId: string): ManagedAttachmentPrincipal {
  return { ownerKind: "session", ownerId: remoteAttachmentSessions.get(sessionId) ?? sessionId };
}

// Only server-issued client leases enter this map. Public session subjects and
// attachment metadata cannot select another device's staging principal.
const remoteAttachmentSessions = new Map<string, string>();
export function bindRemoteAttachmentSession(
  sessionId: string,
  scope: {
    readonly environmentId: string;
    readonly rootFingerprint: string;
    readonly userId: string;
    readonly deviceJkt: string;
    readonly trustGeneration: number;
  },
): () => void {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        scope.environmentId,
        scope.rootFingerprint,
        scope.userId,
        scope.deviceJkt,
        scope.trustGeneration,
      ]),
    )
    .digest("hex");
  remoteAttachmentSessions.set(sessionId, `remote-device:${digest}`);
  return () => {
    remoteAttachmentSessions.delete(sessionId);
  };
}
