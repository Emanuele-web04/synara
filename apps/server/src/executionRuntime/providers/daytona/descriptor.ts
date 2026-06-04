/**
 * Daytona runtime provider descriptor.
 *
 * Daytona is the first real remote provider: a persistent, snapshot-capable
 * sandbox that hosts a long-lived `codex app-server` over its exec channel,
 * clones a repo, exposes preview ports on demand, and survives a server restart
 * (the sandbox id is durable, so the reconciler can re-attach via `getStatus`).
 *
 * Capabilities are declared honestly so the planner rejects unsupported
 * plan/role combinations *before* a sandbox is ever created:
 *
 *   - lifecycle: stop/archive/snapshot supported; reconnect supported (durable id).
 *   - exec: a long-lived session command stands in for a PTY, plus fire-and-collect
 *     command exec; it hosts every runtime role.
 *   - fs: persistent and writable across stop/start.
 *   - git: clone + diff over the exec channel (runtime-neutral git v1).
 *   - ingress: ports exposed on demand (not declared at create), no fixed cap.
 *   - persistence: snapshots + volumes.
 *   - network: egress on; no built-in outbound proxy.
 *   - lease: required + renewable — a sandbox auto-stops when idle, so a turn
 *     keeps it alive via the activity lease (Daytona's keepalive shape).
 *   - quirks: no addressable host pid (remote), and FS persists without a snapshot.
 *
 * @module daytona/descriptor
 */
import type { RuntimeProviderDescriptor } from "../../Services/RuntimeProviderDescriptor.ts";

export const DAYTONA_RUNTIME_DESCRIPTOR: RuntimeProviderDescriptor = {
  provider: "daytona",
  targetKinds: ["remote-runtime"],
  capabilities: {
    lifecycle: { stop: true, snapshot: true, archive: true, reconnect: true },
    exec: { pty: true, command: true, roles: ["agent", "setup", "git", "exec", "terminal"] },
    fs: { persistent: true, writable: true },
    git: { clone: true, diff: true },
    ingress: { exposePort: true, declarePortsAtCreate: false, maxRoutes: null },
    persistence: { snapshots: true, volumes: true },
    network: { egress: true, outboundProxy: false },
    lease: { required: true, renewable: true },
    quirks: {
      noStderrChannel: false,
      noProcessId: true,
      ephemeralUnlessSnapshotted: false,
    },
  },
};
