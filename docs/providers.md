# Providers

Synara does not host models or sell a separate model subscription. It operates supported
coding-agent runtimes installed and authenticated on your machine, then presents them through one
consistent workspace.

## Supported providers

| Provider                                                                | What Synara connects to                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Claude Code](https://www.trysynara.com/docs/providers/claude-code)     | Your installed Claude Code runtime and authenticated account |
| [Codex](https://www.trysynara.com/docs/providers/codex)                 | Your installed and authenticated Codex CLI                   |
| [OpenCode](https://www.trysynara.com/docs/providers/opencode)           | Your local OpenCode runtime and configured model providers   |
| [Cursor](https://www.trysynara.com/docs/providers/cursor)               | Your local Cursor agent runtime and account                  |
| [Devin](https://docs.devin.ai)                                          | Your installed and authenticated Devin CLI                   |
| [Antigravity](https://www.trysynara.com/docs/providers/antigravity)     | Your installed and authenticated Antigravity CLI             |
| [Grok Build](https://www.trysynara.com/docs/providers/grok)             | Your configured Grok Build runtime and access                |
| [Pi](https://www.trysynara.com/docs/providers/pi)                       | Pi and the model providers configured through it             |
| [Factory Droid](https://www.trysynara.com/docs/providers/factory-droid) | Your installed and authenticated Droid runtime               |

Provider availability can differ between the current stable release and development builds. Use the
provider settings in your installed Synara version as the authoritative list for that build.

## What Synara manages

Synara provides the shared operating surface around each provider:

- Project and task ownership
- Provider and model selection
- Conversation and tool activity
- Approvals and user-input requests
- Terminal, browser, file, and diff surfaces
- Git environments and checkpoints
- Session continuation where supported
- Provider handoffs
- Usage information where the provider exposes it

## What remains provider-owned

The provider still controls:

- Installation
- Authentication
- Account and subscription limits
- Model availability
- Tool behavior
- Permission semantics
- Service availability
- Provider-specific session features

A provider working in its own terminal is an important prerequisite, but not a guarantee that every
provider feature is supported through Synara.

## Connect a provider

1. **Install the official runtime.** Use the provider's official installation instructions.
2. **Authenticate outside Synara.** Complete the provider's normal sign-in or credential setup.
   Verify the runtime from a fresh terminal.
3. **Open Synara provider settings.** Confirm that the provider is detected and enabled. When
   necessary, configure a custom path to the provider executable.
4. **Check model discovery.** Open the model picker and confirm that the expected models and options
   appear. Synara discovers many provider capabilities at runtime; the result can depend on the
   installed CLI version, account, subscription, and provider configuration.
5. **Start a small test task.** Use a harmless objective in a test repository before relying on a
   newly configured provider for important work.

## Models and effort options

Providers expose different selection models:

- A fixed catalog
- A catalog discovered from the installed runtime
- User-configured custom models
- Reasoning, effort, mode, or variant options
- Account-dependent availability

Synara normalizes these choices into the composer where possible without pretending that every
provider has identical capabilities.

The composer model picker has one tab per connected provider and a Starred tab. Starring a model
saves it together with its current effort and speed, so one click (or `mod+1`…`mod+9` while the
picker is open) restores the whole combination. A task that has started stays on its provider: only
that provider's tab and starred entries are offered. Supported provider executables can be pointed
at custom binary locations.

## Provider sessions

Use [Import projects](project-import.md) to bring local Codex and Claude Code projects and
conversations into Synara. The flow links existing folders, merges matching project destinations,
and creates independent conversation copies without replacing your existing Synara work.

Each task owns a provider session.

The session may preserve provider-specific behavior such as:

- Plans
- Tool calls
- Approvals
- Reasoning summaries
- Context usage
- Model changes
- Resume or reconnect behavior
- Provider-native subagents or workflows

Capabilities vary. Do not assume a control available for one provider exists for all of them.

### Claude prompt caching and resumed sessions

Synara uses the installed Claude Code runtime through the Agent SDK. Claude owns prompt caching,
session restoration, and automatic compaction. Resuming a saved conversation restores its history;
it does not restore an expired server-side cache. An unchanged prefix can still be reused after a
process restart while its cache remains valid. Leaving a process open does not refresh that cache.

The main-conversation cache policy applies to both CLI and SDK turns. The effective lifetime depends
on the account and Claude settings; Synara does not force a lifetime or change the selected model,
effort, or compaction threshold to reduce usage. See Anthropic's
[prompt caching documentation](https://code.claude.com/docs/en/prompt-caching).

Cache observations distinguish input outside the cache, cache reads, and cache writes. These are
token counts, not percentages of an Anthropic subscription allowance. A likely-warm observation is
an estimate, since changes to the model, tools, or conversation can invalidate a previously cached
prefix. Missing information remains unknown. The adapter preserves the last observation alongside
the native resume cursor and incorporates native resume metadata when the runtime provides it.

Compare equivalent CLI, SDK, and Synara runs before attributing a cache miss to the wrapper;
transcript file size and base64 image size are not model token counts.

When Claude has more than 100,000 context tokens and available evidence indicates an expired cache,
Synara holds the next message before delivering it to the runtime. The composer lets you continue
with the full history, compact first when supported, or cancel that send. The held message and attachments survive reconnects and
server restarts; cancelling keeps the message in the conversation. An unresolved request blocks
automatic queue promotion for that task, while other tasks can continue.
Creating a hold and marking its session ready is one atomic operation: a stop, archive, deletion,
or rollback recorded after the original request prevents a delayed cache check from restoring it.

This check also covers long pauses in an existing process and model changes on the next send.
A warm observation for the previous model cannot bypass the review for a different requested model;
checking does not switch the native model or overwrite its cache evidence. It uses saved observations because some
Claude runtimes provide their resume hook only after the first prompt has been delivered. Older or
imported sessions without timing evidence remain unknown, so a warning cannot be guaranteed for
them. The check makes no model request to keep a cache warm or measure its state.

The context popover offers **Compact now** when the installed runtime supports `/compact` and the
task is idle. This uses Claude's native summarization with the current model and settings. It can
reduce the history sent after a long pause; it also processes the existing history once, so running
it after the cache expires can itself consume substantial usage. Automatic compaction and the
selected context threshold remain under the existing Claude settings.

**Compact, then send** keeps the held message separate from `/compact`. Synara releases it only
after a matching native compaction boundary and successful completion. Failure or interruption
keeps the message on hold. If delivery is uncertain, Synara does not automatically repeat the send.
See [cache recovery behavior and verification](claude-cache-recovery.md) for the implementation
boundaries and remaining live validation.

## Switching providers

A [provider handoff](https://www.trysynara.com/docs/workflows/handoffs) allows another provider to
continue the task and work in the same environment with the context Synara passes to it.

Use handoffs deliberately. Review the working tree before and after changing providers so ownership
remains clear.

## When a provider is missing

Check these in order:

1. Does the executable run from a fresh terminal?
2. Is the provider authenticated?
3. Is the expected executable on `PATH`?
4. Is a custom binary path configured incorrectly?
5. Does the installed runtime version support the required integration?
6. Does restarting Synara refresh the provider status?
7. Does the provider itself report a service or account error?

Continue with the [troubleshooting hub](https://www.trysynara.com/docs/troubleshooting) when the
runtime works independently but remains unavailable in Synara.

Use the dedicated [provider guides](https://www.trysynara.com/docs/providers) for exact
installation, authentication, verification, capabilities, update paths, and provider-specific
failure checks.

## Codex asynchronous questions

On Codex versions and models that expose `request_user_input_async`, Synara shows
a question-mark capsule labeled with the number of questions. Opening it reuses
the same question form as blocking prompts: numbered choices, previous/next
navigation, and a separate text answer. Closing the capsule preserves the current
answer draft. A suggested answer is never submitted automatically. The composer
remains available and the agent can continue working while the question is unanswered.

The shared form keeps blocking prompts' existing auto-advance behavior. Async
questions require an explicit submission and scope keyboard shortcuts to the
opened form, so separate questions and the main composer cannot consume each
other's input.

Questions and submitted answers are stored with the assistant message. Refreshing
or restarting Synara restores that state. Concurrent submissions are admitted once
by the server; a second client refreshes the accepted answer. Normal turn-delivery
errors remain visible on the conversation, as for any other user message.

Rolling back a turn or reverting a checkpoint that removes an answer reopens its
question. Formatted question replies do not offer plain-text edit-and-resend, so
the capsule and the submitted message cannot show different answers. Answer updates
preserve the original assistant message's completion time and turn summary.

### App-server protocol

Verified with codex-cli **0.154.0**, its generated experimental TypeScript schemas,
and an isolated native app-server session:

- `request_user_input_async` is a model-facing tool, not a client RPC. It emits
  `item/started` and `item/completed` for an `agentMessage` with
  `delivery: "async"` and `questions: [{ title, options }]`, and immediately
  returns to the agent. `options` may be null for a free-text-only question.
- The answer is an ordinary user message containing the questions and answers.
  Synara uses its existing turn dispatch: `turn/steer` with `expectedTurnId` while
  a turn is active, and `turn/start` once the turn has finished. The existing
  dispatch path also handles the turn finishing while the answer is being sent.
- This differs from `item/tool/requestUserInput`, which carries a JSON-RPC request
  ID and uses a response with an answer map. Its `isBlocking` field and deprecated
  `autoResolutionMs` do not define the native asynchronous tool's answer path.
  The inline asynchronous cards never enter Synara's pending approval/input queues.
- Synara does not force a model or enable experimental model features. Older
  app-server versions retain their existing text and blocking-question behavior;
  malformed structured questions fall back to the provider's message text.

Scope: native Codex questions in a top-level conversation. Other providers and
subagent question routing are outside this implementation.

Sources: [OpenAI app-server documentation](https://developers.openai.com/codex/app-server),
[upstream asynchronous tool handler](https://github.com/openai/codex/blob/b0d95427c2443e90998f48065902309187564085/codex-rs/core/src/tools/handlers/request_user_input_async.rs).
