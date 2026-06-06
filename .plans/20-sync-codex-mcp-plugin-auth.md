# 20 · Sync Codex MCP-plugin auth into the sandbox
Make a codex agent running inside a remote sandbox see the same authenticated **MCP servers** (codex's "plugins") the operator has locally — so a remote turn can call `exa`, `novu`, the `cloudflare-*` tools, etc., instead of running tool-blind.

Builds on `.plans/19-codex-on-daytona.md`. The auth/AGENTS/config injection seam already exists; this plan extends it to the `[mcp_servers.*]` slice.

* * *
## What "plugin auth" is, concretely
Codex has no plugin store of its own — its extensibility is **MCP servers** declared under `[mcp_servers.*]` in `~/.codex/config.toml`. Confirmed against codex source (`codex-rs/config/src/mcp_types.rs`): a server is one of two transports.

**HTTP / StreamableHttp** — runnable in a sandbox:

- `url` (required)
  
- `bearer_token_env_var` — the **name** of an env var; codex reads the secret from the _environment_ at runtime and sends `Authorization: Bearer <token>`. The secret is **not** in config.toml.
  
- `http_headers` — static headers (a secret can be inline here)
  
- `env_http_headers` — header value sourced from a named env var
  
- `oauth_resource` — OAuth resource hint
  

**stdio / command** — host-only:

- `command` + `args` + `env` — launches a local binary. On this host these point at `/Applications/Codex.app/...`, a local RepoPrompt socket, absolute trusted-path env. **None of this exists in a sandbox.**
  

This operator's host config has 11 servers: 2 stdio (`RepoPrompt`, `node_repl` — host-only) and 9 HTTP (`exa`, `openaiDeveloperDocs`, `novu` (bearer-env), `cloudflare*`).

* * *
## Current state (what is and isn't synced)
`apps/server/src/executionRuntime/codexAuthBootstrap.ts` + `providers/daytona/DaytonaRuntimeAdapter.ts:278-301` (`injectCodexCredentials`) inject, at provision **and** on resume:

| File | Synced today? |
|---|---|
| `~/.codex/auth.json` (ChatGPT login `tokens`) | ✅ base64 exec, mode 600 |
| `~/.codex/AGENTS.md` (global persona) | ✅ |
| `~/.codex/config.toml` | ⚠️ **only a 2-line minimal stub**, and only if the image ships none (`buildMinimalCodexConfigCommand`, `codexAuthBootstrap.ts:155-167`) |
| `[mcp_servers.*]` / plugin auth | ❌ **not synced — this plan** |

The host config.toml is deliberately _not_ copied (`codexAuthBootstrap.ts:23-27`): it mixes the MCP slice with host-only junk (`[projects]` absolute paths, the browser-plugin socket). So the work is **extract the MCP slice, sanitize the rest** — not "copy the file."

* * *
## The core problem
Two facts make a naive "copy the `[mcp_servers.*]` blocks" wrong:

1. **The secret isn't in the file.** `bearer_token_env_var`/`env_http_headers` reference env-var _names_; the value lives in the operator's shell environment. Copying the config slice carries the _reference_, not the credential — the server would 401 in the sandbox.
  
2. **stdio servers can't run.** Their `command` path doesn't exist in the image; carrying them produces start-up errors and leaks host paths.
  

So syncing plugin auth = **resolve each HTTP server's referenced env secrets on the host, drop the stdio servers, and write a sandbox-safe** `[mcp_servers.*]` **block** with the secrets materialized where codex can read them.

* * *
## Design decision — how the secret reaches codex
{==Two ways to get the resolved bearer token to the remotely-running codex process.==}{>>Decision 1. I recommend **A (materialize into config)** — it reuses the existing one-exec-per-file injection seam verbatim, rides the existing `reinjectCredentials` resume hook for free, and treats MCP secrets exactly like the already-injected `auth.json` (base64 arg, mode 600, `secretTainted`). B is "cleaner" separation but needs new launch-env plumbing through codexAppServerManager→createTransport that doesn't exist yet. Pick A unless you object.<<}{id="c1" by="AI" at="2026-06-05T12:00:00.000Z"}

**A — Materialize secrets inline into the sandbox config.toml (recommended).** Resolve `bearer_token_env_var = "NOVU_TOKEN"` → read `NOVU_TOKEN` from host env → emit a static header instead:

```toml
[mcp_servers.novu]
url = "https://…"
http_headers = { Authorization = "Bearer <resolved-value>" }
```

codex in the sandbox needs nothing in its environment; it reads config.toml and connects. Reuses `injectCodexCredentials` (one more `exec`) and the resume path unchanged. Secret lands in `config.toml` on disk — same trust level as the already-present `auth.json` (mode 600, `secretTainted` blocks snapshotting).

**B — Env overlay at codex launch.** Keep `bearer_token_env_var` as-is in config; inject the resolved values into the env Synara passes when it starts `codex app-server` remotely (`ExecutionRuntimeService.ts:656-662` `spawn.env` → `DaytonaRuntimeAdapter` `toExecInput:175-180`). Cleaner (no secret on disk) but requires threading an MCP-env map from provision → the codex launch seam and re-applying it on every resume. New plumbing, more moving parts.

* * *
## Open decisions
{==Default on or off, and allowlist semantics.==}{>>Decision 2. Syncing tokens into a cloud sandbox widens blast radius (those creds become usable from the cloud VM). I recommend: **opt-in, default OFF**, a single Settings toggle "Sync codex MCP plugins", plus an optional comma-separated server allowlist. Empty allowlist + toggle ON = all HTTP servers. stdio servers always dropped. Acceptable? Or do you want it default-ON for HTTP servers since the sandbox is already trusted with auth.json?<<}{id="c2" by="AI" at="2026-06-05T12:00:00.000Z"}

{==stdio/command servers: drop always, or allow when the operator asserts the binary exists in the image?==}{>>Decision 3. I recommend **drop always in v1** (they need host binaries + leak host paths). A future "image-provided stdio allowlist" can come later. OK to defer?<<}{id="c3" by="AI" at="2026-06-05T12:00:00.000Z"}

{==OAuth-login MCP servers (`codex mcp login`) keep their token in an on-disk store under CODEX_HOME.==}{>>Decision 4. This host has none configured (no on-disk MCP-oauth store found), and refresh-on-resume makes a copied token stale. I recommend **defer** OAuth-login servers — sync only `url`/`bearer`/`headers` servers in v1, and log a skip for any oauth-only server. Agree?<<}{id="c4" by="AI" at="2026-06-05T12:00:00.000Z"}

{==Parsing the host config.toml needs a real TOML parser; the repo has none.==}{>>Decision 5. I recommend adding **`smol-toml`** (tiny, zero native deps, modern) to apps/server for parse+serialize, rather than regex-scraping `[mcp_servers.*]` (fragile across nested tables like `[mcp_servers.node_repl.env]`). Approve the dependency?<<}{id="c5" by="AI" at="2026-06-05T12:00:00.000Z"}

* * *
## Implementation phases
### Phase 1 — Host resolve + sanitize (pure, testable)
New shared module `apps/server/src/executionRuntime/codexMcpBootstrap.ts` (sibling to `codexAuthBootstrap.ts`; **provider-agnostic** so Vercel/Modal/Cloudflare reuse it):

- `resolveOperatorCodexMcpPlugins(env, opts: { allowlist?: string[]; includeStdio: false }) → { servers: SandboxMcpServer[]; skipped: { name: string; reason: string }[] }`
  
- Reads the base codex home config.toml (`resolveBaseCodexHomePath`, already used), parses with `smol-toml`, keeps HTTP-transport servers (respecting allowlist), drops stdio + oauth-only with a recorded `reason`.
  
- For each kept server, resolve `bearer_token_env_var` / `env_http_headers` from `env`; a referenced-but-missing env var → skip that server with a reason (don't emit a half-authed block).
  
- Returns a typed model, **no I/O on the result** — unit-tested with config fixtures.
  
### Phase 2 — Sandbox config emit + inject command
In `codexMcpBootstrap.ts`:

- `buildSandboxMcpConfigToml(servers) → string` — serialize each as a sandbox-safe block (Approach A materialization).
  
- `buildCodexMcpConfigCommand(toml) → ExecutionRuntimeExecCollectInput` — base64 positional-arg exec that **appends** the `[mcp_servers.*]` block to `$HOME/.codex/config.toml` (create-if-missing), mirroring `buildCodexAuthInjectionCommand`. Echoes only `codex-mcp-injected` — never the rendered toml.
  
- Reconcile with `buildMinimalCodexConfigCommand`'s skip-if-exists guard: write base config first, then append MCP block (idempotent: strip prior Synara-managed block before re-appending, so resume re-injection doesn't duplicate).
  
### Phase 3 — Wire into the existing injection seam
- `DaytonaRuntimeAdapter.ts:278-301` `injectCodexCredentials`: after the auth/config/AGENTS execs, if the setting is enabled, resolve plugins and exec the MCP config command; keep `secretTainted.add(sandboxId)`.
  
- Resume is **free**: `reinjectCredentials` (`DaytonaRuntimeAdapter.ts:535-536`) already routes through `injectCodexCredentials`, called from both resume branches (`ExecutionRuntimeService.ts:511,536`).
  
- Read the toggle/allowlist from `ServerSettings.sandboxes.runtime` at provision time (live), so a rotated token is picked up on the next provision/resume — **never persisted** to settings.json or ServerSecretStore.
  
### Phase 4 — Settings surface (opt-in)
Non-secret round-tripped settings; no ServerSecretStore changes (tokens resolve live from host env):

- `packages/contracts/src/settings.ts` — add `syncMcpPlugins` + `mcpAllowlist` to `SandboxRuntimeDefaults` (`:131-138`).
  
- `apps/web/src/appSettings.ts` — add flat keys `sandboxRuntimeSyncMcpPlugins`, `sandboxRuntimeMcpAllowlist` (`:174-199`).
  
- `apps/web/src/sandboxSettings.ts` — add to `SANDBOX_RUNTIME_FIELDS`; the read/write bridges then map automatically.
  
- `apps/web/src/routes/_chat.settings.tsx` — a toggle + allowlist input in the existing "Remote runtime defaults" section.
  
- Update `wsNativeApi.test.ts` / `settings.test.ts` fixtures (the `runtime` sub-struct gained fields — same fixture-fix pattern as the cpu/memory/ports additions).
  
### Phase 5 — Tests
- `codexMcpBootstrap` unit: HTTP kept / stdio dropped / oauth-only skipped / missing-env-var skipped (with reasons); bearer-env → static-header materialization; url-embedded-secret carried; idempotent re-append.
  
- **Redaction regression:** assert no resolved token appears in any exec command's logged form (only the base64 arg + the `codex-mcp-injected` echo).
  
- Resume: reinjection re-applies the MCP block and doesn't duplicate it.
  
- Settings round-trip through the bridges.
  
- Live Daytona boundary check (`RUN_E2E=1`): an HTTP MCP tool (e.g. `exa`) answers from inside the sandbox.
  
### Phase 6 — Verify + document
One final `bun fmt && bun lint && bun typecheck` pass. Note the feature + the "tokens leave your machine for the cloud VM when enabled" tradeoff in the settings help text.

* * *
## Security model (constraints preserved)
- MCP secrets ride as **base64 positional args**, identical to `auth.json`; never on a visible command line, never logged.
  
- Resolved **live** at provision/resume from host env — never written to settings.json, never put in ServerSecretStore (avoids a second copy at rest; picks up rotation).
  
- `secretTainted` already forbids snapshot-at-reclaim once codex creds are injected; this reinforces it.
  
- The rendered config.toml (now secret-bearing) is **never** echoed or logged — only `codex-mcp-injected`.
  
- stdio drop keeps host paths/sockets out of the sandbox entirely.
  
- Default OFF (Decision 2) — no token leaves the host until the operator opts in.
  

* * *
## Out of scope / deferred
- **Hoist** `injectCodexCredentials` **to a shared provision step.** It's Daytona-local today; every codex-running provider needs it. Bigger refactor — track separately, reuse `codexMcpBootstrap` when done.
  
- OAuth-login MCP servers (Decision 4).
  
- Image-provided stdio allowlist (Decision 3).
  
- Env-overlay injection (Approach B) — revisit if "no secret on disk" becomes a hard requirement.
