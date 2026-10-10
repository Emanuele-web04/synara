# Audit (READ-ONLY): Profile stats data-source scoping — make it production-correct, no dev/prod mixing

You are GPT-5.5 (xhigh) in the Synara monorepo at `/Users/emanueledipietro/Developer/synara`.
This is a **diagnosis / research task — DO NOT EDIT ANY FILES.** Produce a findings report + options.
We (you + Claude/Opus + the user) will decide the fix together afterward.

## The problem to investigate

The new Profile/stats feature must respect each instance's OWN folders: the **real app** must read the
real app's data, a **dev** instance must read the dev instance's data — NEVER a mix. It is going to
production, so the resolution of every data source must be correct and consistent with how the rest of
the app already resolves those sources.

## What we already verified (trust these; confirm + go deeper)

- `config.homeDir` = `OS.homedir()` ALWAYS (`apps/server/src/main.ts:172,217`) — it is NOT affected by
  `--home-dir`.
- `config.baseDir` = `--home-dir` / `SYNARA_HOME` (dev: `./.synara/electron-dev`; prod: `~/.synara` or
  `~/Documents/Synara`). `config.dbPath` = `baseDir/{dev|userdata}/state.sqlite`.
- So the **projection DB is correctly per-instance** (dev→dev 40 turns, prod→prod 437 turns). ✅
- The **token archives** are read via `config.homeDir`: codex = `codexHomePath || process.env.CODEX_HOME
  || homeDir/.codex`; claude = `homeDir/.claude/projects` (see `apps/server/src/providerUsageSnapshot.ts`).
  Because `homeDir` is always the OS home, BOTH dev and prod read the GLOBAL `~/.codex` and `~/.claude`.
- The dev runner sets `SYNARA_HOME/SYNARA_HOME/SYNARA_HOME=baseDir` but does NOT set `CODEX_HOME` or
  `CLAUDE_CONFIG_DIR`; the dev baseDir has no `.codex`/`.claude` of its own. So dev's own Codex/Claude
  sessions ALSO land in the global `~/.codex`/`~/.claude`.
- The Usage panel passes a `homePath` (the `codexHomePath` setting = `settings.providers.codex.homePath`)
  into `server.getProviderUsageSnapshot` (`serverProviderUsageSnapshotQueryOptions`,
  `useProviderUsageSummary`). The **Profile token RPC does NOT pass `codexHomePath`** — it calls
  `api.stats.getProfileTokenStats({ utcOffsetMinutes })` only (`serverProfileTokenStatsQueryOptions`).
  Right now `codexHomePath` is empty so it doesn't bite, but it is a latent divergence.

## Your tasks (with checks)

1. **Build the canonical resolution map.** For the running instance, determine the exact, authoritative
   way the app resolves each of these (cite file:line):
   - the projection SQLite DB path
   - the Codex sessions root (the home the *active Codex provider* actually reads/writes — trace
     provider start options / `ProviderStartOptions.codex.homePath` / `CODEX_HOME` / settings
     `providers.codex.homePath`, and `ProviderHealth`/`makeCodexProbeEnv`)
   - the Claude transcripts root (does anything honor `CLAUDE_CONFIG_DIR`? where does Claude actually
     write `projects/*.jsonl` for this instance?)
2. **Diff the Profile against the canonical resolution.** Enumerate every place the Profile's two RPCs
   (`apps/server/src/profileStats.ts`, the token loaders in `apps/server/src/providerUsageSnapshot.ts`)
   read a DIFFERENT location than the running instance actually uses, or ignore a setting/env the rest of
   the app honors. Confirm: does the Profile token RPC ignore `settings.providers.codex.homePath`? Does it
   ignore `CLAUDE_CONFIG_DIR`? Any hardcoded `~/.codex` / `~/.claude`?
3. **Characterize the dev/prod "mix".** Confirm precisely which Profile metrics come from `baseDir`
   (per-instance) vs `OS home` (global), and explain why dev shows small SQL stats next to large real
   token totals. State whether this is a *correctness bug* in production (prod reads real DB + real
   archives = consistent?) or only a dev-time artifact.
4. **Determine the production-correct rule.** Define how the Profile SHOULD resolve codex/claude homes so
   that it reads EXACTLY what the running instance uses, in BOTH dev and prod, with no mixing. Account for
   the reality that the codex/claude CLIs write to a global home unless `CODEX_HOME`/`CLAUDE_CONFIG_DIR`
   are overridden per instance.
5. **Run the checks** to back every claim:
   - `sqlite3` on `./.synara/electron-dev/dev/state.sqlite` (dev) and `~/.synara/userdata/state.sqlite`
     (prod) where relevant.
   - filesystem checks: existence of `~/.codex/sessions`, `~/.claude/projects`, any baseDir-local
     `.codex`/`.claude`, the `homePath` value in each `settings.json`.
   - grep the provider-start / env-injection path to see what home the active provider actually uses.

## Deliverable (NO code edits)

A markdown report with:
- A **resolution table**: source × (canonical resolution file:line) × (what Profile currently does) ×
  (dev value) × (prod value) × (mismatch? Y/N).
- A clear statement of the **production-correct rule**.
- **2–3 concrete options** to achieve "dev reads dev, prod reads prod, no mixing", each with: exact files
  to change, tradeoffs, and risk. At minimum cover:
  (a) make the Profile honor the same codex/claude home resolution as the rest of the app (pass
      `codexHomePath`, honor `CODEX_HOME`/`CLAUDE_CONFIG_DIR`) — the minimal production-correct fix;
  (b) fully isolate dev by scoping the codex/claude home to `baseDir` (and what else must change so the
      dev instance also WRITES its sessions there) — and whether that breaks prod;
  (c) any hybrid / disclaimer-only approach.
- A **recommendation** with justification, optimized for production correctness and least risk.

Keep it concrete (exact file:line, exact paths, exact settings keys). Do not edit anything.
