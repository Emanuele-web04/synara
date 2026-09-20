# Claude cache recovery

Synara retains Claude Code's native cache behavior. Saved conversation history is durable; the
provider's prompt cache has a limited lifetime. A process restart does not necessarily invalidate a
warm prefix, and a process left running does not refresh an idle prefix.

## Evidence and policy

The Claude adapter keeps optional cache observations with the native resume cursor. It accepts
native SessionStart metadata and request usage, with session and generation checks. Usage is
deduplicated by API message ID; repeated assistant blocks do not count as separate requests.
Main-conversation observations exclude subagent usage.

The lifetime comes from native cache-creation usage, when available. The estimate uses the earliest
local observation of the request, so streaming a long answer does not keep moving the expiry time.
An explicit expired observation takes precedence over a local warm estimate. Missing values, old
sessions without timing evidence, and invalid clocks remain unknown.

Before sending a user message, the orchestration layer obtains a bounded local observation without
queueing the prompt. A context larger than 100,000 tokens with evidence of an expired cache requires
a choice. This applies to a resumed process and a long pause in the same process. Unknown evidence
does not block ordinary use. There is no periodic inference to maintain or inspect the cache.

The displayed input, cache-read, and cache-write counts describe requests. They are not percentages
of an Anthropic subscription allowance. A warm estimate does not guarantee a hit if the provider
changes the prefix or configuration.

## Durable choices

The original message and attachments use the existing conversation journal. A nullable projection
field stores the pending review, its message and source event, assessment, status, and optional
compaction turn identity. The review appears in full, detail, and shell snapshots.

| Choice                     | Behavior                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Continue with full context | Revalidate the saved assessment and deliver the held message once through ordinary orchestration. |
| Compact, then send         | Run a separate native `/compact` operation; deliver the held message only after verified success. |
| Cancel this send           | Clear the pending send while retaining the conversation message.                                  |

Once a choice is accepted, the review panel hides and progress moves to the transcript: the Claude
adapter publishes a "Compacting context" row when native compaction starts (explicit `/compact` or a
native `compacting` status), resolves it at the compact boundary, and marks it failed if the turn ends
without one. The panel returns only for a failed or uncertain review.

Waiting for a choice releases the delivery lock. Other tasks continue normally; queue promotion in
the affected task waits. A response identifies the review and message, and stale or duplicate
responses cannot authorize a different send. Relevant session, model, or context changes require
revalidation. Archive, stop, and delete revoke pending authorization.
Installing a hold and marking the session ready happen in one command. Admission checks the
conversation journal for cancellation after the source request, including cancellation during a
cache observation, so a delayed hold cannot revive a stopped task.

The provider may accept a prompt before Synara persists the acknowledgement. This is not an
exactly-once external API. An ambiguous delivery remains uncertain instead of being blindly
replayed. Cancelling a held send preserves its text for copying; it does not promise that the
existing edit-and-resend action is available for a message with no provider turn yet.

## Native compaction

Command discovery is local and bounded. Unsupported runtimes leave compaction unavailable. The
adapter treats discovery failures as pre-dispatch rejections, so they leave the saved send retryable. The
adapter requires an idle session with no pending interactions or tasks that share the context, and
rechecks that condition after asynchronous preparation. It preserves the current model, permission
mode, and settings. Plan and Ultrathink prompt prefixes must not be prepended to a native command.

A successful result alone is insufficient: the operation must observe the corresponding native
compaction boundary as well. A failed, interrupted, or unrelated operation cannot release the held
message. The original message must not be bound to the temporary compaction turn.
Release also waits for the compaction dispatch to settle and for runtime ingestion to acknowledge
the terminal event. This prevents delayed compaction lifecycle events from consuming the restored
pending-message binding. Claude's live turn state is settled before the adapter publishes completion,
so a released send does not encounter the just-finished compaction as active work. A matching
uncertain review completes through one atomic internal command.
That verified completion also authorizes sending with the reduced context in the same native
session, generation, and model, even if the remaining history exceeds 100,000 tokens and the cache
observation still reports expiry. Increased context or changed session identity requires a fresh
review. An unexpected invariant failure while releasing the message leaves an actionable failed
review and is reported instead of silently leaving compaction in progress.
At startup, that task's domain failure does not block recovery of other tasks. Infrastructure
failures and cancellation still propagate. If a native compaction has neither a recorded terminal
event nor a matching live turn, its uncertain control delivery is abandoned without retrying it.
The saved message stays held for a fresh choice. Uncertainty about delivery of the user's message
after compaction remains quarantined and requires separate reconciliation.

Stopping or archiving remains available while delivery is uncertain. Revoking the send review does
not discard the persisted compaction execution evidence: matching late terminal events can settle
the control delivery without restoring consent, sending the cancelled message, or replaying later
sends that were blocked during quarantine. Startup uses the
same evidence when the visible review has already been cleared.

The standalone compact action retains its exact command in browser session storage until acceptance
is confirmed by the RPC response or observed in the conversation. Retrying after a lost acknowledgement reuses the command receipt,
including after route changes or a page reload. A proven server rejection releases that identity;
a timeout or transport error does not create a new compaction.

Compaction after cache expiry still reads the old history once. Its benefit is the smaller history
on subsequent requests. Synara does not remove old screenshots from the Claude transcript, rewrite
the JSONL, force a cache lifetime, or change the user's model or automatic-compaction threshold.

## Verification boundaries

Automated checks cover cache lifetimes, missing metadata, clock skew, repeated usage, callback
ordering, durable review persistence, duplicate choices, queue isolation, stale authorization, and
compaction correlation. Browser fixtures exercise the review controls and native command action.
These fixtures do not demonstrate actual Anthropic billing or cache reuse.

A local protocol probe with SDK 0.3.259 and Claude Code 2.1.272 initialized an isolated session
without sending a prompt. It verified native command discovery and context-summary access.
SessionStart did not arrive before a prompt in that probe, which is why saved observations are
needed. This is evidence about the tested runtime, not a capability guarantee for every version.

Live CLI/SDK/Synara cache parity remains a separate validation gate. Compare the same runtime,
account, model, effort, settings, directory, tools, and prompt prefix with small synthetic sessions
and an explicit inference budget. Measure warm resume, cold resume, restart, and image retention
separately. Do not use a large customer transcript as the workload or equate simulated timestamps
with real server expiry. No percentage saving or subscription-quota reduction follows from the
offline tests.

## Provider references

- [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)
- [SessionStart metadata](https://code.claude.com/docs/en/hooks#sessionstart-input)
- [Resume from a summary](https://code.claude.com/docs/en/sessions#resume-from-a-summary)
- [Agent SDK native compaction](https://code.claude.com/docs/en/agent-sdk/slash-commands#compact-history-with-compact)
- [Anthropic cache diagnostics](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics)
