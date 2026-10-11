import { Effect } from "effect";

import type {
  ExternalMcpServiceShape,
  ExternalMcpVerifiedClient,
} from "./Services/ExternalMcpService.ts";

export type ExternalMcpCredentialVerification =
  | { readonly kind: "verified"; readonly client: ExternalMcpVerifiedClient }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

export const verifyExternalMcpTransportCredential = (
  service: Pick<ExternalMcpServiceShape, "verifyCredential">,
  credential: string,
): Effect.Effect<ExternalMcpCredentialVerification> =>
  service.verifyCredential(credential).pipe(
    Effect.map((client) => ({ kind: "verified" as const, client })),
    Effect.catch((error) =>
      Effect.succeed({
        kind: error.code === "external_credential_invalid" ? "invalid" : "unavailable",
      } as const),
    ),
  );
