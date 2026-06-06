/**
 * RuntimeCredentialBroker - Server-internal boundary for handing scoped
 * credentials to a runtime instance (env-var, provider-secret, mounted-file,
 * ssh-agent, git-credential-helper, outbound-proxy, worker-broker).
 *
 * Raw tokens are never persisted in runtime metadata and never logged in
 * tokenized clone URLs. Setup processes receive fewer secrets than agent
 * processes; snapshots taken with secrets present are flagged secret-tainted.
 *
 * @module RuntimeCredentialBroker
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { RuntimeRole } from "@t3tools/contracts";

export const RUNTIME_CREDENTIAL_KINDS = [
  "env-var",
  "provider-secret",
  "mounted-file",
  "ssh-agent",
  "git-credential-helper",
  "outbound-proxy",
  "worker-broker",
] as const;

export type RuntimeCredentialKind = (typeof RUNTIME_CREDENTIAL_KINDS)[number];

export interface RuntimeCredentialGrant {
  readonly kind: RuntimeCredentialKind;
  /** Opaque handle; never the raw token. */
  readonly handle: string;
  readonly secretTainted: boolean;
}

export interface RuntimeCredentialRequest {
  readonly role: RuntimeRole;
  readonly kinds: ReadonlyArray<RuntimeCredentialKind>;
}

export interface RuntimeCredentialBrokerShape {
  /** Resolve credential grants for a role, scoped to the role's needs. */
  readonly grantFor: (
    request: RuntimeCredentialRequest,
  ) => Effect.Effect<ReadonlyArray<RuntimeCredentialGrant>>;
}

export class RuntimeCredentialBroker extends ServiceMap.Service<
  RuntimeCredentialBroker,
  RuntimeCredentialBrokerShape
>()("t3/executionRuntime/Services/RuntimeCredentialBroker") {}
