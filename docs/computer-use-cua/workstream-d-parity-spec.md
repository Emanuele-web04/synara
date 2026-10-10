# Workstream D: capability parity plus spec

Milestone one scope is settled. Menus and window frames are in. The Chrome CDP path is deferred. Locked use, record and replay history, and the Intel slice are out of milestone one. This spec agrees with `docs/computer-use-cua/v2-parity-matrix.md:32` and `docs/computer-use-cua/v2-parity-matrix.md:33` and Gap items 4 (`docs/computer-use-cua/v2-parity-matrix.md:44`), 10 and 11 (`docs/computer-use-cua/v2-parity-matrix.md:50`), 12 and 13 (`docs/computer-use-cua/v2-parity-matrix.md:52`), 14 and 15 (`docs/computer-use-cua/v2-parity-matrix.md:54`).

## Problem

Synara computer use covers the common actions. It still lacks menus and window frame control. Drag needs foreground. Hover does not exist as a real event. The cursor is overlay only with no per agent identity. Small gaps remain in secondary actions, app listing, text selection, and key coverage. Codex behavior claims in this area are unverified. They come from third party reconstructions and local binary scans. This spec closes the decided gaps and holds the rest out with reasons.

## Current state

Three native capabilities were deliberately unexposed when this spec was written. The audit named `invoke_menu`, `set_window_frame`, and `verify_state` as not agent facing. **Status 2026-09-17: all three now ship as `computer_invoke_menu`, `computer_set_window_frame`, and `computer_verify_state`**, behind per-action approval, exact PID/window revalidation, second-app consent, and Synara-side read-back — the conditions the audit set out (see `docs/computer-use-cua/capability-audit-2026-09-16.md` "2026-09-17 update"). `list_apps`, `zoom`, and `kill_app` shipped in the same pass as `computer_list_apps`, `computer_zoom`, and `computer_kill_app`. The audit's original reasons are still why the exposure took this shape: menus refuse missing/disabled items rather than fall to pixels, window moves verify against an independent `list_windows` read-back, and `verify_state` reports a tri-state that cannot contradict the scoped observation contract because it is read-only.

Drag was foreground only on macOS when this spec was written. **Status 2026-09-22, native rev 17: background drag is shipped and verified** — the driver admits window-local press-drag-release on exact targets (the `background_unavailable` gate is removed), `computer_drag` defaults to `delivery_mode:background` with explicit foreground fallback, both endpoints stay inside the window, and the 10 second cap is unchanged. Live evidence: text selected in an inactive Cocoa window with the operator's front process untouched (`input-matrix-2026-09-17.md`). Duration is capped at 10 seconds in `apps/server/src/computer/CuaComputerBackend.ts`. The gateway describes the drag shape in `apps/server/src/agentGateway/computerTools.ts`.

There is no hover promise. The move cursor tool only draws an overlay on macOS. It delivers no hover events and opens no hover menus, stated in `apps/server/src/agentGateway/computerTools.ts:2605`. The backend reports the overlay only delivery path in `apps/server/src/computer/CuaComputerBackend.ts:1138`. The limits table states the cursor does not promise a real hover in `docs/computer-use-cua/README.md:67`. **Status 2026-09-17: the underlying question is now settled — a real background hover is not deliverable on macOS through pid-routed synthetic moves, which the OS drops unless the user's own cursor is already inside the target window.** The probe record is `docs/computer-use-cua/hover-verdict-2026-09-17.md`.

Secondary actions are AXPress only. The dialect list allows one name on macOS in `apps/server/src/agentGateway/computerTools.ts:2747`. The backend refuses every other action name in `apps/server/src/computer/CuaComputerBackend.ts:1303`. The supported action check is exact in `apps/server/src/computer/CuaComputerBackend.ts:1301`. The limits table confirms no synthetic semantic fallback in `docs/computer-use-cua/README.md:64`. **Status: landed per Gap 10 — `computer_perform_action` now admits `press`/`AXPress`, `open`, `show_menu`/`menu`, `pick`, `confirm` and `cancel`, each dispatched through the driver's `click` element-token `action` recipe only when the resolved element advertises the matching AX action; every other name still refuses `not-dispatched`.**

