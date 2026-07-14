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
export const CurrentManagedAttachmentPrincipal =
  ServiceMap.Reference<ManagedAttachmentPrincipal>(
    "synara/attachments/CurrentManagedAttachmentPrincipal",
    { defaultValue: () => LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL },
  );

export function attachmentPrincipalForSession(sessionId: string): ManagedAttachmentPrincipal {
  return { ownerKind: "session", ownerId: sessionId };
}
