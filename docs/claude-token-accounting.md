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
| Projected `mainLoopCacheReadTokens`   | Part of `mainLoopTokens` read from the prompt cache                 |

`result.modelUsage` is not reset by a new process. When Claude Code resumes a
session, it restores the totals it saved for that session, so the first result
of a resumed process also counts earlier turns. Nothing in Synara knows that
restored baseline, and Claude Code only restores it when the session was the
last one saved for its project directory. The first result after a resume
therefore only becomes the baseline: its turn carries no `modelUsage` or
`totalCostUsd` and counts its main loop. Results written before this rule still
carry the restored totals. Profile Stats finds them as the first turn of each
process that resumed an earlier process of the same native session, and counts
those turns' main loop instead. New observations carry `claudeCache.processId`,
created once for an owned SDK query and preserved across its hooks, requests,
compaction and model changes. A new query always receives a new ID, including
provider-switch rollback that reuses the ownership generation. Native session
identity also separates session changes inside a query. Observation timestamps
only describe freshness, never process identity. Once the first
result is settled, a later native-session identity change counts fresh usage
normally rather than withholding another result.

A result settles `mainLoopCacheReadTokens` exactly. A turn closed without one
sums the cache reads of its observed requests. Older main-loop rows without the
field use their recorded requests' cache reads (`claudeCache.lastRequest`),
capped by the main-loop total. Output tokens never inherit the prompt's cache
ratio. Model rows use their own `cacheReadInputTokens`.

The SDK's raw per-model shape has no `totalTokens`: its four disjoint counters
are uncached `inputTokens`, `cacheReadInputTokens`,
`cacheCreationInputTokens`, and `outputTokens`. `thinkingTokens` is already
included in output. The compact projected shape adds those counters once,
stores that value as `totalTokens`, and folds both cache counters into its
`inputTokens`. Profile Stats accepts both shapes: an explicit positive total is
authoritative for compact rows; otherwise it sums the four raw SDK counters.
This prevents cache and thinking tokens from being added twice.

Profile Stats uses versioned completed model totals and attributes usage to the
completion date. Completed turns without any usable positive model row fall back
to verified main-loop usage, including when a malformed nonempty breakdown is
present.

Subagents count once. A versioned result covers every request its process made
since the previous result, subagents included, so a provider-native child's
turn is matched by time to the next parent result of the process it ran in (the
parent's latest observed process started before the child finished). The
child counts on its own only when that result does not count it: it is withheld,
its breakdown is unusable, it belongs to a later process, or no parent result
followed. `source_turn_id` is not used; it can name the child's own turn.

The Inbox labels the remainder after recorded cache reads as “other”, not “new”:
providers and deleted-thread archives without a cache breakdown can include
unclassified cache reads. The total remains unchanged.

## Historical limits

Older observations have no process ID. They fall back to ownership generation
and native session identity. If an old restart reused both, it cannot be
separated safely from continued work; such totals remain unchanged rather than
guessing a reset from hook timestamps or reasons.
Missing request history can likewise prevent the first resumed turn from being
identified. The runtime fix protects new results independently of this recovery.

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

## Migration lineage

Migration 101 removes transcript markers, migration 102 adds persisted message
turn boundaries, and Claude accounting follows them at migration 103. Keep the
numeric `migrationEntries` values literal because the lineage checker parses
that source.

A parent completion retains `claudeResultObserved`: true for an SDK result,
false for a synthetic UI turn closed without one. Every actual result ends its
accounting span, even when its breakdown is untrusted or withheld, so a later
result cannot suppress that span's child usage. Explicitly resultless synthetic
turns leave the span open. Older completions lack this distinction: they form
conservative barriers rather than allowing unrelated later usage to erase
children. In that ambiguous history, a child may remain separately counted
when a later result also included it; the missing evidence cannot safely settle
that overlap.

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
