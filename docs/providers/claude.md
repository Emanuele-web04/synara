# Claude provider accounts

Synara can run multiple Claude accounts side by side. Each account has its own
sign-in, so you log in to each one **once** and never need to log out to switch.
Sessions, health probes, and git text generation all run with the selected
account's environment.

## Where accounts live

Open Settings → Providers, scroll to **Provider tools**, and expand **Claude**.
The **Claude accounts** list has one row per account:

- The first row is the default account: your regular Claude sign-in. It can be
  renamed, given an accent color, or switched off, but not removed.
- Each row shows the account's state (`Authenticated`, `Not authenticated`,
  `Unavailable`, `Disabled`, …) and a switch. A switched-off account keeps its
  settings and disappears from the model picker.
- The editor of a signed-in account names who it is signed in as: the email
  the Claude CLI reports, plus the organization when it is not the personal
  default. The state line carries the subscription (`Claude Max Subscription`).
- Selecting a row opens its editor beside the list: display name and accent
  color, sign-in state, runtime paths, and environment variables. Launch
  details most accounts never touch sit behind **Advanced**.

In the model picker every enabled account gets its own tab. Accounts of the
same provider share the provider icon, so the open tab spells out its
account's name and every account beyond the default carries a dot on its icon,
in the account's accent color when it has one. Hovering a tab shows the
account's signed-in email, and the account entries inside the picker list it
beside the account name. An account other than the
default is also named on the composer's model button. A thread stays on the account it
started with; start a new thread to use another account.

## How isolation works

The Claude CLI stores credentials under `~/.claude/.credentials.json` (or
`$CLAUDE_CONFIG_DIR`). Synara launches every Claude process for an account
with the account's configured home as `HOME`, so each account keeps its own
credentials, settings, and session state. On Windows the profile variables
(`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE`, `HOMEPATH`) are
mirrored to the same directory so Claude never falls back to the default
profile.

When a usable CLI login exists for the selected home, Synara also strips stale
inherited request credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`) from the child environment so the account's OAuth
login wins. Direct credentials remain available for API-key-only accounts
without a usable local login and for explicitly configured external auth modes.

## Adding a second account

1. In the **Claude accounts** list, choose **Add account**.
2. Give it a label (e.g. "Work"). The account ID is filled in from the label
   (`claude_work`); it is the key threads use to find the account, so it cannot
   be changed later. Optionally pick an accent color.
3. Leave **Claude config directory** blank to let Synara keep the account's
   sign-in in its own folder, or point it at a Claude config folder you already
   signed in to. Then choose **Add account**.
4. Select the new row and choose **Sign in**. Synara runs the Claude login in
   the account's own environment; complete the browser prompts it opens. When
   the login exits, Synara rechecks the account (choose **Check authentication**
   if the prompts finished outside the dialog). The row turns to
   `Authenticated` and the editor shows the signed-in email. The same login
   also works from a Synara terminal through the account's **Terminal command**
   (`claude-work auth login` for an account with the ID `claude_work`),
   followed by **Refresh status** at the top of the Providers settings.

5. Open the model picker in a new thread and pick a model from the account's
   tab.

To reuse a Claude directory you already signed in to, choose **Import
directory** instead of **Add account**; Synara references the directory without
moving it. An account that needs a whole separate home sets **Claude HOME
path** under **Advanced**.

## API-key accounts

For an account that authenticates with an API key instead of a CLI login,
select its row and add an `ANTHROPIC_API_KEY` entry under **Environment
variables**, marked as secret. Environment variables are scoped to that
account; use a home without a usable Claude OAuth login when direct API-key
auth should win.
