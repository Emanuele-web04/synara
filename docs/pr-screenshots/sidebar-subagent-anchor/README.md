# Sidebar subagent navigation anchor

Evidence for [issue #1875](https://github.com/Emanuele-web04/synara/issues/1875).
Captured with the full application browser fixture and production CSS in Chromium,
at 960 × 700 on macOS, using isolated mocked server data. No live provider or
packaged desktop validation is claimed.

The fixture opens thread 20, whose four subagents appear above thread 21. The
sidebar is scrolled so both parents are visible. Clicking thread 21 removes
thread 20's children and reveals thread 21's four children.

| Case                        | Destination row top before click | After navigation | Movement |
| --------------------------- | -------------------------------: | ---------------: | -------: |
| Existing fixes only         |                           352 px |           232 px |  −120 px |
| With this scroll correction |                           352 px |           352 px |     0 px |

The integration comparison includes #1881 at `57f2949ff0a0e2fb7f90c491a438d01b20756b86`
and #1876 at `67ced1e7db34922cafcb418e177e26756003a9ac`, applied locally to
main `1b5d327840f8b8643a83854b0e911900eba3a0d8`. Their changes are excluded from
this PR. The same position regression fails on main and passes with this fix alone.

- [Before screenshot](before.png) and [before interaction](before.webm): the pointer
  stays at the clicked position while the selected row moves up; a subagent is now
  under the pointer.
- [After screenshot](after.png) and [after interaction](after.webm): scroll compensates
  for the removed rows, preserving the selected row's position.

`ChatView.browser.tsx` owns the regression. Its cases cover four and 24 preceding
subagents, Enter activation, and a manual scroll during pending navigation. The
committed regression invokes the click handler directly to keep #1881's separate
pointer-down defect out of this PR; integration evidence uses a real browser click.

Only sidebar scroll compensation changes. Existing components, styling, composer,
global tabs, and subagent visibility rules remain intact. The browser's scroll
bounds still apply: at the start or end of a short list, preserving the exact
position can be impossible without changing the layout.
