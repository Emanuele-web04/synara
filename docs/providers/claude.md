# Claude provider accounts

Synara can run multiple Claude accounts side by side. Each account is a
provider instance (Settings → Provider tools → Claude → Provider instances)
with its own `HOME` directory, so you log in to each account **once** and never
need to log out to switch — sessions, health probes, and git text generation
all run with the selected account's environment.

## How isolation works

The Claude CLI stores credentials under `~/.claude/.credentials.json` (or
`$CLAUDE_CONFIG_DIR`). Synara launches every Claude process for an instance
with the instance's configured home as `HOME`, so each account keeps its own
credentials, settings, and session state. On Windows the profile variables
(`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE`, `HOMEPATH`) are
mirrored to the same directory so Claude never falls back to the default
profile.

When a usable CLI login exists for the selected home, Synara also strips stale
inherited request credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`) from the child environment so the account's OAuth
login wins. Credentials set explicitly on the instance's environment variables
are kept.

## Adding a second account

1. Pick a directory to act as the account's home, e.g. `~/claude-work-home`.
2. Log the Claude CLI into that account once, redirecting its home:

   ```sh
   HOME=~/claude-work-home claude auth login
   ```

3. In Synara, open Settings → Provider tools → Claude → Provider instances →
   Add, give the instance a label (e.g. "Work"), and set **HOME** to
   `~/claude-work-home`.
4. Pick the account from the model picker's instance selector when composing.

The login persists inside that home directory; external `claude auth login`
runs against the same home are picked up automatically.

## API-key accounts

For an account that authenticates with an API key instead of a CLI login, add
an `ANTHROPIC_API_KEY` entry to the instance's **Environment variables** and
mark it as secret. Instance environment variables always take precedence for
that instance's processes.
