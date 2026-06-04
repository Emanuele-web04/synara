/**
 * Modal runtime descriptors.
 *
 * Modal is a job/service-first remote runtime: work runs as a Function /
 * sandbox invocation whose logs are the process output stream, not an
 * interactive PTY. The descriptors below report Modal's honest capabilities per
 * {@link ModalRuntimeRole}:
 *
 * - No `pty`. Modal exec is fire-and-collect / streamed output. Claiming a PTY
 *   would let the planner route an interactive terminal role here that Modal
 *   cannot host, so every Modal descriptor sets `exec.pty: false`.
 * - `Finished` is the terminal state for a job: a completed run reports its exit
 *   code and stops. This maps to the `stopped` runtime instance status; there is
 *   no resume-after-finish, so `lifecycle.reconnect` stays `false` for `job`.
 * - Volume sync is tracked under `persistence.volumes`, kept separate from
 *   `persistence.snapshots` (Modal Volumes are not VM snapshots). Modal exposes
 *   no instance snapshotting in this slice, so `snapshots: false`.
 * - Ingress (tunnels / web endpoints) is available to `service`/`preview` only;
 *   a `job` exposes no ports.
 *
 * The single descriptor the shared `RuntimeProviderRegistry` resolves for the
 * `modal` provider is the `service` shape (the broadest), so a plain provider
 * lookup honestly reflects Modal's reconnect/ingress support. The Modal adapter
 * selects the precise per-role descriptor internally via
 * {@link modalDescriptorForRole} before provisioning.
 *
 * @module modalDescriptors
 */
import type { RuntimeProviderCapabilities } from "../../Services/RuntimeProviderDescriptor.ts";
import type { RuntimeProviderDescriptor } from "../../Services/RuntimeProviderDescriptor.ts";
import type { ModalRuntimeRole } from "./ModalRuntimeRole.ts";

const modalDescriptor = (capabilities: RuntimeProviderCapabilities): RuntimeProviderDescriptor => ({
  provider: "modal",
  targetKinds: ["remote-runtime"],
  capabilities,
});

/**
 * One-shot verification job: streamed logs, no PTY, no ingress, ephemeral FS
 * with optional volume sync. `Finished` is terminal — a completed run cannot be
 * re-attached, so reconnect is `false`.
 */
const jobDescriptor = modalDescriptor({
  lifecycle: { stop: true, snapshot: false, archive: false, reconnect: false },
  exec: { pty: false, command: true, roles: ["agent", "setup", "exec"] },
  fs: { persistent: false, writable: true },
  git: { clone: true, diff: true },
  ingress: { exposePort: false, declarePortsAtCreate: false, maxRoutes: 0 },
  persistence: { snapshots: false, volumes: true },
  network: { egress: true, outboundProxy: false },
  lease: { required: false, renewable: false },
  quirks: { noStderrChannel: false, noProcessId: true, ephemeralUnlessSnapshotted: true },
});

/**
 * Long-running service that can expose a tunnel / web endpoint. Streamed logs,
 * no PTY. Reconnect is supported (a running service can be re-attached via its
 * sandbox id), ingress is on, volume sync available.
 */
const serviceDescriptor = modalDescriptor({
  lifecycle: { stop: true, snapshot: false, archive: false, reconnect: true },
  exec: { pty: false, command: true, roles: ["agent", "setup", "exec"] },
  fs: { persistent: false, writable: true },
  git: { clone: true, diff: true },
  ingress: { exposePort: true, declarePortsAtCreate: true, maxRoutes: 4 },
  persistence: { snapshots: false, volumes: true },
  network: { egress: true, outboundProxy: false },
  lease: { required: true, renewable: true },
  quirks: { noStderrChannel: false, noProcessId: true, ephemeralUnlessSnapshotted: true },
});

/**
 * Preview-first service: same as `service` but its purpose is the exposed URL.
 * Identical capability surface; kept distinct so the read-model/planner can
 * reason about intent without re-deriving it.
 */
const previewDescriptor = modalDescriptor({
  lifecycle: { stop: true, snapshot: false, archive: false, reconnect: true },
  exec: { pty: false, command: true, roles: ["agent", "setup", "exec"] },
  fs: { persistent: false, writable: true },
  git: { clone: true, diff: false },
  ingress: { exposePort: true, declarePortsAtCreate: true, maxRoutes: 4 },
  persistence: { snapshots: false, volumes: true },
  network: { egress: true, outboundProxy: false },
  lease: { required: true, renewable: true },
  quirks: { noStderrChannel: false, noProcessId: true, ephemeralUnlessSnapshotted: true },
});

const MODAL_DESCRIPTOR_BY_ROLE: Readonly<Record<ModalRuntimeRole, RuntimeProviderDescriptor>> = {
  job: jobDescriptor,
  service: serviceDescriptor,
  preview: previewDescriptor,
};

export const modalDescriptorForRole = (role: ModalRuntimeRole): RuntimeProviderDescriptor =>
  MODAL_DESCRIPTOR_BY_ROLE[role];

/**
 * The descriptor the shared registry binds to the `modal` provider. Uses the
 * `service` shape — the broadest Modal role — so a plain provider lookup reports
 * reconnect + ingress support honestly. Per-role validation goes through
 * {@link modalDescriptorForRole} inside the adapter.
 */
export const MODAL_PROVIDER_DESCRIPTOR: RuntimeProviderDescriptor = serviceDescriptor;
