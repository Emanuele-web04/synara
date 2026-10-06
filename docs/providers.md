# Providers

Synara does not host models or sell a separate model subscription. It operates supported
coding-agent runtimes installed and authenticated on your machine, then presents them through one
consistent workspace.

## Supported providers

| Provider                                                                | What Synara connects to                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| [Claude Code](https://www.trysynara.com/docs/providers/claude-code)     | Your installed Claude Code runtime and authenticated account   |
| [Codex](https://www.trysynara.com/docs/providers/codex)                 | Your installed and authenticated Codex CLI                     |
| [OpenCode](https://www.trysynara.com/docs/providers/opencode)           | Your local OpenCode runtime and configured model providers     |
| [Cursor](https://www.trysynara.com/docs/providers/cursor)               | Your local Cursor agent runtime and account                    |
| [Devin](https://docs.devin.ai)                                          | Your installed and authenticated Devin CLI                     |
| [Antigravity](https://www.trysynara.com/docs/providers/antigravity)     | Your installed and authenticated Antigravity CLI               |
| [Grok Build](https://www.trysynara.com/docs/providers/grok)             | Your configured Grok Build runtime and access                  |
| [Pi](https://www.trysynara.com/docs/providers/pi)                       | Pi and the model providers configured through it               |
| [Oh My Pi](https://www.trysynara.com/docs/providers/omp)                | Your installed Oh My Pi runtime and configured model providers |
| [Factory Droid](https://www.trysynara.com/docs/providers/factory-droid) | Your installed and authenticated Droid runtime                 |

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

Claude's readable reasoning appears as compact progress text between tool actions while it works.
Open a reasoning row to read its available detail. This text comes from the running provider;
Synara does not make another model request to generate it. Models that do not return readable
reasoning continue to show their normal tool activity and assistant messages.
Claude's tool-use summaries also appear as expandable text between tool groups. API retries
show their attempt count and reported delay. Authentication displays its latest state, including
between turns, with a Settings hint when attention is required; raw login output is not shown.
These rows use events already supplied by the provider and do not trigger extra model requests.

The Environment panel's Usage section shows enabled accounts for the active provider, with a
separate row and detail menu for each account. Providers with multiple accounts show account names
beside the provider label. Settings → Usage uses the same account-specific snapshots.
Usage checks follow each account's configured credentials; unassigned thread telemetry and
provider-wide local totals are not used as a fallback for an individual account.

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
2. **Open Settings → Providers.** Confirm that the provider is detected and enabled, then select
   its account and choose **Sign in**. Synara starts the provider's authentication flow in the
   account environment. Complete any browser, Apple, enterprise, device-code, or credential prompts.
3. **Check authentication.** Synara rechecks provider status when the login process exits; for
   interactive CLIs, choose **Check authentication** after completing the prompts. A successful
   process exit alone does not establish authentication. A custom executable path is only needed
   when the installation cannot be discovered automatically.
4. **Check model discovery.** Open the model picker and confirm that the expected models and options
   appear. Synara discovers many provider capabilities at runtime; the result can depend on the
   installed CLI version, account, subscription, and provider configuration.
5. **Start a small test task.** Use a harmless objective in a test repository before relying on a
   newly configured provider for important work.

## Enable or disable providers

In **Settings → Providers → Enabled providers**, turn a provider off to hide it
from provider and model pickers, ordering, CLI tools, custom model settings, usage
options, and the plugin library. Its accounts, saved configuration, custom models,
starred models, and existing threads are preserved; running turns are not interrupted.

Expand **Disabled providers** in the same section to turn it back on. Its saved
preferences return, including its position and whether it was hidden from the
provider picker. Enabling a provider does not install its CLI or sign it in.

## Models and effort options

Providers expose different selection models:

- A fixed catalog
- A catalog discovered from the installed runtime
- User-configured custom models
- Reasoning, effort, mode, or variant options
- Account-dependent availability

Synara normalizes these choices into the composer where possible without pretending that every
provider has identical capabilities.

Claude Code may discover a model under an alias while reporting its concrete model ID separately.
For a release newer than Synara's catalog, the picker shows the concrete ID. Agent Gateway accepts
that ID when it resolves to one discovered non-default model; ambiguous IDs require an exact
advertised alias.

Claude model discovery caches catalogs by the detected CLI version as well as the executable
path. A detected CLI update refreshes the picker even when the path stays the same, including
after a restart. Catalog revalidation uses a temporary Claude process because running sessions
retain the model metadata returned when they initialized. Ordinary picker reads share the
server cache rather than starting a process each time.

For Codex, successful model discovery determines the built-in choices, including when the returned
catalog is empty. Models absent from that catalog are not added back from Synara's static list.
Custom models remain available. Until discovery succeeds, Synara uses a static fallback; a failed
refresh keeps the last successful catalog. The shared discovery cache refreshes catalogs in the
background after its thirty-minute fresh window. Opening a provider/account tab in the composer
checks that catalog on demand and delivers any refreshed list directly to the picker. Other tabs
are not refreshed just because the picker opens, and there is no periodic timer for these checks.
Existing models remain visible while checks run silently, without a persistent refresh row.
If a check fails, an inline error offers **Retry**; a successful retry removes the entire row,
including when the catalog has not changed. The server shares concurrent requests, reuses successful
manual retries for at least one minute, and backs off failures. Checks for the viewed account take
priority over queued background catalog loads.
Failed refreshes retain the last successful catalog. Refreshing does not change the
selected model or restart running sessions, and availability still comes from the provider runtime.

The composer model picker has one tab per connected provider and a Starred tab. Starring a model
saves it together with its current effort, speed, and provider account, so one click (or
`mod+1`…`mod+9` while the picker is open) restores the whole combination, including the account.
Presets of a non-default account show the account name; presets of a removed or disabled account
are hidden. Model cycling prefers the active account's stars. A task that has started stays on its provider: only
that provider's tab and starred entries are offered. Supported provider executables can be pointed
at custom binary locations.

Starred models absent from the current catalog remain saved and can be removed, but cannot be
selected. They become selectable again when discovery or custom model settings add them to the
catalog.

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

If a Codex turn is aborted for inactivity and its gateway access was revoked, Synara renews
the provider runtime and resumes the saved conversation before dispatching another turn.
You can continue in the same task.

### Claude Auto / 200k / 1M selection

The auto-compact selector chooses an override, not a measured context limit. Auto leaves the
window to Claude Code's settings and runtime. Explicit 200k or 1M targets are applied when the
Claude process starts. Changing this override resumes the same native conversation in a new
process once it is idle. Model-only changes, non-max effort, thinking and fast mode retain their
existing live controls; max effort also requires a restart.

On Claude CLI 2.1.259 and 2.1.274, the SDK's live `applyFlagSettings` accepts an auto-compact
window without updating the window used by the runtime. Synara therefore never announces that
live setting as applied. A replacement is refused while a turn, background task, workflow,
subagent, approval, question or send preparation is active. The existing session and event
ownership remain intact. Finish that work and retry; the desired selection remains saved.
Persistent TODO entries survive resume and do not by themselves block replacement.

The meter uses fresh runtime reporting for its denominator and percentage. The applied target
comes from the configuration event, including an explicit Auto state; when that history is
unavailable, Synara does not infer a target from a threshold. Output reserves, environment
settings and model caps can make the effective threshold differ from the target (for example,
967k for 1M or 167k for 200k). Old usage is invalidated after a new configuration or compaction.
The composer model button shows the observed budget after the model and effort, for example
`Fable 5.1 High (1M)`. Auto can show `(1M)` when matching-model runtime reporting supports it;
the tooltip still identifies Auto as the target. A pending change shows `(200k · 1M next)`.
A new thread or missing/mismatched runtime provenance shows the explicit choice as `(1M next)`;
an applied target with an unrecognized runtime budget is labeled `(1M target)`, not confirmed.
No budget is inferred from the model catalog. Compact layouts retain the suffix in the button's
title and accessible text alongside the hidden effort. Other providers are unchanged.
See [Claude context configuration](https://code.claude.com/docs/en/model-config#context-window-and-auto-compaction).

Restart/resume preserves the conversation and Synara's cache observations and counters, but
cannot guarantee a cache hit. The existing large cold-context preflight still applies after
resume. This behavior does not change SDK `snapshot` configuration: enabling prompt recording
with appended system instructions can change instruction freshness on resume and needs separate
validation. See the [implementation plan and evidence](claude-context-switch-plan.md).

### Claude prompt caching and resumed sessions

Synara uses the installed Claude Code runtime through the Agent SDK. Claude owns prompt caching,
session restoration, and automatic compaction. Resuming a saved conversation restores its history;
it does not restore an expired server-side cache. An unchanged prefix can still be reused after a
process restart while its cache remains valid. Leaving a process open does not refresh that cache.

A fresh Claude session becomes resumable only after the runtime emits conversation output.
If a handoff session needs a settings restart before its first message, Synara starts another
fresh session and keeps the prior transcript queued for that message.

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

### OpenCode

Synara uses OpenCode's legacy endpoint family, including `/session` and MCP
for the Synara tools attached to managed sessions. Startup checks `GET /provider`
and rejects a server that reports that route as unavailable; this does not identify
the CLI's version. The SDK is pinned exactly (`1.18.31`) — bump it deliberately,
never by range.

The `opencode` executable resolves from `PATH` first, then the standard install
locations (`~/.opencode/bin`, `~/.bun/bin`, npm/pnpm/yarn global bins, Homebrew,
Volta, asdf, mise, proto, Deno, nvm/fnm). Set an explicit binary path in
provider settings only when the install lives somewhere else entirely.

### Claude Artifacts, `/design` and `/slides`

Claude Code keeps [Artifacts](https://code.claude.com/docs/en/artifacts) off by default for Agent
SDK sessions, so `/design` and `/slides` cannot publish until the host opts in. Turn on **Settings →
Providers → Claude → Artifacts, /design and /slides** and start a new session; Synara then launches
Claude with `CLAUDE_CODE_ARTIFACT=1`. Claude's own requirements still apply: a claude.ai login on a
Pro, Max, Team, or Enterprise plan, Claude Code 2.1.234 or later, and an organization policy that
allows Artifacts. While Artifacts are off or unavailable, the composer marks both commands with a
warning that explains what is missing. Published pages are hosted on claude.ai; Claude returns the
link in its reply.

## Provider profiles and terminal commands

Provider settings can define multiple independently routed instances of any supported provider.
Each enabled instance receives a stable command in newly opened or restarted Synara terminals, for
example `claude-work`, `codex-personal`, or `pi-team`. The command is an executable shim on `PATH`,
not a zsh or bash function, so it behaves consistently from zsh, bash, fish, shell scripts, and
child processes. Bare commands such as `claude` and `codex` keep their existing meaning.

The generated name comes from the provider and stable instance ID. A portable command override can
be configured without tying terminal behavior to the editable display label. Profile shims are
scoped to Synara terminals; Synara does not edit `.zshrc`, `.bashrc`, or other global shell files.

Use **Import directory** in the desktop provider settings to reference an existing provider account
directory. Import is non-destructive: Synara does not move or copy the selected directory. Known
provider roots use their native setting (`CODEX_HOME`, Claude's config directory, or Pi's agent
directory); other providers use the profile-directory mapping shown in settings. Remote browser
sessions can create the same profile manually because a browser cannot safely pick a directory on
the server machine.

A non-default Oh My Pi instance, or one with its own environment, runs under a private home in the
Synara state directory and does not inherit ambient provider credentials, like Pi. **Agent
directory** (or the profile directory) sets `PI_CODING_AGENT_DIR`. Sessions, forks, model and command
discovery, imported history, and the instance's terminal command all use that account.

With `SYNARA_CLAUDE_KEEPALIVE=1` on macOS, the Claude OAuth keepalive runs `claude auth status` for
every enabled Claude account in that account's own environment, so each account's Keychain token
stays fresh.

Sensitive environment values are never serialized into terminal shim files. Directory-backed
authentication works directly. A profile that depends only on a secret environment credential
still works for managed Synara runs, but its named terminal command requires that credential to be
available through a secure runtime mechanism rather than an on-disk shim.

### Sign in from account settings

**Sign in** opens Synara's existing interactive terminal in a settings dialog. It launches the
resolved provider executable directly with the account environment; it does not rely on a profile
shim being available in an external shell. Account edits already being saved settle before launch.
The login runs in an empty directory on the Synara server machine, rather than in your project.
Browser/remote clients still need to complete the provider's browser or device authorization on the
appropriate machine. Synara never submits browser credentials or accepts consent prompts for you.

| Provider      | Entry point                     | Human steps                                                 |
| ------------- | ------------------------------- | ----------------------------------------------------------- |
| Codex         | `codex login`                   | Browser/account authorization                               |
| Claude        | `claude auth login`             | Login method, browser/Apple/organization authorization      |
| Cursor        | `cursor-agent login`            | Cursor browser authorization                                |
| Devin         | `devin auth login`              | Devin/Windsurf/enterprise login selection and authorization |
| Antigravity   | `agy`                           | Startup sign-in and any system credential-store consent     |
| Grok          | `grok login`                    | Browser or displayed authorization steps                    |
| Factory Droid | `droid`                         | Startup prompts and browser/device pairing                  |
| OpenCode      | `opencode auth login`           | Model provider selection and OAuth or API-key onboarding    |
| Pi            | `pi`, then **Sign-in options**  | Startup prompts followed by model provider selection        |
| Oh My Pi      | `omp`, then **Sign-in options** | Startup prompts followed by OAuth/key selection             |

Pi-family **Sign-in options** sends the native `/login` TUI command after you have completed startup
prompts. It is never passed as a model prompt. OpenCode accounts configured for an external server
must authenticate on that server; Synara reports this instead of changing a local account.

For non-default native Devin, Antigravity, and Droid accounts, the first launch saves isolated home
and credential-directory environment settings so later managed sessions and health checks use the
same account as the login. Imported directories and explicit environment values retain precedence.
These account environments block ambient API credentials; explicitly configured secrets remain
available to managed sessions and the selected login process, and are never written into terminal shims.

On macOS, managed Claude accounts keep the system home and username for Keychain access.
Separate `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` values isolate each account;
login, chats, health checks, and usage use the same resolved account directories. Explicit home
overrides remain supported, but a private home can select a different macOS Keychain. Prefer the
system home with separate config and secure-storage directories. Existing credential files are
left in place. If an older sign-in saved credentials under `unknown` or in a private Keychain,
sign in again from the account settings; Synara does not copy or delete Keychain entries.

Claude's account status says **Signed in locally** when the CLI reports stored authentication.
This is not a guarantee that Anthropic will accept the next request. Usage authentication errors
are shown on the matching account in Settings. Inference-only tokens, including tokens from
`claude setup-token`, can run chats without the `user:profile` scope required for live usage.
Tokens injected inside wrapper scripts are not visible to the usage reader.
Restoring an account's appearance and enablement defaults preserves its display name.

**Cancel / close** stops the login process and deletes its terminal history. Sign-in output is kept
in memory while the window is active and is not persisted as a terminal log. Cancellation does not
log out or remove credentials already saved by the provider. Closing errors stay visible and can be
retried. Reconnecting to a completed attempt does not launch it again; use a new **Sign in** attempt
to retry. Synara only reports **Authenticated** when the account's server health check confirms it;
providers without a verifiable login-status probe can continue to show an unknown status.

Entry points checked against provider documentation and the installed Pi CLI source on 2026-10-02:
[Codex](https://developers.openai.com/codex/cli/reference#codex-login),
[Claude](https://code.claude.com/docs/en/cli-reference),
[Cursor](https://cursor.com/docs/cli/reference/authentication),
[Devin](https://docs.devin.ai/cli/enterprise/devin-auth),
[Antigravity](https://www.antigravity.google/docs/cli/install/),
[Grok](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md),
[Droid](https://docs.factory.com/droid-cli/quickstart),
[OpenCode](https://opencode.ai/docs/cli/),
[Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md),
[Oh My Pi](https://github.com/can1357/oh-my-pi/blob/main/docs/providers.md).
Actual provider authentication and packaged Windows behavior require separate qualification; the
launch tests use disposable CLI fixtures and do not authenticate personal accounts.

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

## Cancel a blocking question

Blocking questions show **Cancel** whether or not they offer choices. Cancel applies to
the whole pending request, including any later questions in the same set. Once an
answer or cancellation is being submitted, the form disables Cancel until the
request settles. For OpenCode, cancellation uses its `question.reject` operation;
submitting completed answers uses `question.reply`. Both requests are scoped to
the task's OpenCode working directory.

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

## Passive results from delegated tasks

An authenticated agent can pass `notifyCreatorOnComplete: true` to
`synara_create_thread`, or on individual entries in `synara_create_threads`.
The default is off. The destination is always the authenticated creating task;
there is no destination-ID parameter, and the new task remains standalone.

Synara persists one result for the initial message/run when it completes, fails,
or is interrupted. The creator sees an attributed activity with the child and
run IDs, up to 2,000 characters of final response (with truncation indicated),
and a `synara_read_thread` reference for the full result. Delivery does not start,
queue, steer, or interrupt a creator turn, and does not update human-message
recency. The result is supplied as untrusted reference context on a subsequent
human-started turn; rejected sends retain it, retries keep their assignment, and
uncertain sends remain held by the existing delivery-reconciliation mechanism.
Context is bounded to 16,000 characters per send, so larger fan-outs drain over
subsequent human turns. Native control commands, reviews, and steering do not
consume completion context.

This option covers only the initial delegated run. Approval/question waits and
provider idle alone are not completion. Goals are unsupported: if a goal was
set during the initial run, Synara reports that limitation rather than claiming
the goal finished at an intermediate turn. Later conversational turns do not
produce further notifications. External MCP integrations cannot opt in because
they have no authenticated creating task.

Delivery survives restart and duplicate events. An archived or deleted creator
is not reopened; the result remains in the child and delivery is recorded as
unavailable. Delivery is checked approximately once per second.
