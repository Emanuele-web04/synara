/**
 * ModalRuntimeRole - Server-internal Modal runtime roles.
 *
 * Modal backs `remote-runtime` through three distinct runtime shapes, each with
 * its own honest capabilities. Like {@link FakeRuntimeFlavor} this stays off the
 * public `ExecutionRuntimeProvider` contract (which carries a single `modal`
 * literal); the role selects which descriptor the Modal adapter provisions and
 * validates against:
 *
 * - `job` — a one-shot batch run (a Modal Function / `sandbox` invocation). Logs
 *   are the process output stream; `Finished` is terminal. No PTY, no ingress.
 *   This is the verification-job shape (remote `bun typecheck`/`lint`/`test`/
 *   `build`).
 * - `service` — a long-running process that can expose a tunnel / web endpoint.
 *   No PTY; ingress where the account supports it.
 * - `preview` — a service whose primary purpose is an exposed preview URL.
 *
 * None of these claim a PTY: Modal exec is fire-and-collect / streamed output,
 * not an interactive terminal, so the descriptors report `pty: false`.
 *
 * @module ModalRuntimeRole
 */
export type ModalRuntimeRole = "job" | "service" | "preview";

export const MODAL_RUNTIME_ROLES: ReadonlyArray<ModalRuntimeRole> = ["job", "service", "preview"];

export const isModalRuntimeRole = (value: string): value is ModalRuntimeRole =>
  value === "job" || value === "service" || value === "preview";