The cursor is one shared overlay. The host configures glide 100 ms and dwell 0 in `apps/desktop/src/cuaDriverHost.ts:719`. There is no per agent identity and no multi cursor. Approvals are per action with queue caps defined in `apps/server/src/computer/ComputerApprovalGate.ts:18`. There is no always allow grant. Foreground always needs explicit approval, noted in `docs/computer-use-cua/README.md:52`. Locked operation does not exist. The lifecycle pauses on lock, sleep, and session resign in `apps/desktop/src/computerDesktopLifecycle.ts:27`. Recording tools stay internal. There is no agent facing history. Runtime behavior at revision 15 is uncertified until a signed app run with fresh permissions passes. That certification gap is stated in `docs/computer-use-cua/v2-parity-matrix.md:5`.

## Approach

### Menus (milestone one, Gap 4 and Gap 10)

Menus ride on AX first actioning, not on raw native menu calls. The provider names a menu path. The backend resolves each step to a fresh AX element inside the exact admitted window. Each step uses the same ownership check as click and set_value. The approval gate treats menu use as a mutating action. Foreground menu excursions need explicit per action approval like activation does. Effect semantics follow the existing three values. The result is verified only on native read back. Anything else reports dispatched unknown or not dispatched. Uncertain menu steps never replay. The run stops at the first failed step, matching the batch rule.

Menu dismissal gets attention. A background menu open must not steal focus or strand an open menu. On failure the backend issues a cancel escape path through the existing input cleanup. If the menu needs a real activation, that step follows the foreground restore rule and restores the prior frontmost window. Menu support also widens secondary actions past AXPress. New names land one at a time behind the same token freshness rule. Each new name needs a fixture proving it dispatches and reports honestly. Codex menu internals stay unverified. We match the observable shape, not their binary.

### Window frames (milestone one, Gap 4)

Window frame control mutates layout. It needs a bounds policy before any tool ships. The policy keeps the full frame on a known display. It refuses zero area frames. It refuses frames that would strand the title bar off screen. It refuses moves to a display with unqualified scale until that coverage is certified. Every call needs explicit visible approval. The approval copy shows the app, the window title, and the old and new frames in plain numbers. The call resolves the target window fresh, applies the move, then reads back geometry. Verified requires the read back frame to match within tolerance. Anything else is dispatched unknown. No silent retry. Off Space moves are refused in milestone one. Space assignment stays with the Spaces work, not with this tool.

### Hover semantics

**Decided against, 2026-09-17.** The plan below assumed a real background hover could be delivered once the focus workstream landed. Live probing refuted that: a stamped pid-routed `mouseMoved` reaches AppKit tracking only while the user's real cursor is already inside the target window; with the real cursor outside, the events are dropped entirely — even when the target window is key and its app is active. See `docs/computer-use-cua/hover-verdict-2026-09-17.md`. The cursor therefore stays overlay-only permanently on this backend: `computer_move_cursor` keeps its no-event, no-keyboard-aiming contract, and `computer_hover` is withdrawn rather than shipped degraded. The surviving rule is the typing one — a move followed by typing without a window id stays refused. Revisit only if a new delivery mechanism (for example a WindowServer pointer-window override) passes the same real-cursor-outside test.

### Background drag (LANDED 2026-09-22, native rev 17 — the spec's gate was wrong)

This spec gated background drag on the synthetic-focus workstream. Live experiments dissolved that gate: belief is dead by experiment, but the stamped window-local pointer path never needed it on AppKit — press-drag-release reaches an inactive Cocoa window with the operator's front process untouched. The shipped shape matches every requirement below: both endpoints inside the exact window, 10 second cap, `expected_window_bounds` revalidation at dispatch, structured refusal (`background_unavailable` → `not-dispatched`) on drivers without the patch, foreground stays the explicit fallback, nothing replays an uncertain drag. Stop-during-drag release behavior is fixture covered. Electron remains a documented dead end — process-scoped CGEvents never reach inactive renderers (`input-matrix-2026-09-17.md`).

### Cursor richness and per agent identity (Gap 12)

