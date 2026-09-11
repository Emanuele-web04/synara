# Claude token accounting

The Agent SDK emits completed content blocks separately. Several `assistant`
events can share `message.id` and repeat provisional usage. Count each response
once and add only increases from later snapshots. A block's UUID is a delivery
identity, not an API response identity.

Synara keeps request accounting on each native query context. The current and
previous SDK turn are retained; native results advance that boundary. Closing a
UI turn early does not reset native accounting. Subagent contexts own independent
counters. Successful results reconcile main-loop usage, including downward
corrections; missing or zeroed error results retain the observed estimate.

| Value                                 | Scope                                                               |
| ------------------------------------- | ------------------------------------------------------------------- |
| Context `usedTokens`                  | Latest request or local context summary                             |
| Context `totalProcessedTokens`        | Main conversation's accumulated estimate                            |
| SDK `result.usage`                    | This SDK turn's main loop                                           |
| SDK `result.modelUsage`               | Cumulative query-pipeline usage, including subagents and compaction |
| Projected `turn.completed.modelUsage` | Difference from the preceding native result                         |

Compact projected `inputTokens` already includes cache reads and writes.
`thinkingTokens` is already included in output. Neither subset is added twice.
Profile Stats uses versioned completed model totals, counts mirrored children
only through the parent, and attributes usage to the completion date. Interrupted
turns without a usable model breakdown fall back to observed main-loop usage.

## Historical limits

`tokenAccountingVersion: 1` identifies corrected accounting and trusted resume
counters. Unversioned Claude processed totals are hidden; they are not reused
as a resume baseline. Other providers retain their existing accounting.

Older compact model totals can be either per-turn or process-cumulative. Dates
cannot distinguish them. Migration 103 preserves retained raw main-loop results
in `profile_stats_claude_legacy_usage` before runtime retention removes that
evidence. It does not rewrite the event journal, old counters, or compact model
usage. This recovery is partial: missing results, subagent pipeline usage, and
already-purged legacy aggregates cannot be reconstructed from those records.
Profile Stats excludes unverifiable totals and explains that history can be
incomplete. Verified deletion snapshots retain their accounting version.

A future opt-in native-transcript import must first produce a dry-run report
against a matching database/WAL backup, bind requests to native sessions and
turns, deduplicate copied requests across files, and distinguish process resets
from continuation. It must store provenance and uncovered ranges separately;
neither dividing old counters by two nor summing old modelUsage is a repair.

## Input and cache behavior

Claude obtains automation authoring guidance from the create/update tool
descriptions. Removing the identical system-prompt copy saves 381 characters
from the appended host prompt (6,856 to 6,475). This is a text-size measurement,
not a measured token-price or subscription saving. Tool routing, authorization,
automation run instructions, and other providers' prompts are preserved.

Native caching, TTL, query reuse, effort selection, idle reaping, and
`excludeDynamicSections: true` are unchanged. Context polling remains local
`getContextUsage({ detail: "summary" })`. SDK 0.3.259's snapshot documentation
conflicts with CLI 2.1.267's initialize schema: that CLI records appended prompts
by default where recording is enabled. No snapshot override is added. Existing
native prompt snapshots keep their normal refresh lifecycle.

References: [SDK types](https://platform.claude.com/docs/en/agent-sdk/typescript),
[cost tracking](https://platform.claude.com/docs/en/agent-sdk/cost-tracking),
[prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[native cost and cache diagnostics](https://code.claude.com/docs/en/costs).

Validation lives in the existing ClaudeAdapter fake-SDK suite, token/result
normalization tests, runtime projection/schema tests, Profile Stats and archive
tests, migration 103's upgrade test, context-window tests, and harness/tool
description tests. These need no Claude inference or live account data.
