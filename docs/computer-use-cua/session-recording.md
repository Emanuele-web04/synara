# Session recording and replay — `computer_recording_*`, `computer_replay`

> Historical design. Recording/replay and the APIs/tests described below were
> removed from the current branch. They are not available tools or current
> verification evidence. Reintroducing them would be new work. See the
> [current implementation status](README.md).

Structured, bounded, local-only history for computer use, built beside the
[audit log](guardrail-gap-list.md) rather than replacing it. The audit log
still answers "what happened across every gated call"; a recording answers
"what did this one session do, and could it be done again safely" — with the
target identity and dispatch evidence a replay needs to re-resolve honestly.

This is not the Cua driver's raw session/event recording — that surface stays
internal per the parity matrix. Nothing here captures pixels: no screenshot,
frame, or video bytes are written at any fidelity, and clipboard contents are
never written at any fidelity.

Status: implemented and merged on `pr-1227`. All behavior below is
verified by `apps/server/src/computer/computerRecording.test.ts`,
`apps/server/src/computer/computerReplay.test.ts`, and
`apps/server/src/agentGateway/computerTools.recording.test.ts` against the
fake backend; no live desktop run has exercised the path yet, so end-to-end
claims on a real macOS driver remain unverified.

## Where files live

One NDJSON file per session under the server state dir:

```text
<stateDir>/computer-recordings/crec-<id>.jsonl
```

wired at `apps/server/src/computer/Layers/ComputerService.ts`. Files are mode
`0600` inside a `0700` directory — same posture as `computer-audit.jsonl`.
One open session per thread; `computer_recording_start` refuses a second.

## What a session file contains

```text
{"kind":"header", "formatVersion":1, "recordingId", "threadId", "turnId"?,
 "startedAt", "fidelity", "environment": {...fingerprint...}}
{"kind":"step", "seq":1, "ts", "tool", "actionClass", "threadId", "turnId"?,
 "approval", "declaredTarget"?, "resolutions":[...], "args":{...redacted...},
 "payload"?, "result"?, "dispatches":[...], "effect", "code"?, "latencyMs"}
...
{"kind":"end", "ts", "reason", "steps"}
```

Per step, the stored fields are:

- **Target identity** — `declaredTarget` (the caller's own `x`/`y`/`label`/
  `role`/`window_id`/`pid`/`app`, verbatim — the replay key) plus every
  resolution the call performed: `via` (coordinate/semantic/window/keyboard/
  app/process), `windowId`, `pid`, `app`, `bundleId`, `appVersion`,
  `windowBounds`, the resolved desktop `point`, the accessibility `nodePath`,
  `role`, `secure`, and subtree `elementTreeHash`. `windowTitleHash` and
  `labelHash` are `sha256:` digests, never the raw strings — a title carries
  a document name, which is exactly the incidental secret this file must not
  collect.
- **Action class** — `pointer`/`keyboard`/`text`/`semantic`/`clipboard`/
  `window`/`lifecycle`/`batch`/`replay`/`observation`.
- **Authorization path** — `approval.required` plus `decision`:
  `granted`/`denied`/`unavailable`/`skipped`/`not-required`. `skipped` is the
  honest name for a gated call that ran without a gate (the trusted-baseline
  case); `unavailable` names a gated call refused because no gate exists.
- **Dispatch effect** — `dispatches[]` per backend submission (action,
  window, point, and the delivery verdict `path`/`verified`/`effect`), and
  the step's final `effect`: `verified`/`dispatched-unknown`/
  `not-dispatched`/`refused`/`error` with a `code`. A call whose capture
  holds no dispatch records `not-dispatched`, never `dispatched-unknown` —
  the honesty rule shared with the audit log.
- **Verification evidence** — the delivery ladder verdicts ride inside
  `dispatches[].delivery`; a semantic resolution's `elementTreeHash` and
  `nodePath` are the re-resolution evidence.
- **Cleanup outcome** — where the call produced one, it rides the dispatch
  record's delivery fields; clipboard read-back lands on `result` as
  `{chars, sha256}` only — the text itself is never stored.
- **Arguments** — `args` after redaction (below); `payload` summarizes the
  first payload-bearing field as `{chars, sha256}` plus `captured`/`protected`
  markers.
- `latencyMs`, `ts`, `seq`, `threadId`, `turnId`.

`computer_run` produces one container step (`args.steps` =
`{count, types[]}`) plus one step line per inner step, each with its own
resolutions and dispatches — the batch is never a black box.

## Redaction contract

Default fidelity is `redacted`. Payload-bearing argument keys — `text`,
`value`, `arguments`, `files`, `clipboard`, `contents`, `data`, `payload` —
store `{chars, sha256}` at any depth in the args object; other strings are
length-capped. `full` fidelity (`computer_recording_start` with
`fidelity:"full"`, an approval-gated opt-in) keeps those payloads verbatim so
a replay can re-issue them — except:

