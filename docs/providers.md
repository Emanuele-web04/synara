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

Favorite models can be surfaced above larger catalogs, and supported provider executables can be
pointed at custom binary locations.

## Provider sessions

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
with the full history or cancel that send. The held message and attachments survive reconnects and
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
