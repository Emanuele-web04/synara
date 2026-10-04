# React Doctor review of HTTP responses and asynchronous work

This pass reviews the three requested rules only. The initial pass proposed five
findings in four production files; subsequent PR review rejected the parallel
library refresh and restored its per-request timeout budget. Intentional error parsing, ordered operations,
and already handled clipboard failures remain unsuppressed. The four large
refactoring categories are deferred, including their representative samples,
as agreed with the code owner.

## Initial scan evidence and scope

- Fetched all three canonical recipes using `curl -fsSL` with
  `Cache-Control: no-cache` and `Pragma: no-cache` before editing:
  [response status](https://react.doctor/docs/rules/react-doctor/no-fetch-response-used-without-status-check),
  [awaited loops](https://react.doctor/docs/rules/react-doctor/async-await-in-loop),
  [event handler promises](https://react.doctor/docs/rules/react-doctor/no-floating-then-in-jsx-handler).
- React Doctor 0.9.14 scanned both React projects without a scan cache. The fresh
  baseline had 1,095 findings versus 1,094 in the supplied report: it additionally
  detected the desktop Maximize handler. None of the selected findings had a
  `fixGroupId`; occurrences carrying that field in other categories were not touched.
- Used `npx react-doctor@latest --verbose --project @synara/marketing,@synara/web
--no-cache --output-dir <directory>`. Explicit project selection was necessary
  because the initial workspace prompt did not complete in noninteractive mode.
- Repeated real scans after the fixes, including an unfiltered scan of both apps.
  Compared findings by plugin, rule, file, and multiplicity so shifted line numbers
  did not masquerade as resolved findings.

| Rule                                     | Fresh baseline | After fixes | Disposition of remaining findings                                                         |
| ---------------------------------------- | -------------: | ----------: | ----------------------------------------------------------------------------------------- |
| Response consumed before status handling |              7 |           4 | Deliberate error-body handling; rejected as false positives                               |
| Await inside a loop                      |             26 |          25 | 21 ordered or resource-limited operations; 4 need measurements or service-budget evidence |
| Floating event-handler promise           |              3 |           2 | Clipboard failures already handled; rejected as false positives                           |
| All categories                           |          1,095 |       1,090 | No added findings in the comparison                                                       |

## Confirmed findings and their impact

| Owner                                                           | Problem and severity                                                                                                                                                                  | Correction and evidence                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/chat/group/useGroupLibrary.ts`, upload | **Low:** switching projects while an upload failed caused the hook to return success. The current panel ignores that return value, so this did not show a false success notification. | Handle HTTP failure before checking which project is visible. Keep the original server error for the current project and avoid leaking it into another project. The browser regression failed before the fix and passes afterward.                                                            |
| Same hook, directory refresh                                    | **Rejected optimization:** the server serializes listings under the project root lock, so concurrent client requests spend their timeout while queued.                                | Restore serial refresh after mutations and uploads; retain listing errors instead of clearing them after a committed write. Browser regressions cover request ordering and visible refresh failures.                                                                                          |
| `apps/web/src/wsTransport.ts`, HTTP negotiation                 | **Moderate:** a 404/503 error body could stall the connection fallback until the five-second deadline, although the status already told the client to use the older connection path.  | Handle 426 separately because its error body carries the compatibility decision; reject other HTTP failures before parsing, cancel their unused bodies, then parse success. Regression cases with stalled 404 and 503 bodies failed before and pass after.                                    |
| `apps/web/src/wsNativeApi.ts`, voice upload                     | **Moderate:** an older server's 404/405 response could leave voice transcription waiting for an irrelevant body before trying its older API. This request has no body-read deadline.  | Check those compatibility statuses first, cancel the unused body, and trigger the existing fallback. The existing fallback test now covers complete and stalled error bodies; both stalled cases failed before and pass after. Other HTTP errors still retain their server-provided messages. |
| `apps/web/src/components/DesktopWindowControls.tsx`, Maximize   | **Low:** a rejected native window request left an uncaught promise rejection and no explanation for the button doing nothing. No page crash is established.                           | Add a terminal `.catch` using the existing error toast. Chromium reproduced the unhandled rejection before the fix, then verified the error notification and successful retry afterward. This uses a mocked native bridge, not a packaged Windows run.                                        |

Committed folder renames and deletions now remove the old path and cached descendants
before refresh. Failed writes keep their cache. A small hook-local invalidator is
reused for these two operations; no existing helper owned this cache. No new UI
component was needed. Existing directory loading,
compatibility fallback, and toast behavior were reused.

## Response and clipboard findings retained

Locations below identify the supplied report's occurrences; subsequent edits can
shift line numbers. Rejected means the rule's risk was not established, not that
the detector stopped reporting it.

| Location                                                                  | Outcome and reason                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/marketing/scripts/seo-smoke.mjs:49`                                 | **Rejected.** The smoke test reads the body for diagnostics and asserts status 200 before returning it. It cannot pass an HTTP error as a successful page.                                                             |
| `apps/marketing/src/app/api/feedback/route.ts:197`                        | **Rejected.** Resend's error JSON supplies the rejection message; `response.ok` and the delivery ID are both checked before success.                                                                                   |
| `apps/web/src/lib/composerSend.ts:327`                                    | **Rejected.** Error JSON supplies the upload failure message. Status and a managed attachment ID are checked before accepting an upload; earlier uploads are compensated on failure.                                   |
| `apps/web/src/wsNativeApi.ts:231`                                         | **Rejected.** Authentication errors are parsed deliberately, then non-OK responses throw the server message before returning a successful result.                                                                      |
| `apps/marketing/src/components/AskAISection.tsx:138`                      | **Rejected.** The called clipboard helper catches denial and unsupported access and resolves `false`. The success callback only updates React state and schedules a timer; no credible rejection path was found there. |
| `apps/web/src/components/pullRequest/PullRequestsUnavailableState.tsx:66` | **Rejected.** The second argument to `.then` already handles clipboard rejection and displays the existing error toast. No credible throwing operation was found in its success callback.                              |

## Awaited loops retained

The canonical recipe requires preserving ordering, cancellation, partial failure,
and resource limits. It also requires relevant measurements before retaining a
performance rewrite. Blindly launching every iteration together would violate
those requirements in the rejected cases below.

| Location in supplied report                               | Outcome and concrete reason                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/marketing/scripts/seo-smoke.mjs:170`                | **Needs evidence.** Four independent page reads are candidates, but there is no measured smoke-test bottleneck. Concurrent failure would also need to settle pending requests before stopping its server. No user-facing performance issue established. |
| `apps/web/scripts/hugeicon-snippet.mjs:79`                | **Needs evidence.** Fetches an external CDN and prints snippets in argument order. Measure a representative batch and establish bounded service concurrency before changing it. Developer tooling only.                                                 |
| `apps/web/scripts/measure-dev-transforms.mjs:47`          | **Rejected.** Serial invalidation and transforms are the benchmark itself. Overlapping them changes what it measures.                                                                                                                                   |
| `apps/web/scripts/production-assets.ts:21`                | **Needs evidence.** Recursive filesystem traversal has no measured bottleneck here. Profile a real build and bound outstanding directory reads before replacing it. Build tooling only.                                                                 |
| `apps/web/src/components/ChatView.tsx:4143`               | **Rejected.** File undo must run newest-first and stop on failure; the server rejects out-of-order undo.                                                                                                                                                |
| `apps/web/src/components/Sidebar.tsx:3783`                | **Rejected.** Archive actions include cascade, navigation, and worktree cleanup scheduling, not independent reads. Preserve action ordering.                                                                                                            |
| `apps/web/src/components/Sidebar.tsx:3805`                | **Rejected.** Deletions stop on failure and reconcile accepted deletions. Concurrent siblings would keep deleting after failure.                                                                                                                        |
| `apps/web/src/components/chat/group/LibraryPanel.tsx:292` | **Rejected.** Sequential uploads explicitly cap simultaneous large request bodies and preserve shared busy/error state.                                                                                                                                 |
| `apps/web/src/hooks/useComposerImageIntake.ts:86`         | **Rejected.** Waits for a queue that may acquire new work while waiting. It is not a fixed list of independent jobs.                                                                                                                                    |
| `apps/web/src/hooks/useSidebarThreadActions.ts:961`       | **Rejected.** Bulk archive includes shared navigation and worktree cleanup state. Preserve ordered side effects and per-thread outcomes.                                                                                                                |
| Same file, `:1043`                                        | **Rejected.** Bulk deletion can prompt for shared worktrees and removes child trees. Concurrent deletion risks overlapping prompts and cleanup decisions.                                                                                               |
| `apps/web/src/hooks/useThreadHandoff.ts:210`              | **Rejected.** Appends imported activities to one thread in their original order.                                                                                                                                                                        |
| `apps/web/src/lib/activeThreadDelete.ts:96`               | **Rejected.** Children must be deleted before parents; surviving children must remain reachable after failure.                                                                                                                                          |
| `apps/web/src/lib/archivedThreadDelete.ts:29`             | **Rejected.** Stops deletions on the first failure and reconciles only accepted IDs in its finalizer.                                                                                                                                                   |
| `apps/web/src/lib/chatProjects.ts:199`                    | **Rejected.** Ordered destructive cleanup currently stops on failure; parallel deletion would continue deleting siblings. No measured performance problem.                                                                                              |
| `apps/web/src/lib/composerImagePreparation.worker.ts:110` | **Rejected.** Each resize uses the preceding encoded image size to choose the next dimensions and reuses the canvas.                                                                                                                                    |
| `apps/web/src/lib/composerSend.ts:129`                    | **Rejected.** Preparation caps full-resolution canvas allocation and counts accepted attachments before preparing the next image.                                                                                                                       |
| Same file, `:319`                                         | **Rejected.** Uploads explicitly cap body-buffer memory and collect IDs for failure cleanup.                                                                                                                                                            |
| `apps/web/src/lib/gitReactQuery.ts:255` and `:276`        | **Rejected, two occurrences.** Reads use a shared Git queue to protect expensive-read capacity. Parallelizing the callers does not make those queued reads independent.                                                                                 |
| `apps/web/src/lib/threadUnblock.ts:61`                    | **Rejected.** Resolving an older blocker can replay work that settles later blockers; oldest-first processing is required.                                                                                                                              |
| `apps/web/src/lib/workspaceFileReferenceBatch.ts:32`      | **Rejected.** Requests are chunked at 128 paths; sequential chunks bound outstanding work and stop on malformed responses.                                                                                                                              |
| `apps/web/src/projectImport/ProjectImportPanel.tsx:132`   | **Rejected.** Checks Stop between imports and maintains one current progress item. Launching everything defeats cancellation.                                                                                                                           |
| `apps/web/src/routes/__root.tsx:583`                      | **Rejected.** Provider installers can share package-manager state and global installation locations. Independent-looking provider entries are not evidence of independent writes.                                                                       |
| `apps/web/src/wsTransport.ts:1470`                        | **Needs evidence.** Stream startup participates in session cleanup and reconnect recovery. Measure reconnect admission/cleanup and verify cancellation before introducing concurrency.                                                                  |

## Follow up

Leave the remaining findings for a separate pass. In the fresh scan, high
control-flow complexity spans **109 files**, non-component exports **65 files**,
and large components **52 files**. The fresh scan labels React Compiler
optimization findings across **76 files**, compared with **46 files** in the
supplied summary. These are migration-scale categories:
fetch each current recipe, validate one representative sample, verify it with the
real tool and relevant behavior checks, then obtain code-owner sign-off before
expanding across the remaining files. No such approval or migration is implied
by this pass.

Prioritize evidence gathering for the four loop candidates above before calling
them defects. The current scan still reports the intentional patterns; no rules,
inline diagnostics, or files were suppressed.

## Verification

Regression tests were run on the original implementation and failed for the
intended reasons before production edits. Focused API tests pass 92 cases;
Chromium covers the library panel, hook, and window-control failure/retry paths.
The original 81 ms library measurement used independent mocked reads and did not
model the server root lock. It does not justify parallel refresh; that change and
its concurrency benchmark have been replaced with ordered-request regressions.

Final checks used Node 24.21.0 and Bun 1.4.2. The full workspace suite passed
**15,001 tests**, with 37 skipped. All **11 focused Chromium tests** passed.
`bun run fmt:check`, `bun run lint`, and `bun run typecheck` passed; lint still
reports existing repository warnings. An initial full-suite attempt under the
shell's Node 26 failed on its unsupported TypeScript transform mode; the Node 24
rerun passed. A test-only cleanup after the full suite received a focused rerun.

React Doctor completed its unfiltered scan of 1,915 files. Its exit status remains
1 because unrelated error-level findings remain; this is not a clean repository
scan. All five changed findings disappeared and no new findings were introduced.

Native Electron/Windows window failures and live voice-provider transcription
were not exercised. No production state, provider selection, or installation was
changed.

## PR review follow-up

The initial scan/check counts above describe the original submission. The repaired
branch restores ordered library refresh despite the intentional awaited-loop
warning; no diagnostic is suppressed. A committed mutation/upload still returns
success when a later refresh fails, and the panel keeps the refresh error so the
user can distinguish the write from a stale listing.

Window controls now also handle rejected Minimize, Close, and initial state reads.
They use the existing toast manager; native state subscription remains active
when the initial read fails, and unmounted controls do not report stale read errors.
There was no comparable window-action error helper, so the component shares its
small formatter across these four Promise paths.

Six follow-up browser regressions failed on the original PR for the intended
reasons and passed after repair. The two focused Chromium files pass 9 tests;
HTTP/WebSocket/native API owners pass 92 tests. Full workspace checks are reserved
for the grouped integration pass.

The original chat-follow CI job failed a real transcript geometry assertion
(43 pixels from bottom, expected at most 4) in unchanged ChatView code. The exact
case passes locally without changing the transcript or its assertion. This local
pass does not erase the CI failure or prove its cause; new-head CI/review evidence
is still required before delivery.
