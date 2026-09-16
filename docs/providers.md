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

The composer uses the same compact model-and-reasoning panel before and after a chat starts.
**Presets** appear above the current configuration. Set a model and effort, then use the star
beside **Current configuration** to save that pair. You can save several efforts for the same
model and restore one with a single click. Models without an effort ladder save their thinking
setting, when available, or just the model. The effort slider is the default; the menu preference
still works, and configuration changes leave the panel open so you can save the result.

Open the current model label to browse providers and models inside that same panel. The Back
control, Left Arrow outside the search field, or Escape returns one level; Escape from the
configuration closes the picker. Choosing a model returns to its effort controls, or to a note when the model
exposes no adjustable settings. After a chat
starts, browsing skips the provider list and shows only the locked provider's models.

Presets are stored locally, independently of model favourites. They do not copy your prompt,
speed, context window, or agent settings. Claude Ultrathink presets apply the existing prompt-prefix
behavior without saving prompt text; an Ultrathink-controlled prompt must be edited before a
different effort can be restored. After a chat starts, only presets for its locked provider are
shown. Missing models or unsupported efforts stay saved and removable, with an explanation;
applying a preset never silently substitutes a different model or effort.

In the model catalog, use the star beside any model to add or remove a favourite without selecting it or closing the
picker. Favourites appear first, followed by the remaining model groups (or **Other models** for
an ungrouped catalog). A model appears only once. Search filters both sections, and upstream
provider labels distinguish favourites from different catalogs without repeating the active provider.

Favourites are saved locally for each provider and also used by the next/previous model shortcuts.
Existing Cursor, OpenCode and Pi favourites are preserved. Models absent from the current catalog
are not displayed, but their saved preference is retained if they become available again.
Supported provider executables can also be pointed at custom binary locations.

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

## Cline

Cline is an installed CLI provider, connected through `cline --acp`. Install the
current CLI with `npm install -g cline`, run `cline auth` in a terminal, then select
Cline in Synara. Settings → Providers supports a custom executable path, provider
enablement, and custom model IDs. A successful `--version` check proves only that
the CLI is installed; authentication is verified by Cline when a session starts.

The model picker discovers the configured upstream provider's model catalog from
ACP `configOptions`. IDs are preserved verbatim. **Cline configured model** follows
the CLI's default at session startup; no specific hosted model, quota, or reasoning
setting is assumed. Configure the upstream provider/account in Cline itself (or
with Cline's documented environment variables), not with another Synara provider's
credentials. Discovery failures are shown rather than replaced with an invented
model catalog.

Synara uses native Plan/Act modes and routes ACP permission requests through its
existing approval controls. It explicitly disables Cline auto-approval even for
Full Access sessions: Synara decides how to answer each request. Configuration
failures prevent prompt dispatch. Text, images, file attachments, streamed replies,
tool calls, plans, usage events, cancellation, and session load/resume are supported.
Cancellation retires the child process to isolate late events; the next session can
resume from the saved cursor. Scoped Synara MCP tools use the existing gateway.

Native rollback, compaction, thread import, skills/plugins, command discovery,
turn steering, and quota polling are not advertised. Rollback uses Synara's
restart-with-history path. Git text generation is unchanged. Cline's official icon
is included with attribution under `third-party/cline-icon`.

References: [Cline ACP](https://docs.cline.bot/usage/acp),
[Cline CLI reference](https://docs.cline.bot/cli/cli-reference).
