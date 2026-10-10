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

Thirteen event names, each with a small fixed field set. The full allowlist
lives in `apps/desktop/src/betaDiagnostics.ts` (`BetaDiagnosticsEventName` and
the `sanitizeBetaDiagnosticsPayload` schemas); the ingest worker re-validates
the same allowlist server-side.

| Event                                                                                       | Fields (all optional except `kind`)                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.start`, `app.exit`                                                                     | `kind: "lifecycle"`; `app.start` also carries `osVersion` (major.minor) and `locale` (language only, e.g. `en`)                                                                                                                        |
| `app.renderer-crash`, `app.child-process-crash`                                             | `kind: "crash"`, `processType` (Electron enum like `renderer`/`gpu`/`backend`), `reason`, `logTail` (redacted last ~200 lines/16 KiB of the relevant log)                                                                              |
| `app.error`                                                                                 | `kind: "error"`, `source` (`main`/`renderer`), `message` (redacted, 1 KiB), `stack` (redacted, 8 KiB), `fingerprint` (hash of the redacted text)                                                                                       |
| `update.check`, `update.available`, `update.downloaded`, `update.installed`, `update.error` | `kind: "update"`, `outcome` (`ok`/`error`), `durationMs`, `errorContext` (`check`/`download`/`install`), `targetVersion` (strict semver); `update.error` also carries `message` (redacted, 1 KiB)                                      |
| `usage.daily`                                                                               | `kind: "usage"`, `providers` (provider name + `threads`/`turns`/`turnsFailed` counts for the last 24h; `turnsFailed` counts turns that ended in `error` — cancelled turns are not failures), `projects`, `activeThreads` — counts only |
| `beta.installed`, `beta.left`                                                               | `kind: "beta"`, `outcome` (`imported`/`import-failed`/`fresh`, or `trash`/`keep`)                                                                                                                                                      |

`app.error` fires when the main process throws an uncaught exception, the
renderer throws an uncaught exception or rejects a promise, or the renderer
logs a console error. Renderer exceptions retain their original stacks through
a fixed, bounded IPC payload. The bridge is exposed only when the Beta main
process enables it, and reports from other windows or subframes are rejected.
Malformed exception fields produce a generic report without serializing objects.
Console errors remain a fallback during startup and for browser errors such as
CORS failures. Once the renderer listeners are ready, their uncaught exceptions
are not also counted through that fallback. The same fingerprint is sent at
most once per 10 minutes and at most 30 errors per hour per session. Loopback
HTTP and WebSocket URL ports are normalized only for fingerprinting; the redacted
message keeps the original port so it can still help diagnosis.

Crash events exclude clean process exits and known app shutdowns, including
backend processes deliberately stopped for an updater handoff. An unexpected
`killed` process remains reportable; a signal alone does not prove shutdown.
Renderer crash log tails include the triggering reason and exit code. A closed
launcher stdout/stderr pipe is handled on that stream without quitting the app
or reporting an uncaught exception; other stream errors still propagate.

### Handled failures and diagnostic IDs

Beta also records handled Git action failures (request, branch, commit, push,
and PR stages), voice recording/transcription failures, Claude compaction request
failures or uncertain acceptance, failed/uncertain Claude cache reviews, and
backend startup blocks, and server event-loop stalls. These use the existing `app.error` envelope with a fixed
`Handled issue: <code> (<reason>)` message. They are not crash reports. The issue
allowlist lives in `DesktopDiagnosticIssue` in `packages/contracts/src/ipc.ts`.
No new event names or ingest fields are required by this change.

`server.event-loop.stall` uses that same shared issue allowlist and carries only
bounded `durationMs`. The collector passes its fixed message and duration context
through `diagnosticsRedaction.ts` before queueing. CPU, memory, system load,
percentiles and stacks are not attached to the stall issue. Backend warnings have
a 30 second limit; the existing issue collector also groups identical reports
for ten minutes and applies its shared hourly cap. Stable emits no stall issue
markers. See [local stall monitoring](event-loop-stalls.md) for status/UI behavior
and the attribution limitations.

The reason is a coarse local classification (authentication, invalid response,
timeout, output limit, live database owner, unknown owner, or unknown). It does
not prove a root cause. Reports may include elapsed operation time, rounded to
milliseconds, in the existing bounded context field. They never serialize the
original exception, command arguments, Git output, voice/audio/transcript data,
chat or project identifiers, database paths, or lock-owner PIDs. Existing activity
and memory context still passes through the shared redactor.

Git and cache-review terminal failures are reported by the Beta backend through
a bounded, validated desktop log marker, even when the affected chat is not open.
Renderer failures are reported when the UI observes them; opening an already
failed cache review can therefore report an older failure. Cancellations and
pending compaction/approval states do not generate these reports. No operation
deadline or automatic retry is added.

Error toasts and cache-review errors offer **Copy diagnostic ID** when a report
was queued successfully. Beta startup-block dialogs also expose the ID. It is
the existing top-level event UUID, not a user or thread identifier. Identical
code/reason pairs share an ID for ten minutes, including backend/UI duplicates,
and use the existing shared 30-errors-per-hour cap. This ID identifies a grouped
report, not every occurrence. Rate-limited or unwritable reports offer no new ID.

**Report queued locally** means upload has not been confirmed; offline reports
retry through the existing bounded queue. **Report sent** means the ingest HTTP
endpoint returned success, not that a maintainer reviewed it or that storage was
independently verified. **Upload not confirmed** covers expired in-memory status
or a report removed by queue trimming. Status is bounded to 128 recent issue
reports and does not survive desktop restarts. New issue reports request a
nonblocking flush; regular retry and shutdown behavior remain unchanged.

Stable and ordinary browser clients expose no issue-reporting bridge. Stable
desktop starts no backend issue detector, and Stable backends emit no issue
markers. These additions do not enable diagnostics for Stable.

Beta also keeps a small action history in main-process memory: the last 24
allowlisted activity entries within 10 minutes, with timestamps and
started/succeeded/failed phases. Categories cover sending/stopping/opening chats,
unblocking, creating/importing projects, workspace searches/reads/changes,
browser opening/navigation/resizing, window resizing, and RPC reconnect interruptions.
They describe observed operations, including background requests, not guaranteed
user clicks. Browser actions record their start; RPC actions also record their outcome.
No RPC arguments, prompts, identifiers, project names, file paths, URLs, DOM text,
or arbitrary action labels are included. Resize activity is throttled.

Every 30 seconds Beta samples aggregate Electron working-set memory (MiB) for
main, renderer, GPU, and utility processes, retaining four samples. This does
not measure the separate backend's Node heap. Recent activity and memory samples
are attached to existing error stacks and crash log tails within their existing
size limits and pass through the shared redactor. Actions and memory samples do
not create their own uploads or disk records; Stable exposes no collection bridge
and starts no sampler. Context can help correlate failures with preceding work,
but is not a proof of causation and cannot reconstruct older reports.

`update.check` records the start of a check, not a successful result. Its
`outcome: "ok"` means the attempt started. Failures emit `update.error` with the
check/download/install context and a redacted updater message.
Download and install failures emit this event even when the UI keeps the
`available` or `downloaded` status so the user can retry. Repeated broadcasts of
the same failure do not emit another event; a new failed attempt does.

`usage.daily` works differently from the other events: the main process cannot
read the projection database, so the server writes
`~/.synara-beta/diagnostics/usage-snapshot.json` every 6 hours (counts only —
provider names, thread and turn counts, project count) and the main process
relays it once per UTC day. `beta.installed` is emitted once, on the first
backend start after a fresh install, and says whether stable data was imported.
`beta.left` fires when you switch back to stable and says only whether the beta
app was moved to the Trash.

Every event also carries: a random per-install UUID, `flavor: "beta"`,
`platform`, `arch`, the app version, and a timestamp; `app.start` additionally
carries the OS version (major.minor) and UI language. The install UUID is
generated locally on first launch (`crypto.randomUUID`) — it is not derived
from your hardware, account, or IP.

Crash dumps: Electron's `crashReporter` uploads minidumps to the diagnostics
endpoint. Minidumps are memory snapshots of the crashed process and can in
principle contain fragments of that process's memory; they are stored in R2 and
can't be redacted. They are kept with no expiry date.

## What usage counters do not collect

- Chat messages, prompts, agent output, or transcripts (usage events carry counts only)
- File contents, workspace contents, project names, or git metadata
- Provider keys, tokens, or anything under `secrets/`
- IP-derived identifiers, device IDs, or account identity
- Screenshots, window contents, or keystrokes

These are not intentionally sampled for the usage counters. Free-text error
fields may still contain fragments of work despite redaction, and raw crash
minidumps can contain fragments of process memory, including sensitive data.

The only free-text fields are `message`, `stack`, and `logTail`. Before they
are written to the queue, each is passed through `redactDiagnosticText`
(`packages/shared/src/diagnosticsRedaction.ts`), which strips PEM blocks, git
remote URLs, emails, URL credentials, query strings, and the path of every
network URL (`https://github.com/org/repo` becomes `https://github.com/…`),
`Authorization`/`Bearer`/`Cookie` values, known token shapes (API keys,
GitHub/Slack/AWS/Google tokens, JWTs), sensitive `key=value`/`key: value`
fields, IP addresses, and any remaining long opaque token (hex, base64url, or
standard base64). Paths are reduced to the last segment: `/Users/you/code/my-repo/app.ts` becomes `~/…/app.ts`, so
folder and repository names, including directory names containing spaces on
Windows and POSIX, are not sent. Network error codes (`net::ERR_*`) and Node
stack locations remain readable instead of being mistaken for IPv6 addresses.
Redaction is best-effort — error
text can still include fragments of whatever was on screen. The worker runs
the same redaction again before storing.