The cursor stays visual only. It never aims input. Milestone one adds per agent identity. Each concurrent agent gets its own named cursor with a distinct color and label. Motion keeps the current glide and dwell shape unless measurement says otherwise. Idle behavior stays quiet. Multi cursor rendering must keep one replaceable pending bitmap per cursor and must not regress the preview frame budget. Richer spring motion is cosmetic and ships only if it costs no latency.

### Click recipe breadth (Gap 11)

Native versus Chromium recipe selection exists today, chosen from process metadata per `docs/computer-use-cua/README.md:62`. Electron masking is missing. This spec does not add masked real activation in milestone one. It specifies the seam so the focus workstream can add it later. The seam is a per app class delivery selector with explicit logging of which recipe ran. Uncertain clicks never replay under any recipe.

### Small gaps (Gap 13)

List apps, select text, and press key coverage are P2. List apps returns the app list the window list already implies, with the same completeness limits. Select text resolves a text range through the AX tree and reports verified only on read back of the selection. Triple click and select all remain the fallback until then. Press key coverage adds missing keys one at a time with fixture proof per key. No key ships on claim alone.

### Beyond parity (not milestone one)

These ideas ship after parity. Verification receipts for every mutating call. Smarter scroll with measurement. Faster observation with conditional settle. Protocol level openness for any agent. Better permissions UX. Configurable safety tiers with denylists and an audit log. None of these enter the milestone one diff. Each gets its own spec and its own approval review.

### What stays out and why

Chrome CDP path is deferred by decision, recorded in `docs/computer-use-cua/v2-parity-matrix.md:30`. Browser work uses the separate browser surface. Computer use stays the native app fallback. Locked use is out. It needs an explicit safety decision first, recorded in `docs/computer-use-cua/v2-parity-matrix.md:29`. Record and replay history is out. It needs a privacy policy before any recording surface, recorded in `docs/computer-use-cua/v2-parity-matrix.md:31`. The Intel slice is out of milestone one. It is compiled but unexecuted (per handoff section 3.6, unverified here) and needs its own execution plan. Beyond parity ideas in this spec stay in their own section. They are not milestone one.

## Interfaces

All new tools reuse the existing gateway patterns. Targeting reuses the exact window id plus label or coordinate shape used by move and drag. The move cursor entry shows the pattern in `apps/server/src/agentGateway/computerTools.ts:2320`. Window id reading reuses the shared reader in `apps/server/src/agentGateway/computerTools.ts:411`. Consent reuses the per action authorize path in `apps/server/src/agentGateway/computerTools.ts:1064`. Batch inclusion reuses the per step targeting and consent checks described in `apps/server/src/agentGateway/computerTools.ts:2670`.

Proposed signatures:

computer_invoke_menu({ window_id, path, mode }). window_id is required. path is a nonempty list of menu labels, one per level, for example File then New Window. mode is background or foreground, default background. Background resolves each level through AX in the exact window with no activation. Foreground needs explicit approval and restores the prior frontmost window after. Returns per level results plus effect per level using the shared verified, dispatched unknown, and not dispatched values. Stops at the first failure. Refuses ambiguous labels. Refuses stale element tokens. Never replays an uncertain level.

computer_set_window_frame({ window_id, x, y, width, height, display }). window_id is required. x, y, width, and height are integers in desktop pixels. display is optional and names a known display. Requires explicit visible approval showing app, title, and old and new frames. Applies the bounds policy from the Approach section, then reads back geometry. Returns the requested frame, the observed frame, and the effect. Refuses off Space moves in milestone one.

computer_hover — withdrawn, 2026-09-17. The delivery mechanism this signature assumed does not exist: posted pointer moves only land while the user's own cursor is inside the window (`docs/computer-use-cua/hover-verdict-2026-09-17.md`), so the tool could never deliver the promised effect. Overlay-only `computer_move_cursor` remains the pointing surface.

computer_drag keeps its shape and gains background only after the focus certification. No signature change. The delivery mode field selects the path. The backend refusal stays until then.

Cursor identity needs no new provider tool. The session carries an agent label and color. The host renders one overlay per live agent. The preview shows which cursor belongs to which agent.

Secondary action growth adds names to the existing perform action tool one at a time. Each name reuses the fresh token rule. Each name is approval gated as a mutating action. Each name reports with the shared effect values.

