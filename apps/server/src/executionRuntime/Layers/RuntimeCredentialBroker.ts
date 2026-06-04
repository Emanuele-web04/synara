/**
 * RuntimeCredentialBrokerLive - Scoped credential grants for a runtime instance.
 *
 * Hands a runtime *opaque grant handles*, never raw tokens: the handle names a
 * credential source (env-var, mounted-file, ssh-agent, ...) the runtime resolves
 * out-of-band, so no token is ever persisted in runtime metadata or logged. Two
 * scoping rules the plan requires:
 *
 *   - Setup processes get a strict subset of what agent processes get. A setup
 *     command should clone and install, not hold the agent's provider secret;
 *     {@link SETUP_DENIED_KINDS} is filtered out for the `setup` role.
 *   - Any grant that puts a live secret on the instance filesystem/env marks the
 *     instance secret-tainted, so a snapshot taken while it is present is flagged
 *     ({@link SECRET_TAINTING_KINDS}). Handle-only references (ssh-agent,
 *     git-credential-helper, outbound-proxy, worker-broker) do not taint.
 *
 * @module RuntimeCredentialBrokerLive
 */
import { Effect, Layer } from "effect";

import {
  RuntimeCredentialBroker,
  type RuntimeCredentialBrokerShape,
  type RuntimeCredentialGrant,
  type RuntimeCredentialKind,
} from "../Services/RuntimeCredentialBroker.ts";

/**
 * Kinds withheld from the `setup` role. A setup command never receives the
 * agent's provider secret or a raw env-var token; it gets clone/proxy access
 * only. This is the "setup gets fewer secrets than agent" rule.
 */
const SETUP_DENIED_KINDS: ReadonlySet<RuntimeCredentialKind> = new Set([
  "provider-secret",
  "env-var",
]);

/**
 * Kinds that materialize a live secret onto the instance (env value or mounted
 * file). A snapshot taken while one is granted captures the secret, so the grant
 * is flagged secret-tainted. The remaining kinds are out-of-band references that
 * resolve at use time and leave no secret at rest.
 */
const SECRET_TAINTING_KINDS: ReadonlySet<RuntimeCredentialKind> = new Set([
  "env-var",
  "provider-secret",
  "mounted-file",
]);

/**
 * Derive a stable, opaque handle for a (role, kind) pair. Deterministic so the
 * same request resolves the same handle, but carries no secret material — just
 * enough to name the source the runtime resolves later.
 */
const grantHandle = (role: string, kind: RuntimeCredentialKind): string => `cred:${role}:${kind}`;

const makeRuntimeCredentialBroker = Effect.sync(() => {
  const grantFor: RuntimeCredentialBrokerShape["grantFor"] = (request) =>
    Effect.sync(() => {
      const allowed =
        request.role === "setup"
          ? request.kinds.filter((kind) => !SETUP_DENIED_KINDS.has(kind))
          : request.kinds;

      // Deduplicate while preserving request order so a caller asking for the
      // same kind twice gets one grant.
      const seen = new Set<RuntimeCredentialKind>();
      const grants: RuntimeCredentialGrant[] = [];
      for (const kind of allowed) {
        if (seen.has(kind)) {
          continue;
        }
        seen.add(kind);
        grants.push({
          kind,
          handle: grantHandle(request.role, kind),
          secretTainted: SECRET_TAINTING_KINDS.has(kind),
        });
      }
      return grants;
    });

  return { grantFor } satisfies RuntimeCredentialBrokerShape;
});

export const RuntimeCredentialBrokerLive = Layer.effect(
  RuntimeCredentialBroker,
  makeRuntimeCredentialBroker,
);

export { SECRET_TAINTING_KINDS, SETUP_DENIED_KINDS };
