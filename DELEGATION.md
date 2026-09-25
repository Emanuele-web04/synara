# Delegation plan — Synara app-wide UI/UX polish pass

Units: 7 (6 implementation + 1 verification). Mode: parallel subagents
(batches A–F) + main-agent review/integration; earlier "no subagents" note
below is superseded — subagents were authorized for this pass by the user's
explicit "use as many sub agents as needed and use your sidekick well".

Design basis: audits from the emilkowalski/jakubkrehel/transitions.dev skill
repos installed under ~/.agents/skills; plan at /tmp/synpolish/PLAN.md.

| #   | Unit                                                                                    | Files (mine)                                                                                              | Worker   | Acceptance                                                                       | Status                                                                                                       |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | A: shared primitives + motion tokens (menus, popups, tooltips, buttons, dialog chrome)  | apps/web/src/components/ui/\*, lib/disclosureMotion.ts, index.css motion tokens                           | subagent | Menu/popup entrance motion; instant-neighbor tooltips; reduced-motion everywhere | verified — menuOcclusion browser tests green after exit-motion removal; typecheck clean                      |
| 2   | B: chat surface polish (focus rings, hit areas, status colors, copy, hero overlay fix)  | apps/web/src/components/ChatView.tsx, chat/\* composer strips, ChatEmptyStateHero                         | subagent | Focus-visible rings restored; hero overlay portaled (split-view drift fixed)     | verified — ChatView browser tests green                                                                      |
| 3   | C: sidebar + navigation (selected-row state, section labels, hover cards, hit areas)    | apps/web/src/components/ui/sidebar.tsx, SidebarActivityView, thread rows                                  | subagent | Selected thread visually distinct from hover; readable labels                    | verified — diff reviewed, live capture confirms                                                              |
| 4   | D: settings + dialogs (Revoke confirm, keyboard traps, dialog title/button consistency) | apps/web/src/components/settings/_, dialogs/_, AppSnapShortcutControl                                     | subagent | Destructive actions confirm; no hardcoded hues; a11y labels                      | verified — settings renders; prose-line overreach reverted by main                                           |
| 5   | E: other surfaces (kanban keyboard dnd, diff, terminal, browser, onboarding, PRs)       | kanban/_, DiffPanel, terminal panels, BrowserPanel, onboarding, pullRequest/_                             | subagent | Kanban keyboard-operable; consistent surface polish                              | verified — focused browser tests green                                                                       |
| 6   | F: streaming polish — whole-word paced reveal + per-word fade                           | hooks/useSmoothStreamedText.ts, ChatMarkdown.tsx, ChatMarkdownFind.tsx, index.css                         | subagent | Whole-word reveal, opacity-only fade, no re-fade on remount, reduced-motion      | verified — 94 unit tests + 10 browser tests green; scroll-follow race fixed by main                          |
| 7   | Integration + verification: main reviews all diffs, fixes cross-batch breakage          | all of the above + test stabilization (browserPopupCleanup.ts, scroll gesture settle, profiler baselines) | main     | fmt/lint/typecheck clean; unit + browser suites green; live captures             | verified — unit 5255/5255; browser suite 713/713 decisive run; scroll matrix 16/16; typecheck/lint/fmt clean |

Main-agent rework after batch return (owner: main, evidence in file diffs):

- menu.tsx / disclosureMotion.ts: removed `data-ending-style` exit from shared
  popup token — Base UI keeps exiting submenus mounted; quick re-open hit stale
  nodes (reproduced via BrowserPanel.menuOcclusion).
- ChatMarkdown.tsx: word-fade watermark redesigned to a ref while detached —
  per-emit state updates were causing scroll-anchoring churn in the virtualizer.
- useChatTranscriptScroll.ts: gesture classification rewritten around the
  lowest observed scrollTop (movedUp) — a growth-compensated upward wheel no
  longer misreads as a no-op, and a genuinely unmoved wheel keeps follow.
  Upward wheels poll up to 150ms for the compositor scroll (was: two fixed
  frames). Bare isAtEnd events can't re-stick inside a 250ms post-detach
  grace; explicit gesture-end paths bypass. Detached resume keys on the
  container's physical bottom, not the list's stale flag. A 500ms
  late-gesture window re-detaches instead of healing to the tail when a
  no-op-classified gesture's scroll lands late; transient emit growth is
  distinguished from a real gesture by a two-frame off-bottom persistence
  check bound to the originating gesture record (a later gesture or
  attach invalidates the pending verify).
- MessagesTimeline.tsx: maintainVisibleContentPosition now only disabled for
  the send-anchor slide — the `true` data-anchor pass while detached was the
  drift source under 40ms emit cadence; default keeps size stabilization.
- useChatPendingInteractions.ts: duplicate-submit key now persists ~250ms
  past settle — a raced second click or the 200ms auto-advance timer could
  otherwise re-dispatch after a fast (mocked/rejected) first attempt.
- ChatView.browser.tsx: anchor-jitter test records injected growth-shock
  times and excludes their frame deltas from the approach-reversal count —
  a layout shock is not a slide bounce. Post-arrival assertions unchanged.
- ChatTranscriptPane.browser.tsx: profiler baseline now waits for mount commits
  to settle (100ms quiet) before counting — delayed virtualizer/highlighter
  mount work is not a composer-driven render.
- ChatView.browser.tsx: multi-question tests made deterministic vs the 200ms
  auto-advance (synchronous Cancel click; bounded Next click).
- browserPopupCleanup.ts (new): shared afterEach guard that waits out transient
  popup exit before wiping document.body — 49 files wipe body; popup files
  patched to wait.
- WorkspaceFilePreview/AppSnap/TraitsPicker/pullRequest test updates for
  intentional copy changes (typographic ellipses, "Close pull request").

Historical ledger (computer-use parity pass, completed earlier on this
worktree) is preserved in git history of this file.
