# Get Codex Working in the UI on Daytona — Gap Analysis & Build Plan
**Goal:** a user clicks "Remote → Daytona" in the web UI, sends a message, and a real `codex` agent runs inside a real Daytona cloud sandbox and streams its turn into the conversation.

**Status now:** the per-session remote transport seam is wired (codex events can reach the UI), real-vs-fake Daytona client selection works from saved credentials, and a gated live e2e proves a real codex turn _can_ stream from a sandbox. The app path does **not** yet work end-to-end. 32 gaps stand between here and a working UI click, found by an 8-investigator parallel trace and an adversarial completeness critic.

This plan folds in the critic's corrections to the raw machine output.

* * *
## The 32 gaps, grouped
### A. Auth (codex can't authenticate in the sandbox) — the real headline
- **g2 (blocker)** No code writes `auth.json` into the sandbox. Codex starts unauthenticated and prints non-JSON login text → fails `JSON.parse`. Only the e2e hand-injects auth. `CodexAdapter.ts:1586` even says CODEX_HOME is "deliberately NOT forwarded" — but nothing populates it.
  
- **g7 (major)** `RuntimeCredentialBroker.grantFor` is dead wiring (returns opaque handles, zero callers, never resolves to a value).
  
- **g31 (minor)** Daytona egress to the OpenAI auth/refresh endpoint and `auth.json` writability (for token refresh) are unverified.
  
- **MISSING-1 (blocker)** `buildShellCommand` runs commands bare (`cd '<dir>' && env K=V 'codex' 'app-server'`) with **no** `bash -lc` login shell, while `wrapInPty` uses `script`. So codex-on-PATH and `$HOME`-relative auth path resolution are both unverified — auth injection that writes `$HOME/.codex/auth.json` may land in the wrong place.
  
- **MISSING-2 (major)** codex app-server may need a writable `CODEX_HOME` and a minimal `config.toml` (approval-policy / sandbox-mode / model) to start cleanly; g2's "do NOT copy host config.toml" throws the baby out (host config references a local browser-use socket, but a _minimal_ config is still needed).
  
### B. Transport / JSON noise (the visible symptom)
- **g4 (blocker)** The Daytona PTY (`script -qfec`) merges stdout+stderr into one stream (`stderrLines: Stream.empty`), so codex's timestamped log lines hit `JSON.parse` → a user-visible `protocol/parseError` per line. `codexAppServerManager.ts:2138`.
  
- **g24 (major)** `pendingEcho` echo-suppression is fragile; an unmatched echoed outbound frame is valid JSON and gets mis-dispatched as a fake inbound server request (silent protocol corruption).
  
- **g18 (major)** parseErrors flood the transcript as un-deduplicated error rows + a flapping banner.
  
- **g27/g28 (minor)** unterminated exit-time residual fragment; unbounded `stdoutQueue` amplifies noise.
  
- **Critic correction:** the parseError flood is **partly the unauthenticated-login text**, not just log noise — so **auth (A) must land together with the JSON fix**, not after it. The frame-gate ("skip lines not starting with `{`") is correct but must route ERROR lines through `classifyCodexStderrLine` so real errors still surface.
  
### C. Credentials timing & fake fallback
- **g1 (blocker)** Real-vs-fake is chosen once at server boot (`providerCredentialLayer.ts:57` `Layer.unwrap`). A key saved in Settings needs a server restart. (This is why I had to hand-write the secret + restart.)
  
- **g5 (major)** Remote-Daytona with no creds silently fake-forwards to a local codex spawn (`failed to spawn codex`); no pre-provision credential check.
  
- **g6 (major)** Post-restart provision fallback hard-codes `fake` for a real-Daytona thread instead of reading the persisted provider.
  
- **g20 (blocker)** The composer's "Remote" always means "Fake remote" — it ignores the configured default provider (`RuntimeEnvironmentControl.tsx:58` defaults to `fake`).
  
- **g26 (minor)** Three docstrings contradict each other on when a credential change takes effect.
  
- **Critic correction:** the per-sandbox client cache must also solve **layer wiring** — the real client needs `HttpClient` in its `RIn`; a per-call dispatcher must have both impls provided.
  
### D. Snapshot / working dir
- **g3 (blocker)** App provision always sends `snapshotId: null` (`runtimePresentation.ts:250` hardcoded); a codex image loads only if `daytona.snapshot` is set, with no UI signal.
  
- **g9 (major)** No codex-presence/version probe and no product-default codex snapshot; a codex-less snapshot fails late as an opaque JSON/transport error.
  
- **g10 (major)** `sandboxes.defaultSnapshot` is a dead setting (in contracts + UI, mapped to nothing).
  
- **g11 (major)** No repo/workspace is cloned into the sandbox; the agent runs in an empty home dir.
  
- **g8 (major)** Snapshotting a post-auth instance bakes expiring ChatGPT tokens into a reusable base image.
  
- **g32 (minor)** Model-selection mismatch can wedge `initialize`/turn once auth+snapshot are fixed.
  
