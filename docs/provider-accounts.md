# Managed provider accounts

Settings → Accounts manages numbered, machine-local provider identities. The sidebar account menu selects the default for **new** chats. Existing chats keep their persisted provider, ordinal, and binding generation; changing a default does not switch their credentials. Native account 0 preserves the provider's own login. Legacy and externally imported chats remain on native account 0 unless explicitly created with a managed binding.

## Supported surfaces

- Agent API keys: Codex, Claude Code, Cursor, and Grok.
- Managed browser/device login: Codex, using its official CLI with an isolated file-backed credential store.
- Managed desktop-app profiles: unavailable. Claude Desktop isolation is not verified; setting CLAUDE_CONFIG_DIR does not prove desktop isolation.
- Optional terminal shims: supported on macOS/Linux. Windows shim installation is refused. Runtime process launch still uses the shared platform boundary.

Keys are saved locally and are not considered provider-verified merely because storage succeeded. Connection success does not imply that the account became the default. The UI reads the actual account snapshot before describing the active identity.

## Ownership and isolation

All provider-account RPCs require an authenticated owner session. Ordinary paired clients cannot read machine-global identities, connect credentials, change defaults, disconnect accounts, launch apps, or install shims.

The machine-wide root is selected by `resolveAccountRoot`; `SYNARA_ACCOUNT_HOME` can override it for an explicitly isolated installation or test. API keys are private 0600 files under a 0700 account root. The optional launcher reads the same records as the server. Custom provider instances retain their own credentials and endpoint settings; a driver-wide account default does not override them. Numbered managed accounts apply to the default provider instance. An explicit managed-account selection on a custom instance is rejected rather than silently mixing identities. Managed launch resolution supplies ephemeral credentials and an account-specific home before continuation validation and process preparation. Runtime persistence retains the non-secret binding and redacts environment values.

Forks preserve the source account binding. Reconnect increments its generation; stale chats fail closed rather than silently using another identity. A conflicting explicit ordinal, missing credential, disconnected binding, or unavailable account service also fails closed. Disconnecting the active agent account resets the new-chat default to native 0.

## Crash-safe commit boundary

The account record is the commit point. A new reservation keeps its recovery marker until the record exists. Startup recovery removes incomplete reservations together with staged secrets outside the ordinal directory.

API-key reconnects stage a versioned secret and select it with one atomic record update. OAuth reconnects similarly stage a separate home generation. Old records continue to resolve old credentials until the new record commits; a failed activation write never rolls an old secret under a new record. A post-rename durability error does not authorize deleting the credential already selected by that record. Earlier home generations remain private and are not removed underneath a running provider.

Provider mutations are serialized with a reentrant in-process lock and the existing cross-process filesystem lifecycle lock. Recovery treats unknown process liveness conservatively. The standalone launcher validates record identity and credential versions rather than silently accepting a record from another slot.

## Terminal integration

Installing integration creates marked provider shims in the account root's `bin` directory. The user must place that directory appropriately on PATH. Installation and removal refuse to overwrite or remove unrelated executables. Packaged builds stage a self-contained launcher next to the server bundle; source checkouts use the launcher workspace. No shell profile is edited automatically.

## Verification limits

Tests use temporary roots, synthetic credentials, fake provider executables, and injected adapters. They cover transaction failure points, cross-instance locking, native/fork account preservation, owner admission, provider environments, launcher packaging, and UI state. They do not prove real provider authentication, billing, signed desktop execution, or managed desktop-profile isolation. Do not describe those as verified without a separate live check.

### Restore and renew

Hidden accounts appear in Settings → Accounts with a Restore button. Restoring makes the same slot visible again without activating it or altering its credentials.

After reconnecting a managed account, open the affected thread's Environment → Account section and choose **Use reconnected account**. This requires explicit owner confirmation for the displayed old and new generations. The server rejects active turns/background tasks, changed slots, stale generations, and custom provider instances. It stops the old runtime before committing the renewed binding and clears provider-native continuation: a new login may represent a different principal. The confirmation explains that the next turn may send the conversation's history to the renewed account. Failed cleanup or a concurrent reconnect leaves the thread fail-closed; refresh and retry.

Disconnect blocks subsequent launches and resets an active default to native account 0. It does not promise to revoke a process that is already running or erase immutable retired credential/home generations; stop sessions separately and treat the private account directory as sensitive.
