/**
 * RuntimeProviderDescriptor - Server-internal capability model for an execution
 * runtime provider.
 *
 * Kept off `packages/contracts` on purpose: this is the rich adapter capability
 * surface the planner validates against. A slimmed subset is promoted to the
 * public contract only when the UI needs it. The planner reads these
 * capabilities to reject unsupported `RuntimePlan`/`RuntimeRole` combinations
 * before any provisioning happens.
 *
 * @module RuntimeProviderDescriptor
 */
import type {
  ExecutionRuntimeProvider,
  ExecutionTargetKind,
  RuntimeRole,
} from "@t3tools/contracts";

import type { FakeRuntimeFlavor } from "./FakeRuntimeFlavor.ts";

/** Lifecycle operations a provider supports beyond create/destroy. */
export interface RuntimeLifecycleCapabilities {
  readonly stop: boolean;
  readonly snapshot: boolean;
  readonly archive: boolean;
  /** Provider can reconnect/getStatus after a server restart (reconciler). */
  readonly reconnect: boolean;
}

/** How processes run inside an instance. */
export interface RuntimeExecCapabilities {
  /** Long-lived interactive PTY (vs. fire-and-collect command exec). */
  readonly pty: boolean;
  /** Discrete command execution with collected output. */
  readonly command: boolean;
  /** Roles the provider can host (e.g. local cannot host a remote `git` role). */
  readonly roles: ReadonlyArray<RuntimeRole>;
}

/** Filesystem characteristics. */
export interface RuntimeFsCapabilities {
  /** Persistent FS across restarts (vs. ephemeral unless snapshotted). */
  readonly persistent: boolean;
  readonly writable: boolean;
}

/** Git workspace support via the runtime-neutral `RuntimeGitWorkspace`. */
export interface RuntimeGitCapabilities {
  readonly clone: boolean;
  readonly diff: boolean;
}

/** Inbound routing (preview URLs / exposed ports). */
export interface RuntimeIngressCapabilities {
  readonly exposePort: boolean;
  /** Ports must be declared at create time (Vercel) vs. exposed on demand. */
  readonly declarePortsAtCreate: boolean;
  readonly maxRoutes: number | null;
}

/** Persistence / snapshot characteristics. */
export interface RuntimePersistenceCapabilities {
  readonly snapshots: boolean;
  readonly volumes: boolean;
}

/** Outbound network policy. */
export interface RuntimeNetworkCapabilities {
  readonly egress: boolean;
  readonly outboundProxy: boolean;
}

/** Activity-lease support (keepalive while work is in flight). */
export interface RuntimeLeaseCapabilities {
  readonly required: boolean;
  readonly renewable: boolean;
}

/**
 * Provider-specific behavior the planner and adapters must account for. Plain
 * booleans rather than provider-id checks so the orchestration seam never needs
 * to know which concrete provider it is talking to.
 */
export interface RuntimeQuirkCapabilities {
  /** Has no stderr side channel (remote); error surfacing needs an alternative. */
  readonly noStderrChannel: boolean;
  /** Has no addressable process id (remote); local kill semantics do not apply. */
  readonly noProcessId: boolean;
  readonly ephemeralUnlessSnapshotted: boolean;
}

export interface RuntimeProviderCapabilities {
  readonly lifecycle: RuntimeLifecycleCapabilities;
  readonly exec: RuntimeExecCapabilities;
  readonly fs: RuntimeFsCapabilities;
  readonly git: RuntimeGitCapabilities;
  readonly ingress: RuntimeIngressCapabilities;
  readonly persistence: RuntimePersistenceCapabilities;
  readonly network: RuntimeNetworkCapabilities;
  readonly lease: RuntimeLeaseCapabilities;
  readonly quirks: RuntimeQuirkCapabilities;
}

/**
 * Static description of one execution-runtime provider: which target kinds it
 * backs and the capabilities it honestly supports.
 */
export interface RuntimeProviderDescriptor {
  readonly provider: ExecutionRuntimeProvider;
  /**
   * Server-internal sub-kind for the `fake` family. The registry keys lookups by
   * flavor so each fake reports its own honest capabilities while persisting
   * under the single public `fake` provider literal.
   */
  readonly flavor?: FakeRuntimeFlavor;
  /** Target kinds this provider can back (e.g. `local` backs only `local`). */
  readonly targetKinds: ReadonlyArray<ExecutionTargetKind>;
  readonly capabilities: RuntimeProviderCapabilities;
}