- **g12 (downgraded to minor by critic)** remote cwd already converges to the discovered root; the fix targets a near-dead path.
  
### E. Lifecycle (sandbox torn down or leaked)
- **g13 (blocker)** The idle reconciler destroys the sandbox mid-conversation because `lastActivityAt` freezes (stream output is not event-sourced).
  
- **g14 (blocker)** The activity-lease keepalive is dead code, so Daytona auto-stops the sandbox under a live agent.
  
- **g23 (major)** Stop/restart doesn't kill the remote PTY → orphaned codex processes pile up.
  
- **g21 (major)** Deleting a thread leaks the sandbox (no `destroy` call).
  
- **g22 (major)** `ProviderSessionReaper` orphans the sandbox + races the reconciler (two uncoordinated 30-min sweeps).
  
- **g25 (major)** Reconnect after server restart recovers the sandbox but shows a phantom "running" turn.
  
- **Critic correction:** the lease keepalive must use `adapter.refreshActivity` on a timer — do **not** re-event-source every output line (that volume was deliberately removed).
  
### F. Settings UX
- **g15 (major)** No server-truth "secret configured" signal — the badge only reflects this-session typing.
  
- **g16 (major)** A blank secret input sends `""` and **clears the stored key** (silent data loss), contradicting "leave blank to keep".
  
- **g29/g30 (minor)** secrets in plaintext localStorage; provider/snapshot pickers don't show configured-state.
  
### G. UI / operability
- **g17 (major)** Provisioning failure reason is popover-only — no banner, no retry.
  
- **g19 (major)** "Provisioning" chip can sit forever (provisioning deferred to first turn, no cue).
  

* * *
## Corrected build order (dependency-aware)
The critic's key ordering fix: **auth and JSON-noise are co-blocking** — a real turn can't stream until both land. MVP critical path to a single streaming turn = S1 → S2 → **S3+S4 together** → S7.

| Slice | Title | Closes | MVP? |
| --- | --- | --- | --- |
| **S1** | Per-provision cred resolution + missing-creds preflight (no restart needed) | g1,g5,g6,g26 | ✅   |
| **S2** | Snapshot + provider threaded UI→plan→create; kill dead `defaultSnapshot` | g3,g10,g20 | ✅   |
| **S3+S4** | JSON-noise frame-gate **+** codex-auth injection **+** `bash -lc` login shell **+** minimal `config.toml` | g2,g4,g7,g18,g24,g27,g28,g31,MISSING-1,MISSING-2 | ✅   |
| **S5** | Snapshot/auth taint + re-inject-on-resume + codex presence/version probe + model validation | g8,g9,g32 | ✅ (probe) |
| **S6** | Remote cwd unification + repo clone into sandbox | g11,(g12) | ◑   |
| **S7** | Activity lease keepalive (refreshActivity timer) so live turns aren't torn down | g13,g14 | ✅   |
| **S8** | Lifecycle teardown: destroy-on-delete, reaper, PTY kill, reconnect aborts | g21,g22,g23,g25 |     |
| **S9** | Server-truth "configured" badge + blank-secret no-op | g15,g16,g29 |     |
| **S10** | Provisioning UX: failure banner+retry, deferred cue, configured hints | g17,g19,g30 |     |
| **S11** | Final checks + strengthen live e2e to the app path (assert zero parseError) | —   | ✅   |

Each build slice re-verifies against the real code before editing (the critic found stale paths/call-sites in the raw plan), implements, gets an adversarial review, and is fixed to checks-green.

* * *
## Open questions — your call (please answer inline)
{>>Q1 — Codex snapshot: ship which image as the product default codex snapshot? The only known-good one is the dated e2e literal `terry-vCPU-4-RAM-8GB-2026-05-27-20-58-54-codex`. Your current setting is `05829cf0-…` — does {==that image have codex installed?==}{>>yes that is the same one<<}{id="c1" by="user" at="2026-06-04T20:33:13.954Z"} <<}

{=={>>Q2 — Auth source: inject the host operator's `~/.codex/auth.json` into every sandbox (matches the e2e, works today, single-operator)? Or a per-user/server-managed codex credential? Host-auth is simplest for v1 but bakes one operator's ChatGPT tokens into each sandbox.==}{>>whatever is simplest for v1<<}{id="c2" by="user" at="2026-06-04T20:33:34.917Z"}<<}

{=={>>Q3 — Daytona egress: is outbound to the OpenAI auth/refresh endpoint open by default on your sandboxes? If blocked, long turns die when the access token expires.<<}==}{>>should be<<}{id="c3" by="user" at="2026-06-04T20:33:50.560Z"}

{>>Q4 — Scope for this run: build the MVP critical path only (S1, S2, S3+S4, S5-probe, S7, S11 → a single streaming turn), or all 11 slices (full lifecycle + UX hardening)?<<}

{>>Q5 — RuntimeCredentialBroker: convert the dead broker into the codex-auth resolver (needed for S5 taint gating), or delete it and inject inline for v1?<<}
