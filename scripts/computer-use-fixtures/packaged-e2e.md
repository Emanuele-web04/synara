# Isolated packaged Computer fixture

`packaged-e2e.ts` exercises a deliberately small macOS subset through the actual
packaged app and an explicitly selected provider/model. It creates fresh threads
through authenticated owner RPC, uses the shared diagnostic readers for metrics,
and checks the AppKit target's own counter state. Agent prose and audit counts do
not determine whether a click succeeded.

Required artifacts:

- A **Cua-flavor packaged application**, built with `--flavor cua`, including
  the current pinned native driver and its matching provenance. Production and
  Canary bundle IDs are refused. An ad-hoc local signature is not release signing
  or proof that existing macOS permissions still apply.
- `native-fixture` compiled from the current `NativeFixture.swift`, including its
  setup-only `focus-a` command. The existing `build-electron.mjs` fixture builder
  produces this executable inside the fixture bundle.
- `focus-probe`, built by `build-focus-probe.sh` or the existing fixture builder.
  Its responsible process needs observation permissions. Missing AX/window/Space
  coverage stops the run before spending provider tokens.
- A provider already installed and authenticated for this operator. Select its
  model explicitly; the runner neither chooses a different provider/model nor
  changes credentials. Node/Bun and workspace dependencies must be installed.

Acceptance setup requires the passive Computer availability probe to report `available`.
An idle host's disconnected/unavailable health is not a setup failure: its
physical-input listener starts only when the owned task uses Computer. Fresh
homes may initially have an empty provider-discovery cache; setup waits up to
45 seconds for the explicitly selected provider to appear. A known unavailable
or unauthenticated result fails immediately. Discovery and focus setup happen
before measured task time and before any paid provider turn.

Use a **new, nonexistent home directory** and an unused CDP port (both IPv4 and
IPv6 are checked). The runner launches through macOS LaunchServices, isolates the
Electron profile under that home, verifies the server's workspace storage belongs
to the same home, and never clones or resets production data. The desktop itself
chooses an unused backend port; its actual port is reported separately.

Prepare a new package for macOS permissions first. This needs only the packaged
bundle, isolated home, CDP port and workspace dependencies. It verifies the owner
connection and actual server home, records passive readiness, and leaves the app
open. It does not discover a selected provider, start a provider turn, enable
Computer, launch fixture targets or manipulate focus. Grant the exact Cua app's
permissions through its setup UI before continuing; passive availability alone
does not prove native permission grants.

```sh
nice -n 10 bun scripts/computer-use-fixtures/packaged-e2e.ts \
  --prepare-only \
  --bundle "$ISOLATED_CUA_BUNDLE" \
  --home /private/tmp/synara-computer-fixture-run-001 \
  --cdp-port 49231
```

Preparation writes `summary.json` with `mode: "permission-preparation"`,
`acceptance: "not-run"`, and `passed: false`, even when setup succeeds. No empty
run counts as qualification. Then attach to that same running instance with the
acceptance artifacts and explicit provider/model:

```sh
nice -n 10 bun scripts/computer-use-fixtures/packaged-e2e.ts \
  --attach \
  --bundle "$ISOLATED_CUA_BUNDLE" \
  --home /private/tmp/synara-computer-fixture-run-001 \
  --cdp-port 49231 \
  --native-fixture "$NATIVE_FIXTURE_EXECUTABLE" \
  --focus-probe "$FOCUS_PROBE_EXECUTABLE" \
  --provider "$BENCHMARK_PROVIDER" \
  --model "$BENCHMARK_MODEL" \
  --runs 2
```

Optional `--model-options` is a JSON object decoded through that provider's real
model-selection schema. `--turn-timeout-seconds` defaults to 180 (10–600).
`--attach` can reuse only a matching fixture-created home/bundle/CDP port; each
acceptance invocation still creates a new project directory and new threads.
Omit `--attach` to launch a new isolated instance directly when its package already
has the required permissions. `--skip-stop` is a diagnostic convenience and leaves
the stop/recovery gate unverified.

This owner-driven harness explicitly enables chat-mode Computer authority for
each fresh test thread and revokes it when that task settles. It does not rely on
a plain prompt being recognized as a `/computer-use` invocation, and it does not
change the product's per-turn invocation behavior or select a fallback provider.

The runner opens two controlled native fixture processes: one target and one
human-window surrogate. It establishes the human foreground window before arming
the sampler, then continuously records frontmost PID, key window, focused owner,
and active Space across all measured tasks. The top-window observation runs at
the sampler's lower cadence. No measured interval is excluded; missing required
fields, missing completion, excessive sample gaps, or even one observed focus
change invalidate the focus result. Evidence omits window titles and focused
text, including if the real user intervenes.

The default sequence is two independent single-click tasks, one longer task
interrupted after its first independently observed click, and a fresh-thread
single-click recovery task. Other fixture windows and text must stay unchanged.
Stop passes only when an interrupt was actually requested, the exact turn settles
as interrupted, and the counter remains unchanged during the subsequent 700 ms
observation. This bounded quiet interval does not prove absence of arbitrarily
late input. Signals and failures revoke Computer control and attempt to interrupt the owned active turn;
cleanup is reported as unproven if terminal state cannot be observed.

Reports are exclusive-create `0600` JSON under `HOME/evidence-TIMESTAMP/`.
Completed tasks use the existing collector's strict fresh-thread, call-ID,
retention and cumulative-token gates. The intentional stop trial keeps its
diagnostics but is not a completed-task benchmark. Providers without explicit
cumulative accounting can pass the independent task proof while leaving metrics
invalid. Output tokens are separate, and cached input is a subset of input.
Receipt metrics additionally report monotonic dispatch-to-first/last counter
change, final counter observation, and stop-request-to-terminal-observation
intervals. These include fixture IPC, runner scheduling and (for terminal status)
owner RPC polling delay. They are latency upper bounds, not exact OS delivery
timestamps. Missing observations remain null.

In acceptance mode, exit 0 means this named fixture subset passed all its gates.
With `--prepare-only`, exit 0 means only that permission setup is ready; acceptance
and native permission verification have not run. Exit 2 means saved evidence is
incomplete or a gate failed; 1 means setup could not be completed. The isolated app
remains open for inspection; any native target processes and owner RPC close.
No bearer, CDP response, transcript text, or tool arguments are written to reports.

This does **not** certify physical Escape, takeover recovery, permission setup,
Dock/window flashes, browser benchmark tasks, cross-Space behavior, sustained
CPU/RAM, the other providers, or Linux. Those require independent scenarios and
observers. `connectOwnerUrl` in `packaged-client.ts` and `collectComputerRun` are
reusable for a separately qualified Linux fixture; the AppKit oracle is macOS-only.

Focused offline verification:

```sh
nice -n 10 bun run --cwd scripts typecheck:computer-measurement
nice -n 10 bun run --cwd scripts test \
  computer-use-fixtures/measurement.test.ts \
  computer-use-fixtures/packaged-evidence.test.ts
nice -n 10 bun run --cwd apps/server test \
  src/diagnostics/ownerThreadDiagnostics.test.ts
```
