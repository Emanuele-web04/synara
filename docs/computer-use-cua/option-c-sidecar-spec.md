# Option C sidecar spec

Decision context, settled. Kartik chose option C. The patched Rust cua-driver stays as the transport and AX engine and admission gate. A thin native sidecar covers what Rust does awkwardly. No Swift rewrite of the driver.

## Problem

The agent cannot type into a background app while the human types elsewhere. The two input streams conflict. The frontmost window can lose focus. The handoff describes this in section 5.2 as the core isolation problem, and section 4.1 documents how Codex answers it with per-process delivery plus synthetic focus belief.

Some apps demand active state before they accept input. Electron class apps are the known hard case. They check key window or active app state and drop events that a plain background post delivers. This matches parity Gap summary item 2 on synthetic focus belief in `docs/computer-use-cua/v2-parity-matrix.md:42`, which unlocks the click, Electron, and key window gaps.

The typing isolation gap is proven, not theoretical. The parity matrix records that three window typing failed at rev 15 with effect dispatched-unknown in `docs/computer-use-cua/v2-parity-matrix.md:41`. Synthetic key activation without raising is Gap item 7 in `docs/computer-use-cua/v2-parity-matrix.md:47`. Electron click masking is Gap item 11 in `docs/computer-use-cua/v2-parity-matrix.md:51`. This spec must agree with all four rows.

## Current state

The driver pin is cua-driver 0.28.2 at native revision 18, per `packages/shared/src/cuaDriverRelease.json:2` and `packages/shared/src/cuaDriverRelease.json:5`. The protocol constants derive from that manifest in `packages/shared/src/cuaDriverProtocol.ts:4`.

The gate facts from rev 1 still hold, per `apps/desktop/patches/cua-driver/README.md:10` and `apps/desktop/patches/cua-driver/README.md:14`. Input admission closes irreversibly per driver process. Keyboard and mouse guards prepare matching releases before a down event. Release runs on return, failure, cancellation, and unwind. The private cancel_input path accepts only the authenticated embedded parent and the exact child PID. Cleanup acknowledgement requires zero pending input and drained contexts. The host never kills or replaces a generation without that acknowledgement when input was ever dispatched.

Semantic text delivery is the current isolation mechanism. Rev 10 added exact semantic-only text through a retained AX element token with no activation and no process scoped key events, per `apps/desktop/patches/cua-driver/README.md:67`. Rev 11 made it progressive and concurrently admissible across exact windows, per `apps/desktop/patches/cua-driver/README.md:74`. Rev 12 rejects a second concurrent native lease for the same exact PID and window, per `apps/desktop/patches/cua-driver/README.md:82`. Rev 13 keeps a stable semantic lease across Space moves under strict revalidation, per `apps/desktop/patches/cua-driver/README.md:87`. Rev 15 rebased all of this onto 0.28.2, per `apps/desktop/patches/cua-driver/README.md:100`.

The driver and host split is clean. The host spawns one embedded daemon per generation with a private socket in `apps/desktop/src/cuaDriverHost.ts:608`. It checks the capability with a timing safe compare in `apps/desktop/src/cuaDriverHost.ts:278`. It retires through cancel_input with a five second bound in `apps/desktop/src/cuaDriverHost.ts:802`. The host listens on a private unix socket with one newline JSON request per connection in `apps/desktop/src/cuaDriverHost.ts:222`.

There is no focus enforcer today. The only focus repair is foreground restore. ComputerManager raises the target, runs the input, then puts the prior frontmost window back, per `apps/server/src/computer/ComputerManager.ts:1410`. Nothing tells a background app it is active or key. Nothing synthesizes focus belief. Nothing masks activation. Nothing instruments focus theft.

The fixtures already cover the failure shape. The electron fixture runs three background semantic targets while sampling OS focus — every sample must stay null, since the app must never become frontmost — in `apps/desktop/src/cuaFixtures/electron.ts:291`, and scores the three window focus neutral case in `apps/desktop/src/cuaFixtures/electron.ts:338`. The native fixture admits input only after PID, title, and WindowServer id agree, per `apps/desktop/src/cuaFixtures/native.ts:23`. The cancellation fixture proves release through app owned event counts, per `apps/desktop/src/cuaFixtures/cancellation.ts:9`.

## Approach

Driver stays gate. Sidecar stays helper. The driver keeps admission, dispatch, leases, Space revalidation, cleanup acknowledgement, and effect semantics. The sidecar never admits input. It never dispatches on its own. It never bypasses the gate. Every sidecar assisted action still passes driver admission and still reports verified only on native read back. Uncertain effects are never replayed.

Sidecar responsibilities, exactly four:

