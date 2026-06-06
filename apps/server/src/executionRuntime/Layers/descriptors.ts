/**
 * Built-in execution-runtime provider descriptors.
 *
 * `local` and `worktree` are the compatibility targets that reproduce current
 * behavior: a process on this host's filesystem, no remote lifecycle, no
 * ingress, no leases. Remote provider descriptors (Daytona, Vercel, Modal,
 * Cloudflare) land with their adapters in later slices.
 *
 * @module descriptors
 */
import type { ExecutionRuntimeProvider } from "@t3tools/contracts";

import type { RuntimeProviderDescriptor } from "../Services/RuntimeProviderDescriptor.ts";

const localFamilyDescriptor = (
  provider: Extract<ExecutionRuntimeProvider, "local" | "worktree">,
): RuntimeProviderDescriptor => ({
  provider,
  targetKinds: [provider],
  capabilities: {
    lifecycle: { stop: true, snapshot: false, archive: false, reconnect: false },
    exec: { pty: false, command: true, roles: ["agent", "setup", "git", "exec", "terminal"] },
    fs: { persistent: true, writable: true },
    git: { clone: false, diff: true },
    ingress: { exposePort: false, declarePortsAtCreate: false, maxRoutes: 0 },
    persistence: { snapshots: false, volumes: false },
    network: { egress: true, outboundProxy: false },
    lease: { required: false, renewable: false },
    quirks: {
      noStderrChannel: false,
      noProcessId: false,
      ephemeralUnlessSnapshotted: false,
    },
  },
});

export const BUILT_IN_RUNTIME_DESCRIPTORS: ReadonlyArray<RuntimeProviderDescriptor> = [
  localFamilyDescriptor("local"),
  localFamilyDescriptor("worktree"),
];
