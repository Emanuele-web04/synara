# rev-17 cancellation fixture tier, 2026-09-17 — notes

Certifying section: `report.cancellation` inside
`rev17-cancellation-2026-09-17-report.json` (one runner invocation produced
the electron, native, cancellation and gateway sections; this file
certifies the cancellation tier).

## Provenance / launch path

Identical invocation to `rev17-native-2026-09-17-notes.md`: worktree
98b86be0c fixture bundle, external `CuaDriverHost`
(`com.synara.cua-fixture-external`), `open -g -n -W` launch of
`~/Applications/Synara Cua Fixture.app` with
`SYNARA_CUA_FIXTURE_ENDPOINT`/`SYNARA_CUA_FIXTURE_CAPABILITY` set and the
LIVE/FOREGROUND flags empty.

External-mode note: with `SYNARA_CUA_FIXTURE_ENDPOINT` set there is no
embedded broker, so the fixture cancels via `backend.stopInput()` — the
same `stop` method over the trusted host's socket, exercising the identical
cancellation wire path (`cancellation.ts` lines 16-20). Release is proven
by application-owned event counts (renderer mouseUp/keyUp), not by the
transport reply alone.

## Results (cancellation section, 2 passed + 1 not-run)

- cancel-held-click: passed — real mousedown landed (`sawDown`), `stop`
  returned in 414.8 ms (< 4 s bound), matching mouseup consumed
  (`mouseDown===1, mouseUp===1, buttons===0`), no further input.
- cancel-typing: passed — real keydown observed before stop, 425.8 ms stop,
  keyDown===keyUp after settle (no held keys), delivered text is a strict
  prefix (`keyAfter.text.length < text.length`), counters frozen.
- foreground-cancel-drag-and-modified-click: not-run — requires
  `SYNARA_CUA_FIXTURE_FOREGROUND_CANCEL=approved-once`, outside this
  certification scope.

## Focus invariant

Frontmost app `ghostty` before and after the run; the cancellation window
(`Synara Cua Fixture <pid> C`) was shown inactive and identity-verified
(pid + exact title + declared bounds) before any input.

## Caveats / anomalies

None beyond the shared probe-coverage caveat in the native tier notes
(not applicable to this section — no focus probe runs here).
