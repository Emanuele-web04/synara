# Task invocation and consent — 11 September 2026

This supersedes the composer activation and per-foreground-action approval choices in the earlier efficiency plan. Permission setup still shares AppSnap's native guide and checks the exact running macOS bundle.

## User flow

- Send `/computer-use <task>`, select a `computer-use` skill, or start the request with an explicit phrase such as “Use Synara computer use…”. `/computer-use` is a Synara command available on all nine providers, including when a provider advertises a command with the same name.
- The composer has no persistent Computer switch. Settings retains setup, backend status and pane preferences. An installed backend, granted macOS permission or AppSnap attachment does not expose Computer to ordinary coding messages.
- In Full access, routine desktop actions proceed without another Synara approval. In approval-required mode, one Computer approval covers routine actions for the exact active turn. Concurrent first calls share one prompt; a decline applies for that turn. Clipboard reading uses separate per-call approval outside Full access.
- Provider risk reviews, Plan restrictions and consequential-action confirmation policies remain applicable. Task consent is not a semantic detector for destructive clicks. Prepare consequential actions before requesting any confirmation required by the applicable policy.
- Stop, disable, terminal turn events and session exit revoke or discard consent. A fresh invocation can rearm control using the current server generation. Older queued invocations keep their frozen generation and cannot revive revoked input.
- A subsequent ordinary turn removes Computer schemas and guidance. Existing Computer observations in provider-managed history cannot be erased, so this does not promise identical billing to a conversation that never used Computer.

## Implementation boundaries

Invocation detection inspects the current user-authored opening line or selected skill, never appended attachments, terminal excerpts, quoted content or past turns. Agent/automation messages do not infer consent from imperative text. Durable turn-start and queued metadata carry the same intent used by the provider reactor. A live coding turn that needs a new Computer tool catalog is interrupted and queued for a new provider turn; it cannot acquire tools through a plain steer.

Synara's gateway owns routine Computer consent. Providers with independent raw tool permission callbacks delegate only exact, recognized Synara Computer tools to that gate while task capability is enabled. Unrelated MCP tools and native risk-review decisions retain their existing handling. Codex's installed native elicitation omits `tool_name`: the compatibility path accepts only its complete generated message after verifying the reserved `synara` server, native approval kind, exact active parent turn, live gateway lease and Default/Approval-required mode. It never requests session or permanent persistence.

The transcript retains tool identity, action titles and Codex progress messages. Computer action summaries name the operation and available control/app target without repeating typed or clipboard values. Native delivery verdicts remain authoritative: an uncertain effect must be observed, never blindly repeated or automatically promoted to foreground.

## Verification

Focused tests cover invocation versus quoted/agent text, durable dispatch and queued generations, all-provider command discovery, shared consent, decline, concurrent cancellation, Stop races, clipboard separation, provider metadata and the rendered consent UI.

- `bun fmt` and `bun lint` passed; lint reported warnings and zero errors. `bun typecheck` passed across all seven packages after correcting one optional-property mismatch in the Codex guard. A subsequent server typecheck covers the installed-envelope compatibility fix.
- The complete Codex manager suite passed 152 tests with one existing skipped test; after adding the actual installed envelope, the 27-test MCP approval group passed. The initial sandbox run could not verify process-tree exit; rerunning with process inspection available passed.
- The contextual transcript suites passed 194 tests. Focused provider consent coverage passed 21 tests across Claude, OpenCode, ACP and the shared provenance rules. Earlier task-level suites cover the gateway, manager, invocation, dispatch and all-nine-provider capability matrix; the two approval/composer browser suites passed 13 tests.
- Final cleanup: 124 work-log tests, 25 shared/ACP boundary tests and 11 approval-card browser tests passed. Server/web typechecks and targeted lint passed again after those edits. Consent rows explicitly say requested/approved/declined rather than appearing to be executed clicks; ACP delegation requires an explicit active turn and Default mode.
- The production server/web bundle built successfully. The exact existing Synara Dev app was reopened without changing its signed native bundle or permission identity.
- Real Codex Full access smoke: the agent clicked the Synara Dev composer, typed `test-ok`, observed the value and left it unsent without additional approval. The result was independently verified through Accessibility. Live transcript rows also showed contextual labels such as `Click on “Ask for follow-up changes”`.
- Real Codex Approval-required smoke: one `Allow Computer for this task` approval was followed by click, typing and fresh observations without another prompt. `test-two` was independently verified in the unsent composer. The obsolete test was cancelled before the final run, exercising fresh invocation after Stop. Test text was cleared and the original Full access setting restored afterward.

Other provider adapters have focused integration coverage, not a claim of live desktop qualification on every provider. Existing provider history retains previous observations; no billing or sustained CPU/RAM benchmark is inferred from these smoke checks.
