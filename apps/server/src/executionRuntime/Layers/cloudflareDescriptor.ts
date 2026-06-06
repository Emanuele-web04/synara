/**
 * Cloudflare execution-runtime provider descriptor.
 *
 * Describes what the Cloudflare Runtime Bridge honestly supports for the default
 * `workspace` flavor: command exec and an interactive terminal, on-demand port
 * exposure, ephemeral (snapshot-less) filesystem, outbound proxy, and renewable
 * activity leases. It backs `remote-runtime`. The planner validates a
 * `RuntimePlan` against this before any bridge call.
 *
 * Raw Containers are a separate, lower-level service runtime exposed by the
 * bridge's `container` flavor (declared ports, no interactive terminal); they
 * are intentionally NOT the default workspace and are not described here as the
 * default Cloudflare provider capability set.
 *
 * @module cloudflareDescriptor
 */
import type { RuntimeProviderDescriptor } from "../Services/RuntimeProviderDescriptor.ts";

export const CLOUDFLARE_RUNTIME_DESCRIPTOR: RuntimeProviderDescriptor = {
  provider: "cloudflare",
  targetKinds: ["remote-runtime"],
  capabilities: {
    lifecycle: { stop: true, snapshot: false, archive: false, reconnect: true },
    exec: { pty: true, command: true, roles: ["agent", "setup", "git", "exec", "terminal"] },
    fs: { persistent: false, writable: true },
    git: { clone: true, diff: true },
    ingress: { exposePort: true, declarePortsAtCreate: false, maxRoutes: null },
    persistence: { snapshots: false, volumes: false },
    network: { egress: true, outboundProxy: true },
    lease: { required: true, renewable: true },
    quirks: { noStderrChannel: false, noProcessId: true, ephemeralUnlessSnapshotted: true },
  },
};
