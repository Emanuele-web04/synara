# Beta diagnostics

Synara Beta ships always-on diagnostics so the team can see crashes and release
health on real machines instead of waiting for bug reports. This document is the
authoritative description of what leaves your computer.

**Stable builds collect nothing.** The diagnostics module is only constructed
when the packaged build's `synaraDesktopFlavor` field equals `"beta"` — a field baked
in at build time that cannot be flipped by an environment variable. (The module
source is bundled into the shared desktop code, but in a stable build it is
never instantiated: no UI, environment variable, or IPC can enable it.)

## What is collected

Nine event names, each with a small fixed field set. The full allowlist lives
in `apps/desktop/src/betaDiagnostics.ts` (`BetaDiagnosticsEventName` and the
`sanitizeBetaDiagnosticsPayload` schemas); the ingest worker re-validates the
same allowlist server-side.

| Event                                                                                       | Fields (all optional except `kind`)                                                                                                                       |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.start`, `app.exit`                                                                     | `kind: "lifecycle"`                                                                                                                                       |
| `app.renderer-crash`, `app.child-process-crash`                                             | `kind: "crash"`, `processType` (Electron enum like `renderer`/`gpu`/`backend`), `reason`, `logTail` (redacted last ~200 lines/16 KiB of the relevant log) |
| `app.error`                                                                                 | `kind: "error"`, `source` (`main`/`renderer`), `message` (redacted, 1 KiB), `stack` (redacted, 8 KiB), `fingerprint` (hash of the redacted text)          |
| `update.check`, `update.available`, `update.downloaded`, `update.installed`, `update.error` | `kind: "update"`, `outcome` (`ok`/`error`), `durationMs`, `errorContext` (`check`/`download`/`install`), `targetVersion` (strict semver)                  |

`app.error` fires when the main process throws an uncaught exception or a
renderer logs a console error. The same fingerprint is sent at most once per
10 minutes and at most 30 errors per hour per session.

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
- File contents, workspace contents, or git metadata
- Provider keys, tokens, or anything under `secrets/`
- IP-derived identifiers, device IDs, or account identity
- Screenshots, window contents, or keystrokes

The only free-text fields are `message`, `stack`, and `logTail`. Before they
are written to the queue, each is passed through `redactDiagnosticText`
(`packages/shared/src/diagnosticsRedaction.ts`), which strips PEM blocks, git
remote URLs, emails, URL credentials and query strings,
`Authorization`/`Bearer`/`Cookie` values, known token shapes (API keys,
GitHub/Slack/AWS/Google tokens, JWTs), sensitive `key=value`/`key: value`
fields, IP addresses, and any remaining long opaque token. Paths are reduced
to the file name: `/Users/you/code/my-repo/app.ts` becomes `~/…/app.ts`, so
folder and repository names are not sent. Redaction is best-effort — error
text can still include fragments of whatever was on screen. The worker runs
the same redaction again before storing.

## Transport and storage

Events are buffered to `~/.synara-beta/diagnostics/events.jsonl` and flushed in
batches as NDJSON over HTTPS to `https://synara-beta-diagnostics.kartik-9f9.workers.dev`
(override with `SYNARA_BETA_DIAGNOSTICS_URL` for local development; only `https://`
or loopback targets are accepted). Events land in a Cloudflare D1 database and
are deleted after 30 days by a scheduled job; crash dumps land in the
`synara-beta-crash-dumps` R2 bucket. The worker code is
`infra/diagnostics-worker/worker.ts` — the allowlist is enforced again there
and unknown events/fields are dropped, so the documented schema is enforced at
the endpoint, not just the client.

If the endpoint is unreachable the queue stays on disk and retries on the next
flush; if it grows past 1 MiB the client trims it to the newest 512 KiB of
events rather than letting it grow. Diagnostics never blocks the app: every
failure is swallowed.