- a step that resolved onto a protected control (an AX role spelling
  `secure` or `password`) keeps its payload hashed at **every** fidelity;
  there is no flag that lifts this;
- `result` (clipboard read-back) is always `{chars, sha256}`;
- `windowTitleHash`/`labelHash` are always hashes. The _declared_ label stays
  verbatim because it is the semantic replay key and it came from the model,
  not off the user's screen.

## Bounds and lifecycle ends

| Bound              | Value                                           |
| ------------------ | ----------------------------------------------- |
| Steps per session  | 2,000 — crossing it ends the session `step-cap` |
| Bytes per session  | 4 MiB — crossing it ends the session `byte-cap` |
| Session files kept | 64                                              |
| Aggregate bytes    | 32 MiB                                          |
| Session age        | 7 days                                          |

The sweep deletes oldest **closed** sessions first; an open session is never
swept. Sessions end deterministically: `computer_recording_stop`
(`"stopped"`), thread removal (`"thread-removed"`), control revocation
(`"control-revoked"` — the kill switch produces no evidence rows after it),
manager disposal (`"disposed"`), and the two caps. Writes are serialized on a
private chain and every write failure is swallowed — evidence collection
never fails the action it records, which also means a failing disk produces
a partial or empty record rather than an error.

## Readable history

`computer_recording_read` returns the parsed document plus `history`: one
plain-English line per step (tool, class, target, approval decision, effect,
latency) built by `computerRecordingHistoryLines` — no payload text ever
appears in it. `computer_recording_list` enumerates sessions;
`computer_recording_export` returns the raw NDJSON;
`computer_recording_delete` removes the file. `start`, `delete`, and
`computer_replay` are approval-gated; `stop`, `list`, `read`, `export` are
reads/cleanup and are not.

## Replay

`computer_replay` re-reads a session and classifies every step against the
**live** desktop. It never silently replays: dry run is the default, the tool
itself is approval-gated, and `execute:true` still re-admits driven-app
consent per mutating step before dispatch — replay cannot inherit yesterday's
consent.

Before per-step classification, the session's environment fingerprint is
compared to the live one: platform/backend/dialect/computer-id changes are
**major** drift; display, element-tree, or app-inventory changes are
**minor**. Drift is reported, not a veto — the per-step fresh resolution is
what decides readiness.

A step is `ready` only after fresh target resolution:

- **Coordinate steps** re-map the _recorded desktop point_ (never the raw
  screenshot pixels, which are meaningless without their frame) through the
  window's fresh bounds. An unscoped absolute point survives only while the
  display fingerprint is unchanged.
- **Window/keyboard steps** require the recorded `windowId` to still exist —
  or exactly one live window owned by the same app (`app-remap`). Two
  candidates or none blocks the step; a guessed window is the failure mode
  replay exists to prevent.
- **Semantic steps** re-walk the recorded `nodePath` on a fresh tree and
  check role plus `labelHash` (`node-match`/`node-changed`/`node-gone`).
- **App steps** re-launch by name; **process steps** require the recorded
  pid still running or exactly one running app of the same name.
- **Aimed scrolls** keep their window scope: a window-scoped scroll whose
  window is gone blocks rather than degrading into an unscoped scroll.

Blocked, never approximated: protected-field payloads, steps whose payload
the fidelity kept only as a hash (a hash cannot be retyped), ambiguous or
missing targets, stale semantic nodes. Read-only calls, `computer_run`
containers, and the recording family's own steps classify `skipped`, not
re-issued. `computer_wait` is the one non-mutating step replay re-runs — a
sequence's timing is part of what made it work — capped at the tool's own
bound.

Under `execute`, each `ready` step dispatches through the manager's own
methods in order — the second resolution, denylist, window guards, and
delivery verdicts are the same code a live call runs — and the report counts
`dispatched`/`skipped`/`blocked`/`failed` with per-step delivery verdicts or
refusal codes.

## Honest limits

- The store swallows write failures by design; a recording is best-effort
  evidence, not a guaranteed-complete ledger. The separate audit log has the
  same posture.
- `full`-fidelity files hold typed text in plaintext — bounded, local, and
  permissioned like the rest of the state dir, but they are the reason
  `redacted` is the default and `start` is approval-gated.
- Replay verifies what the backend verifies: a re-dispatched step's
  `dispatch.ok` means the live path accepted it, not that the user's screen
  looks the way the model expected. `effect` reports the delivery verdict
  the second run earned.
- Recorded `label`/`role` strings are caller-supplied; replay re-resolves
  them, it does not trust them.
