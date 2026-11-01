# SQLite free-space reclamation

Deleting rows makes their SQLite pages reusable. Without auto-vacuum, those pages
remain inside `state.sqlite`; a small live dataset can therefore retain a much
larger file. This differs from retention: reclaiming free pages does not delete
additional chats, events, attachments, or migration backups.

New databases use `auto_vacuum=INCREMENTAL` before migration tables are created.
Every 30 seconds, the owning connection checks its freelist. With at least 1 MiB
free, it reclaims at most 256 pages in one transaction, then performs a passive
WAL checkpoint. This bounds page work, not elapsed time on a slow filesystem.
Existing `FULL` databases keep that policy; ordinary deletes on new databases do
not pay the relocation cost of `FULL` mode.

Existing `NONE` databases need a one-time SQLite rebuild before incremental
vacuum can work. After successful startup and clean shutdown, Synara closes its
live SQL connection and attempts that rebuild in an owned subprocess while
retaining its database lifecycle lock. It attempts conversion only when at least
16 MiB and 25% of the database consists of free pages. The filesystem must report
at least twice the original database size plus 64 MiB available. An unavailable
space check or insufficient space defers conversion without starting the rebuild.

The subprocess has a 1.5-second deadline followed by the existing process
termination escalation. Synara waits for child exit before releasing the
lifecycle lock. An interrupted SQLite transaction remains subject to SQLite's
normal crash recovery; startup does not replace the database or discard its WAL.
Failed migrations or newer unsupported schemas do not arm this maintenance.

This is conservative reclamation, not an emergency disk-recovery guarantee:
an almost-full disk can lack the scratch space SQLite requires, and a large
database can exceed the deadline. Either case is deferred and logged, with
another attempt on a later clean shutdown. Forced termination does not promise
reclamation. No production database, reporter workload, or universal completion
time is inferred from temporary-fixture tests.

SQLite documents the [mode-conversion requirement](https://www.sqlite.org/pragma.html#pragma_auto_vacuum)
and [VACUUM scratch-space requirement](https://www.sqlite.org/lang_vacuum.html).

## Explicit offline compaction

When shutdown maintenance keeps deferring a large legacy database, close every
Synara process and every other client of that database. With the CLI distribution
installed, run its maintenance command with the absolute database path:

```sh
synara-compact-database "$HOME/.synara/userdata/state.sqlite"
```

For Beta, explicitly select `$HOME/.synara-beta/userdata/state.sqlite` instead.
For Synara Remote, explicitly select `$HOME/.synara-remote/userdata/state.sqlite`.
Custom homes and development databases require their own actual path. The command
does not discover homes, open another channel's database, start the server, or
change retention. On Windows, pass a quoted absolute path, for example
`synara-compact-database "$env:USERPROFILE\.synara\userdata\state.sqlite"`
in PowerShell. A source checkout can run the built entry with
`node apps/server/dist/compactDatabase.mjs <absolute-database-path>` using a Node
version supported by `apps/server/package.json`. Bun is not supported and is
refused before the target database is inspected or locked.

A desktop installer does not add this global CLI command to `PATH`. It includes
`apps/server/dist/compactDatabase.mjs` inside `resources/app.asar`; use the
installation's own runtime in Node mode and the explicit database path. For the
default macOS Synara Remote installation, after quitting the app and all other
clients:

```sh
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/Synara Remote.app/Contents/MacOS/Synara Remote" \
  "/Applications/Synara Remote.app/Contents/Resources/app.asar/apps/server/dist/compactDatabase.mjs" \
  "$HOME/.synara-remote/userdata/state.sqlite"
```

Adjust both application paths for a different installation location and select
the actual database explicitly for a custom home. This invocation does not start
the app or discover another channel's database.

The command holds the existing database lifecycle lock and refuses pending
migration recovery, including malformed recovery markers. It asks SQLite to
recover and retire WAL before building a private `VACUUM INTO` copy beside the
database. It verifies the copy's full `integrity_check`, user table row counts,
application ID, schema user version, and auto-vacuum policy before installing it.
Legacy `NONE` becomes `INCREMENTAL`; existing `FULL` and `INCREMENTAL` policies
remain unchanged. Migration backups and recovery markers are never removed.

Scratch-space admission requires approximately 125% of the live pages plus
64 MiB on the same volume, rather than twice the original file size. SQLite can
still report a disk-full error if the estimate is insufficient or other processes
consume the remaining space. A database with roughly 260 MiB of live data cannot
be compacted with only 128 MiB free: free space on that volume before retrying.
The command never deletes retained rows to make the copy fit.

Both SQLite handles close before the parent flushes the verified copy and replaces
the original with a same-volume rename. That rename is the commit point. Before
it, copy failures, insufficient space, or cancellation preserve the original's
logical data; WAL recovery/checkpointing may already have changed its physical
bytes and journal mode. If a final directory flush or lock cleanup fails after
replacement, the error explicitly says the compact database was installed and
asks you to keep Synara closed for inspection. Windows does not expose directory
fsync through the shared filesystem helper, so this does not promise directory
entry durability across sudden power loss on Windows.

Ctrl+C or termination waits for the copy subprocess to exit before releasing the
lock. Copy work has a 15-minute deadline; it is never allowed to install a file
itself. After an abrupt parent crash, the existing stale-lock recovery removes
only the private candidate owned by that dead lock, and a retry starts again from
the database. Cancellation after the rename cannot undo a completed installation.

The offline precondition includes external SQLite tools: the lifecycle lock
coordinates Synara, and active SQLite transactions are refused, but an unrelated
client opening the file between the final checks and rename does not honor that
lock. Keep all clients stopped until the command finishes. This maintenance path
is covered with isolated native SQLite fixtures; it does not establish a universal
completion time or substitute for a packaged Windows runtime check.
