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
