# Cloudflare Runtime Bridge

An authenticated Cloudflare Worker + Durable Object that fronts Cloudflare-backed
execution runtimes for Synara. One Durable Object per `runtimeInstanceId` owns a
single instance and serializes all operations on it, so `runtimeInstanceId ->
instance` is a stable single-writer mapping.

## Routes

All requests carry `Authorization: Bearer <BRIDGE_AUTH_TOKEN>` (the terminal
WebSocket also accepts `?token=`).

| Method | Path                            | Purpose                               |
| ------ | ------------------------------- | ------------------------------------- |
| POST   | `/instances`                    | Create an instance (mints a new DO)   |
| GET    | `/instances/:id`                | Read the instance record              |
| DELETE | `/instances/:id`                | Destroy the instance (idempotent)     |
| POST   | `/instances/:id/exec`           | Fire-and-collect command              |
| GET    | `/instances/:id/logs`           | NDJSON log stream (replays recent ring + live) |
| GET    | `/instances/:id/terminal` (WS)  | Interactive terminal (workspace only) |
| GET    | `/instances/:id/files?path=`    | Read a file (base64)                  |
| PUT    | `/instances/:id/files`          | Write a file (base64)                 |
| GET    | `/instances/:id/files/watch`    | NDJSON file-change stream             |
| POST   | `/instances/:id/ports`          | Expose a port on demand               |
| PUT    | `/instances/:id/network-policy` | Set the outbound network policy       |
| POST   | `/instances/:id/renew-activity` | Renew the keepalive lease             |

Wire shapes live in `@t3tools/contracts` (`cloudflareRuntimeBridge.ts`); both the
Worker and the Synara `CloudflareBridgeClient` adapter validate against them.

## Runtime flavors

- `workspace` (default): interactive sandbox runtime. File read/write/watch and
  the interactive terminal are available.
- `container`: the raw Cloudflare Containers runtime, kept **service-oriented**.
  Ports are declared at create time and the interactive terminal route is
  rejected (`409`). This keeps raw Containers a lower-level service runtime, not
  the default workspace.

## Logs

Each Durable Object keeps a bounded in-memory ring of recent log lines and fans
new lines out to live `GET /logs` subscribers. The producers are `exec`
(collected stdout/stderr split into per-line records after a command finishes)
and the interactive terminal (each output chunk mirrored to the ring). A
subscriber that connects after a command ran still sees the retained tail, then
every subsequent line until it disconnects. The ring is in-memory only; it is not
event-sourced and is cleared on `destroy`.

## Deploy

This package is **not** live until the Worker is deployed. The core logic
(`worker.ts` / `instanceDurableObject.ts`) takes its platform and runtime factory
by injection so it runs under `vitest` without the Worker runtime; `workerEntry.ts`
is the thin production seam, and `wrangler.toml` points `main` at it.

Live use requires:

1. **The Cloudflare Sandbox SDK as a dependency.** The real `workspace` runtime is
   `@cloudflare/sandbox`. It is loaded through a guarded dynamic import
   (`cloudflareSandboxSdk.ts`) so this package typechecks and tests without it; a
   deploy must install it and re-export its Durable Object class:

   ```sh
   npm add @cloudflare/sandbox
   ```

   ```ts
   // workerEntry.ts (deploy only)
   export { Sandbox } from "@cloudflare/sandbox";
   ```

2. **A `SANDBOX` Durable Object binding** in `wrangler.toml` pointing at that
   `Sandbox` class. `makeRealSandboxRuntimeFactory` resolves a workspace per
   instance id from `env.SANDBOX` via `getSandbox`. If the binding is missing at
   runtime the factory throws a clear error rather than silently degrading.

3. **The auth secret:** `wrangler secret put BRIDGE_AUTH_TOKEN` (the shared bearer
   the Synara server authenticates with).

The Synara server reaches a deployed bridge over authenticated HTTP/WS, gated on
`SYNARA_CLOUDFLARE_BRIDGE_URL` + `SYNARA_CLOUDFLARE_BRIDGE_TOKEN`; without those
the server falls back to its in-process fake bridge and never calls out.

The `container` flavor (raw Cloudflare Containers) is intentionally **not** wired
in `workerEntry.ts`. It stays a lower-level service runtime; the factory rejects
it until a Containers binding is added. The real terminal runs over the SDK's
managed-process stream, which is output-only (no stdin in that surface), so
interactive writes are dropped against the real runtime; the local/fake paths
remain fully interactive.
