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
| GET    | `/instances/:id/logs`           | NDJSON log stream                     |
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

## Deploy

`wrangler.toml` points `main` at `src/workerEntry.ts`, which binds the real
sandbox/container runtime factory and the `WebSocketPair` global. Set the secret
with `wrangler secret put BRIDGE_AUTH_TOKEN`. The core logic
(`worker.ts` / `instanceDurableObject.ts`) takes its platform and runtime factory
by injection so it runs under `vitest` without the Worker runtime; `workerEntry.ts`
is the thin production seam.
