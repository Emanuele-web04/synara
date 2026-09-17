# Comparing Claude cache behavior offline

Use existing Claude Code session JSONL files to compare terminal CLI, direct Agent SDK,
and Synara runs. This command reads a file and prints metadata; it does not start a
provider, make API calls, or modify the transcript:

```sh
node scripts/claude-cache-report.ts /path/to/cli-session.jsonl > /tmp/cli-cache.json
node scripts/claude-cache-report.ts /path/to/sdk-session.jsonl > /tmp/sdk-cache.json
node scripts/claude-cache-report.ts /path/to/synara-session.jsonl > /tmp/synara-cache.json
bun run --cwd scripts test claude-cache-report.test.ts
```

Inputs are Claude's native session JSONL records, including sessions launched by
Synara. SDK assistant records with the same `message.id` and usage shape also work;
SDK records without timestamps cannot provide timing evidence. Synara database
activity exports and raw `stream_event` deltas are not equivalent input formats.
Compaction boundaries accept native `compactMetadata` and SDK `compact_metadata`
records. Token counts absent from either format remain `null`.

The versioned JSON report deduplicates assistant blocks by session and API message
ID, falling back to `requestId` when needed. Aggregate `result` messages and synthetic
API errors are excluded. Partial blocks update only counters they actually contain;
the last available value wins. Missing counters remain `null` in the timeline and
are counted separately in `missingCounters`, so incomplete exports cannot silently
look like zero usage. Cache TTL counters are reported separately from total cache
creation; do not add those subsets to the total again.

Compare the per-request context, cache reads, cache creation, TTL counters, miss
diagnostics, and compaction boundaries. `idleBeforePromptSeconds` uses the previous
response's **last** block and the next observed user prompt. It is distinct from the
gap to the next assistant response. Missing timestamps, anonymous child streams,
and unknown main/child ownership produce unavailable gaps. Main and identified
subagent usage is separated; a transcript need not contain all child requests.

The report contains line numbers, timestamps, model/version/entrypoint metadata,
opaque stream numbers, and token counters. It excludes prompts, system prompts,
tool results, image payloads, local paths, and session/agent IDs. Keep source
transcripts outside the repository; tests use synthetic records only.

For a meaningful comparison, record the same model, effort, context threshold,
MCP inventory, workload, and idle duration for each existing run. A new user prompt
or CWD change does not prove a native process restart. A cache miss after a long
pause does not by itself prove SDK/CLI divergence. Native transcripts do not capture
every request transformation, and these counters do not reconstruct subscription
quota percentages or prove live parity. No paid run is required by this harness.

An offline protocol probe on 2026-09-16 used Agent SDK 0.3.259 with Claude Code
2.1.272, a synthetic saved transcript, and an empty async input stream. With no
model prompt submitted, `getContextUsage({ detail: "summary" })` returned context information;
`SessionStart` had not fired at that point, including after a 1.5-second wait.
Pre-prompt checks therefore need retained usage and summary preflight rather than
depending solely on that hook. This establishes the observed protocol ordering,
not native cache-hit parity or paid inference behavior. The synthetic transcript
and raw probe response are not repository fixtures.
