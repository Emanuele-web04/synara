# Native browser hover focus churn

Investigated a Synara 1.0.4 report of a Mac freezing with two internal browsers
open and `CursorUIViewService` memory growth. The reported freeze and gigabyte-scale
growth were **not reproduced**. A separate, concrete defect was reproduced:
every passive pointer move dispatched by native browser automation temporarily
took keyboard focus away from the composer.

## Evidence

Local runtime: macOS 27.0.1 (26A434), Apple Silicon, Electron 43.4.1.
Baseline: `a62d7c733d19f5538ffc0d126d57437b3b578ff1` (v1.0.4).
The reporter's macOS version and browser activity remain unknown.

The isolated probe used temporary Electron profiles, two synthetic pages owned
by `DesktopBrowserManager`, and the production `BetterwrightCdpTarget` transport.
An initial run exercised idle pages and repeated preview captures. The paired
comparison below alternated 2,400 mouse moves between the pages with 16 ms pacing.
Hover used the same
temporary background-throttling disablement as `runBetterwright`; omitting that
step coalesces most input to hidden pages and is not a valid delivery comparison.

| Measurement                                       |       Baseline |           Fixed |
| ------------------------------------------------- | -------------: | --------------: |
| Composer blur/refocus cycles during 2,400 moves   |          2,400 |               0 |
| Trusted mouse moves received by each page         |  1,200 / 1,200 |   1,200 / 1,200 |
| Subsequent typed characters received by each page |      100 / 100 |       100 / 100 |
| Composer draft preserved                          |            Yes |             Yes |
| Paced hover phase elapsed time                    |        54.43 s |         42.69 s |
| Sampled system cursor-service RSS range           | 5.92–52.75 MiB | 38.94–66.55 MiB |

[Machine-readable measurements](measurements.json). Timings are one local paired
run including deliberate pacing, not an application-wide speedup. Other apps
remained running. Cursor-service RSS is a system-wide `ps` measurement, differs
from Activity Monitor's memory accounting, and does not demonstrate a memory
improvement. This short synthetic run does not rule out a problem in longer
sessions or on the reporter's macOS version and websites. This change must not be
described as fixing the original macOS leak or freeze. Windows and Linux runtime
behavior were not measured locally.

## Repair and regression

The existing direct native hover dispatch ran inside the keyboard-focus lease.
It now runs before acquiring keyboard focus, while remaining inside the shared
input queue and after the revoked/destroyed-target check. Its coordinate scaling,
modifiers, and native event delivery are unchanged. Button presses, dragging,
keys, child sessions, and renderer-owned webviews retain their existing paths.
The background-throttling policy is unchanged.

The real Electron MCP regression in
[`visibleBrowserMcp.e2e.ts`](../../../apps/web/e2e/visibleBrowserMcp.e2e.ts)
opens two background browser tabs, disables Playwright's focus emulation, and
checks the composer's focus events, draft, and selection during 80 pointer moves.
Before the repair it failed with **80 blur events instead of zero**. It also
checks trusted hover feedback and typing in both tabs. On macOS it also blurs the
isolated shell window and verifies that both production-managed background tabs
still receive trusted pointer moves without refocusing that window. This
qualification uses the real MCP/BrowserManager path; it does not infer behavior
from a detached, never-rendered WebContentsView. Existing queue tests now
exercise a queued native hover both with and without cancellation.

Native hover delivery is asynchronous in both versions. An immediate style read
after `hover()` also returned hidden/untrusted state in an isolated unmodified
v1.0.4 control. The regression waits for the visible hover effect while keeping
the strict zero-blur assertion.

Run the real browser regression and navigation coverage with:

```sh
bun run --cwd apps/web test:electron:e2e visibleBrowserMcp.e2e.ts --grep 'preserves composer keyboard ownership'
```

Run the complete browser compatibility scenario with:

```sh
bun run --cwd apps/web test:electron:e2e visibleBrowserMcp.e2e.ts
```

The existing screenshot assertion also needed to account for non-overlay system
scrollbars: full-page captures use document content width, whereas viewport
captures use viewport width. The unmodified baseline failed at 2,530 versus 2,560
pixels on this Mac. The assertion now measures the document width independently;
production screenshot behavior is unchanged.