List apps adds computer_list_apps({}). It returns app name, bundle id when known, and window count. It carries the same completeness note as the window list. Select text adds computer_select_text({ window_id, target, range }). It resolves through AX and reports verified only on selection read back. Landed as specified: the range is `{start, length}` UTF-16 offsets, the native write is `AXSelectedTextRange` with attribute read-back as the only verification, and targets without a settable range (including `AXSelectedTextMarkerRange`-only web content) refuse with no fallback. Requires the rev-20 native patch; the `select_text` delta is carried inside `apps/desktop/patches/cua-driver/0001-synara-native.patch`; see `native-select-text.md`.

Every new mutating tool ships with ownership, approval, and effect semantics. Ownership means the exact admitted pid plus window id, revalidated at dispatch. Approval means the shared authorize path with queue caps. Effect means the shared three values with verified only on read back. Any proposal missing one of the three is rejected.

## Acceptance criteria

Menus on AppKit apps. Open five standard menus across TextEdit, Finder, and Preview. Each resolves by label with no coordinates. Each reports verified on read back of the open state or the applied command. Ambiguous labels refuse. Stale menus after a layout change refuse. No focus theft is observed on the human app during background menu use.

Menus on Electron apps. Repeat the same five menu flows on VS Code and Slack. If an app class needs the focus layer, the tool refuses with a clear code until that layer is certified. No silent coordinate fallback. No replay after an uncertain step.

Window frames on AppKit apps. Move and resize a TextEdit and a Finder window to five frames each. Read back matches within 2 pixels per edge. Off screen and zero area requests refuse. The approval prompt shows app, title, and both frames. The human frontmost window is unchanged after background frame calls.

Window frames on Electron apps. Repeat on VS Code and Slack. Same tolerance. Same refusal rules. Same approval copy.

Hover on AppKit and Electron — withdrawn with `computer_hover`, 2026-09-17. The real-cursor-outside test showed posted moves never reach a window the pointer is not inside, so no implementation can meet this criterion on the current delivery path.

Background drag after focus work. Drag a text selection and a slider in one AppKit app and one Electron app without activation. Both endpoints stay in window. Stop during drag releases cleanly with no later movement. This criterion is gated on the focus certification. It is not milestone one done proof.

Cursor identity. Two concurrent agents show two labeled cursors in the preview. Input still routes only through exact targets. Frame budget holds.

Small gaps. List apps returns the running test apps with correct window counts. Select text selects a known range in TextEdit with read back proof. New keys each have a fixture pass. All pass on AppKit and at least one Electron app.

Every criterion runs against real apps. Source checks alone do not pass any item. Codex side comparisons stay marked unverified.

## Tests and evidence

Unit and contract tier. Targeting validation for each new tool. Refusal codes for ambiguous labels, stale tokens, out of policy frames, and off Space moves. Approval queue behavior under the existing caps. Effect mapping for verified, dispatched unknown, and not dispatched. Run the affected Vitest suites for the server package. Save the run output.

Fixture tier. Extend the existing fixture set with a menu fixture and a frame fixture. The menu fixture drives a scratch AppKit app menu by label and checks read back. The frame fixture moves a scratch window through five frames and checks read back within tolerance. A hover fixture is dropped: the capability it would certify does not exist (`docs/computer-use-cua/hover-verdict-2026-09-17.md`). Each fixture records before and after images plus a result JSON under the evidence folder. The drag stop fixture pattern stays the model for proving clean release.

Live tier. Run the AppKit and Electron matrix by hand in a signed app with fresh permissions. Record the human foreground app throughout. Assert zero focus theft and zero pointer moves from the real pointer. Save evidence JSON plus before and after images per run.

Evidence shape. One folder per run with the tool arguments, the approval record, the per level or per edge results, the effect values, and the images. Mark every Codex comparison as unverified. Mark revision 15 runtime claims as uncertified until the signed run passes.

## Risks

Private API drift. Menu and hover delivery may lean on AX behaviors that shift across macOS releases. Keep availability checks and fail closed refusals. Never make one private path the only route without a documented refusal.

Focus theft through menus. Opening a menu can pull focus or dismiss under the user. Mitigate with AX first actioning, the no repost policy from the focus workstream (Codex shape, unverified), and immediate cleanup on failure.

