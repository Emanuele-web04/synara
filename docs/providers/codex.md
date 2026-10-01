# Codex provider accounts

Synara can run multiple Codex accounts side by side. Each account has its own
sign-in, so you log in to each one **once** and never need to log out to switch.
Sessions, model discovery, health checks, and git text generation all route to
the account selected for the thread.

## Where accounts live

Open Settings → Providers, scroll to **Provider tools**, and expand **Codex**.
The **Codex accounts** list has one row per account:

- The first row is the default account: your regular Codex sign-in. It can be
  renamed, given an accent color, or switched off, but not removed.
- Each row shows the account's state (`Authenticated`, `Not authenticated`,
  `Unavailable`, `Disabled`, …) and a switch. A switched-off account keeps its
  settings and disappears from the model picker.
- Selecting a row opens its editor beside the list: display name and accent
  color, sign-in state, runtime paths, and environment variables. Launch
  details most accounts never touch sit behind **Advanced**.

In the model picker every enabled account gets its own tab. Accounts of the
same provider share the provider icon, so the open tab spells out its
account's name and every account beyond the default carries a dot on its icon,
in the account's accent color when it has one. An account other than the
default is also named on the composer's model button, so you can always tell which account a
message will use.

## How isolation works

Codex reads state from `CODEX_HOME`. Synara asynchronously prepares a generated
overlay under `$SYNARA_HOME/codex-home-overlay` (or the corresponding Synara
runtime directory) and uses an account-specific subdirectory for isolated
accounts:

- Shared non-database state is linked from the base Codex home. SQLite files
  are not mirrored; `CODEX_SQLITE_HOME` keeps every process opening them from
  the base home through one stable path.
- Account-private state (`auth.json`, `models_cache.json`) comes from the
  account's **shadow auth home** instead. Missing files are allowed so Codex
  can create new account state lazily, while an existing private file that is
  itself a symlink is rejected to prevent accounts from aliasing credentials.
- Synara writes the generated `config.toml` only inside the overlay and leaves
  the source configuration untouched.

The default account uses the same overlay mechanism, with authentication and
other shared state sourced from the configured Codex home (`~/.codex` by
default).

## Adding a second account

1. In the **Codex accounts** list, choose **Add account**.
2. Give it a label (e.g. "Work"). The account ID is filled in from the label
   (`codex_work`); it is the key threads use to find the account, so it cannot
   be changed later. Optionally pick an accent color.
3. Leave **CODEX_HOME path** blank to let Synara keep the account's sign-in in
   its own folder, then choose **Add account**.
4. Select the new row. While it is not signed in, the editor shows the command
   to run, built from the account's **Terminal command** (`codex-work` for an
   account with the ID `codex_work`):

   ```sh
   codex-work login
   ```

   Run it in a Synara terminal, then choose **Refresh status** at the top of
   the Providers settings. The row turns to `Authenticated`.

5. Open the model picker in a new thread and pick a model from the account's
   tab.

To reuse a Codex home you already signed in to, choose **Import directory**
instead of **Add account**; Synara references the directory without moving it.

### Keeping the sign-in in a directory you control

Set **Shadow auth home** in the account's editor to a directory such as
`~/.codex_work` to keep only the account's sign-in there while it shares
settings and history with the default account. The login persists in
`~/.codex_work/auth.json`. Synara links it into the account overlay when
possible, with a file-copy fallback on systems where file symlinks are
unavailable, and never logs its contents. The overlay is refreshed during
asynchronous process-environment preparation before Codex launches.

Set **CODEX_HOME path** instead to keep everything about the account separate.

## Caveats

- An account with **no shadow auth home and no dedicated CODEX_HOME** starts
  signed out and keeps its own login inside its
  managed overlay home. Use a shadow auth home when you want the login to live
  in a directory you control.
- An account with its own dedicated **CODEX_HOME** mirrors that home's
  credentials, so external `codex login` runs against it stay visible.
- A shadow auth home must be a real directory with real credential files;
  symlinked shadow homes or `auth.json` files are rejected so accounts can
  never alias each other's credentials.
- A thread stays on the account it started with. In a started thread the other
  accounts' tabs are closed; start a new thread to use another account.
- Accounts created before the account list existed keep their name and homes
  in their original settings entry. They are edited in the same list, but have
  no environment variables of their own.
