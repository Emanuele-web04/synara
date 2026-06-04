/**
 * Fake-remote runtime descriptors.
 *
 * Each flavor of the `fake` family reports honest, distinct capabilities so the
 * planner and contract suites exercise both PTY-like and non-PTY remote paths.
 * They back `remote-runtime` and carry the remote quirks (no addressable pid,
 * optional stderr channel) even though commands actually run locally in a temp
 * dir — the point is to drive the remote mechanism, not the real transport.
 *
 * @module fakeDescriptors
 */
import type { RuntimeProviderCapabilities } from "../Services/RuntimeProviderDescriptor.ts";
import type { RuntimeProviderDescriptor } from "../Services/RuntimeProviderDescriptor.ts";
import type { FakeRuntimeFlavor } from "../Services/FakeRuntimeFlavor.ts";

const fakeDescriptor = (
  flavor: FakeRuntimeFlavor,
  capabilities: RuntimeProviderCapabilities,
): RuntimeProviderDescriptor => ({
  provider: "fake",
  flavor,
  targetKinds: ["remote-runtime"],
  capabilities,
});

/** Long-lived interactive PTY-style session (the Codex agent path). */
const ptyWorkspace = fakeDescriptor("fake-pty-workspace", {
  lifecycle: { stop: true, snapshot: true, archive: true, reconnect: true },
  exec: { pty: true, command: true, roles: ["agent", "setup", "git", "exec", "terminal"] },
  fs: { persistent: true, writable: true },
  git: { clone: true, diff: true },
  ingress: { exposePort: true, declarePortsAtCreate: false, maxRoutes: null },
  persistence: { snapshots: true, volumes: true },
  network: { egress: true, outboundProxy: false },
  lease: { required: true, renewable: true },
  quirks: { noStderrChannel: false, noProcessId: true, ephemeralUnlessSnapshotted: false },
});

/** Fire-and-collect command exec, no PTY (Vercel-like). */
const commandWorkspace = fakeDescriptor("fake-command-workspace", {
  lifecycle: { stop: true, snapshot: true, archive: false, reconnect: true },
  exec: { pty: false, command: true, roles: ["agent", "setup", "git", "exec"] },
  fs: { persistent: true, writable: true },
  git: { clone: true, diff: true },
  ingress: { exposePort: true, declarePortsAtCreate: true, maxRoutes: 8 },
  persistence: { snapshots: true, volumes: false },
  network: { egress: true, outboundProxy: true },
  lease: { required: true, renewable: true },
  quirks: { noStderrChannel: true, noProcessId: true, ephemeralUnlessSnapshotted: true },
});

/** Batch job runtime: logs as process output, no PTY, no ingress (Modal-like). */
const jobRuntime = fakeDescriptor("fake-job-runtime", {
  lifecycle: { stop: true, snapshot: false, archive: false, reconnect: true },
  exec: { pty: false, command: true, roles: ["agent", "setup", "exec"] },
  fs: { persistent: false, writable: true },
  git: { clone: true, diff: false },
  ingress: { exposePort: false, declarePortsAtCreate: false, maxRoutes: 0 },
  persistence: { snapshots: false, volumes: true },
  network: { egress: true, outboundProxy: false },
  lease: { required: false, renewable: false },
  quirks: { noStderrChannel: true, noProcessId: true, ephemeralUnlessSnapshotted: true },
});

/** Long-running service runtime with ingress, no PTY (Cloudflare-like). */
const serviceRuntime = fakeDescriptor("fake-service-runtime", {
  lifecycle: { stop: true, snapshot: false, archive: false, reconnect: true },
  exec: { pty: false, command: true, roles: ["agent", "setup", "exec", "terminal"] },
  fs: { persistent: false, writable: true },
  git: { clone: true, diff: true },
  ingress: { exposePort: true, declarePortsAtCreate: true, maxRoutes: 4 },
  persistence: { snapshots: false, volumes: false },
  network: { egress: true, outboundProxy: true },
  lease: { required: true, renewable: true },
  quirks: { noStderrChannel: true, noProcessId: true, ephemeralUnlessSnapshotted: true },
});

/** Throwaway ephemeral runtime, no persistence, no ingress. */
const ephemeralRuntime = fakeDescriptor("fake-ephemeral-runtime", {
  lifecycle: { stop: true, snapshot: false, archive: false, reconnect: false },
  exec: { pty: false, command: true, roles: ["agent", "setup", "exec"] },
  fs: { persistent: false, writable: true },
  git: { clone: true, diff: false },
  ingress: { exposePort: false, declarePortsAtCreate: false, maxRoutes: 0 },
  persistence: { snapshots: false, volumes: false },
  network: { egress: true, outboundProxy: false },
  lease: { required: false, renewable: false },
  quirks: { noStderrChannel: true, noProcessId: true, ephemeralUnlessSnapshotted: true },
});

export const FAKE_RUNTIME_DESCRIPTORS: ReadonlyArray<RuntimeProviderDescriptor> = [
  ptyWorkspace,
  commandWorkspace,
  jobRuntime,
  serviceRuntime,
  ephemeralRuntime,
];

export const fakeRuntimeDescriptorByFlavor = (
  flavor: FakeRuntimeFlavor,
): RuntimeProviderDescriptor => {
  const descriptor = FAKE_RUNTIME_DESCRIPTORS.find((entry) => entry.flavor === flavor);
  if (!descriptor) {
    throw new Error(`No fake runtime descriptor for flavor '${flavor}'.`);
  }
  return descriptor;
};
