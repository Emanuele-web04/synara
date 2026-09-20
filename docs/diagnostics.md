# Beta diagnostics

Synara Beta ships always-on diagnostics so the team can see crashes and release
health on real machines instead of waiting for bug reports. This document is the
authoritative description of what leaves your computer.

**Stable builds collect nothing.** The diagnostics module is only constructed
when the packaged build's `synaraFlavor` field equals `"beta"` — a field baked
in at build time that cannot be flipped by an environment variable. In a stable
build there is no sender code path to enable.

## What is collected

Eight event names, each with a small fixed field set. The full allowlist lives
in `apps/desktop/src/betaDiagnostics.ts` (`BetaDiagnosticsEventName` and the
`sanitizeBetaDiagnosticsPayload` schemas); the ingest worker re-validates the
same allowlist server-side.

| Event                                                                                       | Fields (all optional except `kind`)                                                                                                      |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `app.start`, `app.exit`                                                                     | `kind: "lifecycle"`                                                                                                                      |
| `app.renderer-crash`, `app.child-process-crash`                                             | `kind: "crash"`, `processType` (Electron enum like `renderer`/`gpu`), `reason` (Electron enum like `crashed`/`oom`)                      |
| `update.check`, `update.available`, `update.downloaded`, `update.installed`, `update.error` | `kind: "update"`, `outcome` (`ok`/`error`), `durationMs`, `errorContext` (`check`/`download`/`install`), `targetVersion` (strict semver) |

Every event also carries: a random per-install UUID, `flavor: "beta"`,
`platform`, `arch`, the app version, and a timestamp. The install UUID is
generated locally on first launch (`crypto.randomUUID`) — it is not derived
from your hardware, account, or IP.

Crash dumps: Electron's `crashReporter` uploads minidumps to the diagnostics
endpoint. Minidumps are memory snapshots of the crashed process and can in
principle contain fragments of that process's memory; they are stored in R2 and
should be treated like crash dumps on any platform — kept on a short lifecycle
(the `wrangler.toml` notes a 30-day object expiration).

## What is never collected

- Chat messages, prompts, agent output, or transcripts
- File paths, file names, workspace contents, or git metadata
- Provider keys, tokens, or anything under `secrets/`
- IP-derived identifiers, device IDs, or account identity
- Freeform text fields — the schema has none, so arbitrary strings cannot be
  smuggled into a payload
- Screenshots, window contents, or keystrokes

PII sanitization is structural rather than a filter: the payload builder only
copies fields on the allowlist and enforces enum/semver types on them, so there
is no free-text channel to sanitize.

## Transport and storage

Events are buffered to `~/.synara-beta/diagnostics/events.jsonl` and flushed in
batches as NDJSON over HTTPS to `https://synara-beta-diagnostics.emanueledipietro.workers.dev`
(override with `SYNARA_BETA_DIAGNOSTICS_URL` for local development; only `https://`
or loopback targets are accepted). Events land in Cloudflare Analytics Engine
(`synara_beta_events` dataset); crash dumps land in the `synara-beta-crash-dumps`
R2 bucket. The worker code is `infra/diagnostics-worker/worker.ts` — the
allowlist is enforced again there and unknown events/fields are dropped, so the
documented schema is enforced at the endpoint, not just the client.

If the endpoint is unreachable the queue stays on disk and retries on the next
flush; if it grows past 512 KiB the client trims it to the newest 256 KiB of
events rather than letting it grow. Diagnostics never blocks the app: every
failure is swallowed.
