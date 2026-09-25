# App-wide UI/UX polish pass

## Summary

An app-wide polish sweep on top of the home/composer transition work (commits up to `4bab6c028`). ~275 files touched; the largest behavioral changes are in the chat transcript, composer, sidebar, and shared primitives.

### Motion and transitions

- Shared motion tokens (`--ease-out-expressive` style curves, duration scale) in `index.css`; ad-hoc easings replaced across the app.
- First-send transition (committed earlier): centered composer slides into the dock via FLIP/WAAPI, hero overlay portals to `document.body` so `position: fixed` escapes `contain: paint`/`will-change` ancestors, landing copy drifts away, user message rises out of the composer.
- Assistant streaming text reveals word-by-word with a keyed fade (`data-chat-word-fade`), capped at ~30k chars of source offset to bound DOM growth. Find highlighting composes correctly inside fades.
- Queued-message and stacked panels animate height/opening; context-menu fallback popup uses the same scale-from-origin entrance as native menus.
- Reduced-motion respected: word fade renders instantly, anchor slides snap, hero exits skip.

### Transcript scroll-follow reliability (the bulk of the correctness work)

- Real upward wheel/key gestures detach streaming auto-follow; no-op wheels (sub-pixel, nested targets, at-limit) no longer strand follow.
- Gesture judgment uses the lowest observed `scrollTop` (`movedUp`), not final position — growth-compensated gestures still count.
- A 150ms poll gives upward wheel gestures compositor time before deciding (previously two fixed frames, which misread under load).
- Stale `isAtEnd` events can't re-stick follow within 250ms of detach; explicit gesture-end paths bypass the grace.
- Detached readers resume on the container's physical bottom position, not LegendList's possibly-stale `isAtEnd`.
- `maintainVisibleContentPosition` is now only disabled during the send-anchor slide; default (size-stabilization only) applies while detached — data-change anchoring was the drift source under 40ms streaming cadence.
- Late-gesture verification window (500ms): an upward scroll landing after a no-op classification re-detaches instead of snapping to the tail. Emit-growth transients are filtered by a two-frame off-bottom persistence check bound to the originating gesture record, so a later gesture or attach can't be clobbered by a stale verify.

### Pending interactions

- Duplicate submit guard (`userInputSubmissionsRef`) now persists ~250ms past dispatch settle, so a queued second click or the 200ms auto-advance timer can't double-dispatch. Retries after failure still work.

### Accessibility

- Context-menu fallback gets `menu`/`menuitem`/`separator` roles and `aria-hidden` icons.
- Kanban cards: keyboard drag support and accessible labels.
- Timestamp affordances keyboard-accessible; destructive confirms for revocations.
- Contrast bumps: `muted-foreground/45–70` → `/80` on timestamps, stats, previews.

### Color, type, layout

- Semantic status tokens (`text-status-success/failure`, `text-warning`) replace ad-hoc `amber-300/80`, `rose-300/85`, `emerald-300/75`.
- `text-ui`/`text-ui-sm`/`text-ui-xs` font tokens standardized across surfaces.
- Selected vs hover states distinguished in lists; composer shell allows horizontal overflow scroll without a visible scrollbar.
- Queued-message strip is scroll-capped so a long queue can't push the input off-screen.

### Test infrastructure

- Workspace-editor autosave tests pause the real session autosave (`pauseWorkspaceEditors`) instead of racing the 400ms debounce mid-typing.
- Popup cleanup helper (`waitForTransientPopups`) used where popovers were leaking `NotFoundError` noise.
- Anchor-slide jitter test now distinguishes injected layout shocks from real slide bounces.
- Profiler tests warm up before baselining so mount stragglers don't land in the measured window.

## Verification

- `tsc --noEmit` (web): clean.
- `oxlint`: 0 errors (724 pre-existing warnings, none in touched logic).
- `oxfmt --check`: clean on all touched source files.
- Unit suite: 5255 passed | 3 skipped (incl. `chatHotPath` compiler coverage, 39/39).
- Browser suite, decisive full run: **713 passed | 2 skipped, 0 failures** (488s).
- Focused matrices additionally verified repeatedly:
  - scroll-follow variant matrix: 16/16 on the final code.
  - pending user-input variants: 3/3 (double-submit fixed).
  - editor/session files: green with the real `pause()` seam.
- Known load-dependent flake classes (all green in isolation and in the decisive run): Pierre editor keystroke ordering (`placementre`), composer mount timeout.

## Known gaps

- The Pierre editor input-ordering flake under suite load is upstream (no fix attempted; 15/15 green isolated).
- Browser-mode `vi.mock` does not intercept transitive app imports; editor tests use the session's real `pause()` seam instead.