1. Synthetic focus belief. Post AppKit defined and CPS process notification events per pid so the target believes it is active and key. Use the resolved constant table from the handoff update block: NSEvent type 21 for process notifications, with NewFront 0x0002, LostKeyFocus 0x1000, KeyFocusTaken 0x4000, KeyFocusReturned 0x8000, KeyFocusChanged 0xF102, LostTypingFocus 0xF105, TypingFocusChanged 0xF107. Behavioral effect of the typing focus values is unverified until the canary probe runs.
2. NSEvent first event construction. Build mouse and keyboard events as NSEvent objects first, then convert to CGEvent, then stamp the per process fields. This gives AppKit identity that from scratch CGEvents lack. Exact field values for our stack are unverified until measured against real targets.
3. Level 25 visual masking as a last rung only. When belief alone cannot satisfy an Electron class app, raise the user's windows to level 25, activate the target behind them, deliver the single action, then restore. Masking is never the default. It never replays an uncertain action. Menu bar flash during masking is unverified for our stack.
4. Richer per agent cursor. One overlay cursor per agent with distinct identity. Visual only. It never aims input.

Driver stays gate responsibilities, exactly five: input admission per exact target, single transport dispatch, semantic lease concurrency, Space membership revalidation, cleanup acknowledgement with fail closed retirement. None of these move to the sidecar.

Three flag belief policy. The sidecar keeps three flags per pid: applicationIsActive for genuinely frontmost, applicationBelievesItIsActive for synthetically told active, applicationBelievesItHasFocus for synthetically told key. It posts nothing when the target already believes it is active and focused. It re-asserts only the missing flag. It confirms belief through the AX side where the platform allows it. Polling semantics for belief confirmation are unverified.

Action ladder, in strict order. First try AX actioning with zero activation. Then try per pid synthetic delivery with belief asserted. Then, only for app classes that provably need it, masked activation as the last rung with restore. Any rung that reports uncertain stops the ladder. The caller may try a different target. It must not retry the same uncertain action.

Focus theft instrumentation. The sidecar samples frontmost pid, key window, AX focused element, and synthetic event counters around every assisted action. A theft is any change to the user's frontmost or key state caused by our action. Theft samples are recorded per action and asserted in tests. Sampling overhead budget is unverified.

## Interfaces

Transport shape. The sidecar speaks newline JSON over a unix socket, one request per connection, same pattern as the host listener in `apps/desktop/src/cuaDriverHost.ts:222`. Capability handshake mirrors the host check in `apps/desktop/src/cuaDriverHost.ts:278`: a random capability of at least 32 bytes, compared with a timing safe compare, never inherited, never logged. Requests carry the same task attribution shape the host parses, and the sidecar rejects unattributed mutating calls.

Proposed method names, exact:

- sidecar.focus_assert. Args: pid, optional window id, wanted flags. Effect: post only the missing belief events. Returns flags after, plus what was posted.
- sidecar.focus_release. Args: pid. Effect: withdraw synthetic belief, re assert the true front process view. Returns flags after.
- sidecar.event_post. Args: pid, optional window id, NSEvent built event envelope. Effect: none on its own. This method only constructs and stages the event bytes. Dispatch still goes through the driver gate.
- sidecar.mask_activate. Args: pid, window id, reason code. Effect: level 25 masking run for one action, with restore. Refused unless the caller cites a prior belief insufficiency proof for that app class.
- sidecar.theft_sample. Args: none. Effect: read only. Returns frontmost pid, key window id, AX focused element ref, and event counters.
- sidecar.health. Args: none. Effect: read only. Returns version, constant table id, masking availability, overlay availability.

Ownership of each call:

- The server owns targeting, approval, and ladder order. It decides which rung to try. It never calls sidecar.event_post and then dispatches around the driver.
- The driver owns admission and dispatch and acknowledgement. It validates the exact target at dispatch boundaries. It can refuse a sidecar staged action like any other.
- The sidecar owns belief synthesis, event byte construction, masking mechanics, and theft sampling. It owns no admission decision.
- The host owns sidecar process lifecycle. It spawns, handshakes, retires, and sweeps the sidecar the same way it manages driver generations. The retire acknowledgement pattern follows the driver retire path around `apps/desktop/src/cuaDriverHost.ts:802`.
- The gateway fixture owns the end to end chain proof through real handlers, per `apps/desktop/src/cuaFixtures/gateway.ts:12`. The live fixture owns the loopback provider proof, per `apps/desktop/src/cuaFixtures/live.ts:12`.

Request envelope, proposed:

