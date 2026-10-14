# Synara Vision

## What Synara is

Synara is a desktop-first workspace for coding agents. One app where you run
many AI coding agents — from supported providers — side by side, in a local
checkout or an isolated git worktree, while you stay in control of review,
approval, and shipping.

## Where Synara is headed

- **Every agent, one workspace.** Codex, Claude, Cursor, Devin, Antigravity,
  Grok, Droid, OpenCode, Pi, OMP — providers are interchangeable adapters behind
  shared contracts. No provider-specific behavior leaks into shared surfaces,
  and new providers slot into the same session, turn, and approval model.
- **Parallel by default.** Dozens of threads and worktrees move at once. The
  product's job is to keep that legible: clear transcripts, honest status,
  review-ready diffs, and stacked actions that turn agent output into PRs
  without ceremony.
- **Local-first and predictable.** Project state stays local; selected providers
  receive the context needed to do the work through explicit integrations.
  Correctness under streaming, reconnects, cancellation, and recovery
  comes before new surface area. If a feature can't fail safely, it doesn't
  ship.
- **The operator, amplified.** Synara does the orchestration — plans, follow-up
  steering, automations, computer use — so a single person directs a fleet of
  agents without babysitting each one. Automation earns trust by being
  observable and reversible.
- **Two speeds, one codebase.** Stable for daily production work, Beta for
  explicitly gated early features. Both ship from the same main branch, with
  separate identities, data homes, and update feeds. Stable-to-Beta import must
  preserve supported user data without sharing installation-local identity.

## What belongs here

- Reliability work on the session lifecycle: spawn, stream, interrupt, resume,
  recover.
- Provider integrations that extend reach without special-casing the shared UI.
- Git workflows that shorten the path from agent output to reviewed, merged code.
- Desktop polish that keeps a busy multi-agent workspace fast and legible.

## What does not

- Features that trade correctness for novelty, or that can't degrade safely.
- Provider-specific hacks in shared contracts, UI, or orchestration.
- Anything that quietly moves user data off the machine.
