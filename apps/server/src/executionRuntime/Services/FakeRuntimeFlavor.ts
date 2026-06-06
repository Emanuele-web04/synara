/**
 * FakeRuntimeFlavor - Server-internal flavors of the fake-remote runtime family.
 *
 * The public `ExecutionRuntimeProvider` enum carries a single `fake` literal so
 * persisted instances decode; the specific flavor lives here, off the public
 * contract. Each flavor exercises a different slice of the remote mechanism:
 * PTY-like long-lived sessions, fire-and-collect command exec, job/service
 * runtimes whose logs are process output, and an ephemeral filesystem. They all
 * run commands locally in temp dirs but through the remote path (real instance
 * records, an in-memory transport, lifecycle events, destroy cleanup).
 *
 * @module FakeRuntimeFlavor
 */
export type FakeRuntimeFlavor =
  | "fake-pty-workspace"
  | "fake-command-workspace"
  | "fake-job-runtime"
  | "fake-service-runtime"
  | "fake-ephemeral-runtime";

export const FAKE_RUNTIME_FLAVORS: ReadonlyArray<FakeRuntimeFlavor> = [
  "fake-pty-workspace",
  "fake-command-workspace",
  "fake-job-runtime",
  "fake-service-runtime",
  "fake-ephemeral-runtime",
];