Renderer error fields use the same shared redactor before crossing the bounded
IPC bridge. PEM blocks are removed whole before the field length limit is
applied, so truncation cannot leave a key fragment for the main process to
misclassify. The main process redacts these fields again before queueing them.
Loopback HTTP/WebSocket URL hosts become `localhost`, keeping their ports
readable and recognizable for fingerprint grouping across both redaction passes.
External IP addresses remain redacted and external ports remain distinct.

## Transport and storage

Events are buffered to `~/.synara-beta/diagnostics/events.jsonl` and flushed in
batches as NDJSON over HTTPS to `https://synara-beta-diagnostics.kartik-9f9.workers.dev`
(override with `SYNARA_BETA_DIAGNOSTICS_URL` for local development; only `https://`
or loopback targets are accepted). Events land in a Cloudflare D1 database and
are kept with no expiry date, so crash and error trends can be compared across
all beta releases. Crash dumps land in the `synara-beta-crash-dumps` R2 bucket
and are also kept with no expiry date. The ingest worker
and its private dashboard live outside this repository (they run on the
maintainers' Cloudflare account). The worker re-runs the same allowlist and
`redactDiagnosticText` and drops unknown events/fields, so the documented
schema is enforced at the endpoint, not just the client.

Ingest is intentionally open. Beta builds are public binaries, so any token
baked into them would be public too, and Electron's crash uploader cannot send
custom headers anyway. Abuse is bounded instead: per-IP rate limits (120
requests a minute for ingest, 10 for login), request and dump size caps, and
the server-side allowlist and redaction.

If the endpoint is unreachable the queue stays on disk and retries on the next
flush; if it grows past 1 MiB the client trims it to the newest 512 KiB of
events rather than letting it grow. Diagnostics never blocks the app: every
failure is swallowed.