- Each request is one JSON object plus newline. Fields: method, capability, task, args, idempotency key. Replies mirror the driver reply shape with ok, result or error, and effect. Effect uses the same three values: verified, not-dispatched, dispatched-unknown. The sidecar never invents a fourth effect.
- Dispatch helper shape follows the host to driver call in `packages/shared/src/cuaDriverProtocol.ts:54`, with a bounded timeout and no silent retry.

## Acceptance criteria

Three concurrent targets type while a human types in a fourth. Each target receives its exact text. The human stream shows zero injected characters. The frontmost app never changes. This runs 10 times in a row with zero theft. The existing three window sentinel case in `apps/desktop/src/cuaFixtures/electron.ts:338` is the starting harness. The human fourth app is a new manual leg with a sampled focus log.

Electron matrix passes. Typing and clicking work with result read back in VS Code, Slack, Notion, Cursor, and WhatsApp. Each app records which rung satisfied it: AX first, belief assisted, or masked last rung. No app uses masking unless belief provably failed for it. Exact per app rung table is unverified until the matrix runs.

Space churn survives. Moving the agent target across Spaces mid run never wedges the run. Focus sensitive actions cancel cleanly. Stable semantic leases continue only where ownership, membership, ancestry, and geometry revalidate. Off Space pixels stay freshness unverified and never ground live input.

Masking restores. Every masked activation returns the user's windows and levels within the stated bound. The bound is 500 ms from delivery to restore in this spec, unverified as achievable until measured. Any missed restore is reported with the window named, never silent.

No gate regressions. The gate, cleanup acknowledgement, and never replay uncertain rules hold for every sidecar assisted path. A refused belief assertion never becomes a foreground promotion. A dispatched unknown result never retries automatically.

## Tests and evidence

Fixture mapping in apps/desktop/src/cuaFixtures, existing files:

- electron.ts owns the three window focus neutral proof and the moved, minimized, and closed target refusals. Extend it with the human fourth app leg and the per app rung table.
- native.ts owns the identity agreement proof before any input. Extend it with belief assertion against a scratch AppKit target that reports its own active and key flags.
- gateway.ts owns the real handler chain proof. Extend it with a sidecar assisted leg that still passes approval, targeting, and effect semantics.
- cancellation.ts owns the release proof through app owned counts. Extend it with a mid belief cancel that still drains guards and reports partial or uncertain honestly.
- live.ts owns the loopback provider proof. Use it for the 10x repeat run and the focus sample log.

New instrumentation tests, all sandbox safe:

- Belief policy unit tests. Three flags, no repost when belief holds, minimal re assert when one flag drops, withdraw on release. Pure logic, no native calls.
- Theft sampler tests. Scripted frontmost and key sequences assert theft detection fires exactly once per induced steal and never on clean runs.
- Mask restore tests. Scripted raise, deliver, restore ordering with a fault injected at each step. Assert restore is attempted and misses are named.
- CPS constant canary. A small signed helper in the operator session posts each notification value to a scratch app and records which value moves which flag. This resolves the typing focus values behaviorally. Results land in the evidence dir before any product code depends on them. Outcome is unverified until run.

Evidence per run: report JSON plus before and after images under the existing evidence dir pattern. Each run records driver version and native revision, sidecar version and constant table id, per action rung used, per action theft samples, and restore outcomes. Rev 15 runtime behavior stays uncertified until a signed app run with fresh permissions passes.

## Risks

Private API drift. SkyLight entry points, event record layouts, and CPS subtype values can shift across macOS releases. The 26.4 argument order hazard did not reproduce on 26.5.1 with the driver call pattern, but the canary probe stays mandatory before any OS bump. Every private path needs an availability flag and a fail closed refusal. Never make one private API the only route to a capability without a documented refusal path.

Constant table conflict. Two community reconstructions disagree on CPS values. The handoff update block resolves the values from the shipping Codex binary, but behavioral effect on our targets is unverified. The canary in Tests and evidence must run before the sidecar depends on the typing focus values.

TCC identity. Accessibility and Screen Recording grants attach to the signed bundle. Ad hoc rebuilds can strand grants. The sidecar must ship under a stable signing identity owned by the app. A rebuilt sidecar with a new identity must fail closed with a stale grant message, never with a silent input failure.

Gatekeeper and sandbox. Freshly compiled helpers are killed on exec in the assistant sandbox and can pop a user facing dialog. Native probes run only in the operator session or the signed app. No stray binaries stay in the repo.

Patch and manifest coupling. The driver stamps its revision from a literal, not the manifest. Any bump must change both together or the handshake fails and daemons retire at spawn. The sidecar adds its own version and constant table id to the same handshake discipline.

Masking visibility. Level 25 masking can flash the menu bar. This is cosmetic but user visible. Keep masking rare, bounded, and logged. A transparent fullscreen overlay at level 25 is the candidate fix, unverified for our stack.

