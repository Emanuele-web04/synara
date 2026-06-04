/**
 * Vercel Sandbox runtime descriptor.
 *
 * Vercel Sandbox is a command/log/file/preview-first remote runtime: no
 * long-lived interactive PTY, fire-and-collect (or streaming/detached) command
 * exec, ports declared at create time, and an ephemeral filesystem that only
 * survives via an explicit snapshot. These capabilities are stated honestly so
 * the planner rejects a plan that asks for something the provider cannot do
 * (e.g. a PTY role, or more ports than the sandbox allows) before any
 * provisioning happens.
 *
 * @module vercelSandboxDescriptor
 */
import type { RuntimeProviderDescriptor } from "../../Services/RuntimeProviderDescriptor.ts";

/**
 * Maximum number of ports a single sandbox may declare. Vercel Sandbox declares
 * ports at create time; the planner uses this to reject an over-subscribed plan
 * pre-provision rather than letting the create call fail.
 */
export const VERCEL_SANDBOX_MAX_ROUTES = 8;

export const VERCEL_SANDBOX_DESCRIPTOR: RuntimeProviderDescriptor = {
  provider: "vercel-sandbox",
  targetKinds: ["remote-runtime"],
  capabilities: {
    // Stop and snapshot are supported; there is no separate archive tier. The
    // adapter can reconnect to a live sandbox via its id, so the reconciler can
    // probe status after a server restart.
    lifecycle: { stop: true, snapshot: true, archive: false, reconnect: true },
    // Command/log mode only — no PTY. The agent runs as a streaming/detached
    // command and its stdout/stderr are streamed as logs.
    exec: { pty: false, command: true, roles: ["agent", "setup", "git", "exec"] },
    // The filesystem is ephemeral unless snapshotted (see quirks).
    fs: { persistent: false, writable: true },
    git: { clone: true, diff: true },
    // Ports must be declared at create time and yield public preview URLs.
    ingress: {
      exposePort: true,
      declarePortsAtCreate: true,
      maxRoutes: VERCEL_SANDBOX_MAX_ROUTES,
    },
    // Snapshots are the only way state survives; there are no mounted volumes.
    persistence: { snapshots: true, volumes: false },
    // Egress is allowed; an outbound proxy can scope it.
    network: { egress: true, outboundProxy: true },
    // A sandbox has a wall-clock timeout that activity must extend to keep alive.
    lease: { required: true, renewable: true },
    quirks: {
      // Logs replace a stderr side channel; there is no addressable host pid.
      noStderrChannel: true,
      noProcessId: true,
      ephemeralUnlessSnapshotted: true,
    },
  },
};
