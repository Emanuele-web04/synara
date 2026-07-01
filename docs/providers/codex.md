# Codex provider accounts

Synara can run multiple Codex accounts side by side. Each account is a provider
instance (Settings → Provider tools → Codex → Provider instances) with its own
auth state, so you log in to each account **once** and never need to log out to
switch — sessions, model discovery, health checks, and git text generation all
route to the account selected for the thread.

## How isolation works

Codex reads all state from `CODEX_HOME`. Synara builds a per-account overlay
home for every session:

- Shared state (sessions, caches, sqlite files) is symlinked from the base
  Codex home so every account sees the same conversation history and config.
- Account-private state (`auth.json`, `models_cache.json`) is symlinked from
  the account's **shadow auth home** instead, so credentials never leak across
  accounts. A shadow home whose `auth.json` is itself a symlink is rejected.
- `config.toml` is copied per account.

The default instance uses the plain Codex home (`~/.codex` or the configured
`CODEX_HOME`) unchanged.

## Adding a second account

1. Pick a directory for the account's private auth state, e.g. `~/.codex_work`.
2. Log the Codex CLI into that account once, redirecting its home:

   ```sh
   CODEX_HOME=~/.codex_work codex login
   ```

3. In Synara, open Settings → Provider tools → Codex → Provider instances →
   Add, give the instance a label (e.g. "Work"), and set **Shadow auth home**
   to `~/.codex_work`.
4. Pick the account from the model picker's instance selector when composing.

The login persists in `~/.codex_work/auth.json`; Synara only ever points Codex
processes at it and never copies or logs its contents. External `codex login`
runs against the same home are picked up automatically.

## Caveats

- An instance with only a label/account id but **no shadow auth home and no
  dedicated CODEX_HOME** starts signed out and keeps its own login inside its
  managed overlay home. Use a shadow auth home when you want the login to live
  in a directory you control.
- An instance with its own dedicated **CODEX_HOME** mirrors that home's
  credentials, so external `codex login` runs against it stay visible.
- A shadow auth home must be a real directory with real credential files;
  symlinked shadow homes or `auth.json` files are rejected so accounts can
  never alias each other's credentials.
- Threads keep the instance they started with; switching the account of a
  thread with a live session restarts the provider session.