Layout fights. The user or the app can move a window between the bounds check and the frame write. Mitigate with read back match and dispatched unknown on mismatch. Never silently retry a frame write.

Approval fatigue. Frame and menu calls can arrive in bursts. Mitigate with batch scoping and per step results. Never add an implicit always allow to quiet the prompts. That tradeoff has its own open decision.

Electron variance. Electron apps may ignore background menu and hover paths that work on AppKit. Mitigate with per app class refusal codes and a public support table. Never fall back to raw coordinates silently.

Overlay confusion. Two cursors can confuse the user about who acts where. Mitigate with labels and colors tied to the owning agent and turn. The cursor never implies input routing.

Evidence discipline. Source tests do not prove real app behavior. Keep the unit, fixture, and live tiers separate. Report each tier plainly.

## Open decisions

Cursor identity shape. Recommendation is a labeled color cursor per agent, owned by the session. Safe default is the current single overlay until multi cursor rendering passes the frame budget. This decision needs a design pass on colors and labels.

Always allow tradeoff. Recommendation is scoped always allow per app with a visible grant, a short expiry, and an audit log entry per granted call. Safe default is no always allow. Every foreground call keeps per action approval until the safety review signs off. The parity matrix flags this as a safety tradeoff in `docs/computer-use-cua/v2-parity-matrix.md:27`.

Chrome revisit trigger. Recommendation is to revisit the CDP path only after native parity lands and two native browser flows prove painful through AX. Safe default is deferred, with the browser surface as the path for web work. The deferral is recorded in `docs/computer-use-cua/v2-parity-matrix.md:30`.

Menu depth limit. Recommendation is three levels max in milestone one. Deeper paths are rare and harder to verify. Safe default is to refuse deeper paths with a clear code.

Frame scope. Recommendation is same Space moves only in milestone one. Safe default is to refuse cross Space and cross display moves until Spaces certification lands.

Hover default — decided 2026-09-17. Overlay only is not a degraded safe default; it is the only honest mode, because macOS delivers posted moves to a window only while the user's own cursor is inside it (`docs/computer-use-cua/hover-verdict-2026-09-17.md`). No "real hover where certified" tier exists to flag.

## Implementer brief

Read these first. The parity matrix rows and Gap items in `docs/computer-use-cua/v2-parity-matrix.md:37`. The audit decisions in `docs/computer-use-cua/capability-audit-2026-09-16.md:24`. The handoff workstream D seed and the decision shortlist, plus the focus workstream for the background dependency. Then read the gateway targeting and approval code around `apps/server/src/agentGateway/computerTools.ts:2320` and `apps/server/src/agentGateway/computerTools.ts:1064`, the backend drag and cursor code around `apps/server/src/computer/CuaComputerBackend.ts:1138`, and the host cursor setup in `apps/desktop/src/cuaDriverHost.ts:719`.

Build order. First the shared bounds policy and menu path resolution as pure units with tests. Then computer_invoke_menu behind the approval gate with effect reporting. Then computer_set_window_frame with visible approval copy and read back. Then computer_hover with the certified or overlay only flag. Then cursor identity rendering. Then the P2 small gaps. Keep background drag refused until the focus workstream certifies it.

Do not change the settled scope. Do not add the Chrome path. Do not add locked use. Do not add recording history. Do not touch the Intel slice. Keep beyond parity ideas out of the milestone one diff.

Done proof. The affected Vitest suites pass. The new fixtures pass on a scratch AppKit app. The AppKit and Electron matrix passes in a signed app with fresh permissions. Evidence folders hold arguments, approvals, effects, and images per run. The report states what ran, what passed, and what stays unverified or uncertified.

## Status note, 2026-09-17 (appended)

The milestone-one exposure items this spec planned have landed:
`computer_invoke_menu`, `computer_set_window_frame`, `computer_kill_app`,
`computer_list_apps`, `computer_verify_state`, and `computer_zoom` shipped
in `7eeb083d4`, verified live on TextEdit, approval-gated with Synara-side
read-back. `computer_get_accessibility_tree` and
`computer_get_cursor_position` followed in `78bc88bae`. The "still lacks
menus and window frame control" framing in the Problem section and the
build order below predate that landing; hover, cursor identity, and the
P2 coverage items remain open.