Performance. Belief assertion and theft sampling add latency to every assisted action. Budgets stay explicit. Observation bounds already exist for foreground and background delivery. If assertion exceeds budget, the action refuses instead of degrading silently. Budget numbers are unverified until measured.

## Open decisions

1. Sidecar language. Recommendation: Swift for AppKit and NSEvent ergonomics. Safe default: stay in Rust inside the existing driver process if Swift ownership is unavailable, and accept slower belief iteration.
2. Socket topology. Recommendation: separate sidecar socket owned by the host, so driver and sidecar retire independently. Safe default: same host socket with a method prefix, accepting coupled retirement.
3. CPS constant activation order. Recommendation: run the canary first, then enable the full table. Safe default: enable only NewFront, KeyFocusTaken, and KeyFocusChanged until the canary proves the typing focus values.
4. Masking overlay. Recommendation: ship the transparent fullscreen overlay at level 25 with the masking path. Safe default: masking without overlay, capped to the Electron matrix apps only, until flash is measured.
5. Cursor identity. Recommendation: per agent cursor with distinct color and name, matching the multi cursor gap. Safe default: single compact cursor unchanged until the overlay path is proven.
6. Masking authorization. Recommendation: per app class opt in recorded after a proven belief failure, visible in the rung table. Safe default: masking off entirely until the matrix proves a specific app needs it.
7. Agent Spaces pool. Recommendation: defer the pool. Enforce current Space routing only. Safe default: no pool creation, no Mission Control automation, until isolation is certified on one Space.
8. Certification route. Recommendation: local signed app runs first, device harness for final sign off. Safe default: local signed app only, and mark harness items uncertified.

## Implementer brief

Ordered steps. New file paths below are plain text, not yet in the tree. Existing files carry cites.

1. Read the decision context. Read the handoff sections 4.1, 5.2, and 11.3, plus Gap items 1, 2, 7, 11 in the parity matrix. Confirm option C scope before writing code.
2. Read the gate and host. Study the gate contract in apps/desktop/patches/cua-driver/README.md around `apps/desktop/patches/cua-driver/README.md:10`, the semantic lease rules around `apps/desktop/patches/cua-driver/README.md:74`, and the host spawn, handshake, and retire paths in apps/desktop/src/cuaDriverHost.ts around `apps/desktop/src/cuaDriverHost.ts:608`, `apps/desktop/src/cuaDriverHost.ts:278`, and `apps/desktop/src/cuaDriverHost.ts:802`.
3. Run the CPS canary. Write a small signed helper in the operator session. Post each notification value to a scratch AppKit app. Record which value moves active, key, and typing focus. Save the table as evidence. Do not build belief on unproven values.
4. Build the sidecar skeleton. New files: apps/desktop/src/cuaSidecar/main.swift, apps/desktop/src/cuaSidecar/belief.swift, apps/desktop/src/cuaSidecar/masking.swift, apps/desktop/src/cuaSidecar/theftSampler.swift. It serves newline JSON on a private socket, checks the capability, and answers sidecar.health and sidecar.theft_sample first. No mutating path yet.
5. Add the host owner. New file: apps/desktop/src/cuaSidecarHost.ts. It spawns, handshakes, retires, and sweeps the sidecar, mirroring the driver host discipline. Wire its lifecycle next to the existing host, never inside driver admission.
6. Add belief methods. Implement sidecar.focus_assert and sidecar.focus_release with the three flag policy. Add sidecar.event_post as construct and stage only. Prove staging never dispatches by unit test.
7. Add masking last. Implement sidecar.mask_activate with the level 25 raise, single delivery through the driver, and bounded restore. Gate it behind the per app class opt in. Default off.
8. Add per agent cursor. Extend the existing cursor overlay path with identity per agent. Keep it visual only. Prove it never aims input by test.
9. Extend the fixtures. Update apps/desktop/src/cuaFixtures/electron.ts around `apps/desktop/src/cuaFixtures/electron.ts:291` with the human fourth app leg, the rung table, and the 10x repeat mode. Add belief legs to apps/desktop/src/cuaFixtures/native.ts, a sidecar leg to apps/desktop/src/cuaFixtures/gateway.ts, and a mid belief cancel to apps/desktop/src/cuaFixtures/cancellation.ts.
10. Run the matrix and certify. Run the Electron matrix, the Space churn run, and the 10x repeat in a signed app with fresh permissions. Save report JSON and images as evidence. Mark anything not run as uncertified.
11. Final checks. Run fmt, lint, typecheck, and the affected Vitest suites. Confirm no gate, acknowledgement, or replay rule was weakened. Report what ran, what passed, and what stays unverified.
