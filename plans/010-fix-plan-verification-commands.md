# Plan 010: Replace invalid path-forwarded `bun run test` commands in Devin plans

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat dc66c88..HEAD -- plans/README.md plans/001-devin-model-catalog-single-source.md plans/003-devin-user-input-elicitation.md plans/004-devin-slash-command-discovery.md plans/005-devin-health-auth-alignment.md`
> If any in-scope plan file changed since this plan was written, compare the
> "Current state" excerpts against the live text before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx, docs
- **Planned at**: commit `dc66c88`, 2026-06-11

## Why this matters

Several committed plans tell executors to run `bun run test -- <path>`. In this
repo, the root `test` script is `turbo run test`, so the path is interpreted as a
Turbo task name and fails with `Could not find task`. Bad verification commands
cause executor agents to report false failures or improvise. This plan fixes only
the plan documentation and index, not source code.

## Current state

- `package.json:39-43` defines root scripts:

```json
"typecheck": "turbo run typecheck",
"lint": "oxlint --report-unused-disable-directives",
"test": "turbo run test",
"fmt": "oxfmt"
```

- Invalid or misleading plan commands currently appear at:

```md
// plans/001-devin-model-catalog-single-source.md:115
`bun run test -- apps/server/src/provider`

// plans/001-devin-model-catalog-single-source.md:297
`bun fmt && bun lint && bun typecheck && bun run test -- apps/server/src/provider packages/shared packages/contracts`

// plans/003-devin-user-input-elicitation.md:368
`bun fmt && bun lint && bun typecheck && bun run test -- apps/server/src/provider`

// plans/004-devin-slash-command-discovery.md:98,192,257,273
`bun run test -- apps/server/src/provider...`

// plans/005-devin-health-auth-alignment.md:159
`bun fmt && bun lint && bun typecheck && bun run test -- apps/server/src/provider`
```

- `plans/README.md:16-17` already correctly says tests run via `bun run test` or
  `bunx vitest run <file>`, but the individual plan commands contradict it.

Repo convention:

- Use `bunx vitest run <file-or-glob>` for path-scoped test runs.
- Per repo AGENTS.md, `bun fmt`, `bun lint`, and `bun typecheck` are heavyweight
  and should run exactly once as the final verification pass for code plans.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Find invalid commands in older plans | `rg "bun run test --" plans/001-devin-model-catalog-single-source.md plans/003-devin-user-input-elicitation.md plans/004-devin-slash-command-discovery.md plans/005-devin-health-auth-alignment.md plans/REVIEW.md` | no matches after edit |
| Final doc grep | `rg "bunx vitest run" plans/00*.md plans/RUN.md plans/README.md` | scoped test commands remain visible |

Do not run `bun fmt`, `bun lint`, `bun typecheck`, or tests for this docs-only plan
unless the operator explicitly asks; this plan only edits markdown command text.

## Scope

**In scope** (only files to modify):

- `plans/001-devin-model-catalog-single-source.md`
- `plans/003-devin-user-input-elicitation.md`
- `plans/004-devin-slash-command-discovery.md`
- `plans/005-devin-health-auth-alignment.md`
- `plans/README.md`

**Out of scope** (do NOT touch):

- Source code.
- Tests.
- `package.json` scripts.
- Already-executed plan statuses except adding this Plan 010 row and marking Plan
  010 itself when done.

## Git workflow

- Branch: current branch `devin-acp-provider-v2`.
- One commit: `Fix Devin plan verification commands`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Replace invalid commands in older plans

Edit only command text in the plan markdown files.

Recommended replacements:

- `bun run test -- apps/server/src/provider` → `bunx vitest run apps/server/src/provider/**/*.test.ts`
- `bun run test -- apps/server/src/provider/acp` → `bunx vitest run apps/server/src/provider/acp/**/*.test.ts`
- `bun run test -- apps/server/src/provider packages/shared packages/contracts` → use explicit focused commands already listed in each plan plus, when needed, `bunx vitest run apps/server/src/provider/**/*.test.ts packages/shared/src/**/*.test.ts packages/contracts/src/**/*.test.ts`

Keep each plan's final `bun fmt && bun lint && bun typecheck` command unchanged
unless it currently chains an invalid test command after it. If a plan needs both,
write them as separate final verification bullets so the heavyweight gate remains
the single final fmt/lint/typecheck pass.

**Verify**: `rg "bun run test --" plans/001-devin-model-catalog-single-source.md plans/003-devin-user-input-elicitation.md plans/004-devin-slash-command-discovery.md plans/005-devin-health-auth-alignment.md plans/REVIEW.md` → no matches.

### Step 2: Update README guidance if needed

In `plans/README.md`, keep the existing warning never to run `bun test`. Add one
short sentence that path-scoped tests should use `bunx vitest run <file-or-glob>`.
Do not rewrite the whole README.

**Verify**: `rg "path-scoped|bunx vitest run" plans/README.md` → at least one match.

### Step 3: Final status update

Mark Plan 010 `DONE` in `plans/README.md` when complete. Do not change statuses
for Plans 001-009.

**Verify**: `rg "\| 010 .* DONE" plans/README.md` → one match.

## Test plan

- No code tests are required. This is docs-only.
- Grep verifies no invalid path-forwarded root test commands remain.

## Done criteria

- [ ] `rg "bun run test --" plans/001-devin-model-catalog-single-source.md plans/003-devin-user-input-elicitation.md plans/004-devin-slash-command-discovery.md plans/005-devin-health-auth-alignment.md plans/REVIEW.md` returns no matches.
- [ ] `plans/README.md` includes guidance to use `bunx vitest run <file-or-glob>` for path-scoped tests.
- [ ] Plan 010 status row is `DONE`.
- [ ] No source files are modified.

## STOP conditions

- You find a valid package-level `bun run test -- <path>` usage that should not be changed.
- Fixing command text requires changing `package.json` scripts.
- A grep verification fails twice after a reasonable edit attempt.

## Maintenance notes

- Future plans should avoid root `bun run test -- <path>` unless `package.json`
  changes to forward paths to Vitest.
- Reviewer should check the final grep, not manually inspect every command.
