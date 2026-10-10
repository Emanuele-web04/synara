# Thread history and reload recovery

Conversations open at their recent messages and work. **Load earlier messages** reads an older
page without moving a reader who is following a particular row. **Go to first message**, Home
outside an editor, and the message rail's first-message action load earlier pages before jumping.
Find loads earlier native history while open; pinned messages and message links request the pages
needed for their target. Imported conversations keep their original-history loader and child
threads keep their parent link and context.

## Snapshot and paging contract

`orchestration.getThreadDetailSnapshot` and `orchestration.subscribeThread` accept an optional
`messageWindow`. The web client requests a target of 100 messages and 100 activities. Windows
expand to complete their boundary turns and include the active turn. A large single turn can
therefore exceed the target. Tool-only history has an independent activity cursor.

Optional `snapshot.history` contains total counts, the oldest loaded message/activity boundaries,
and `revisionSequence`. Message boundaries use sequence, creation time and ID; activity boundaries
use creation time and ID because their counters can come from different journals. Both match the
SQLite ordering, including Unicode IDs. Cursors remain useful if their original row is deleted.
An exhausted dimension stays exhausted when only the other dimension is requested.

Every page uses the existing transaction and projection fence. The window limits transcript text
and ordinary activity; session, latest turn, plans, checkpoints, pending interactions, durable
failures, task ownership patches and task-list context remain available. Partial task updates keep
the latest value of each field, so a later status patch cannot erase an earlier background or
workflow ownership transition. The existing activity folds continue to interpret these rows.

Historical pages add missing rows. They do not overwrite current text, settled activity, control
metadata or the applied live-event cursor. Live count growth preserves a page's ephemeral owner;
a snapshot, eviction, correction or server identity change invalidates it. Existing revert and
conversation rollback events supply `revisionSequence`, fenced by the same applied projectors.
A rollback also removes loaded rows from affected turns. A target outside a contiguous window
clears its later loaded messages even if an older server omitted removed turn IDs.

| Caller                                  | Behavior                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| New web client and server               | Recent window, live replay and explicit older pages                           |
| Existing client without `messageWindow` | Existing capped detail snapshot                                               |
| New client with an older server         | Existing snapshot behavior; paging controls require returned history metadata |
| Provider, engine, fork and export paths | Existing full-history source paths; no frontend window is passed to them      |

No database migration or history truncation is introduced. Export retains its unlimited read path.

## Private browser cache

IndexedDB stores one atomic record containing normalized thread detail, its applied event sequence
and its history metadata. It never persists a cursor on its own. Writes take the latest applied
store state during a bounded idle batch, with best-effort flush on page hide and disposal. Token
events only replace a pending state reference; they do not serialize or access IndexedDB.

Records belong to the browser origin, a server instance identity verified by transport negotiation,
and the thread ID. A stored identity cannot establish a connection's authority. Stable and Beta
keep their separate browser profiles, server identities and data homes. Cache records contain
conversation content and omit connection credentials and authentication tokens.

The cache allows at most 32 detail records, 4 MB per record, 16 MB in total and seven days of age.
It retains at most 512 deletion tombstones. Write transactions compare the stored sequence before
replacing a record; delayed writes from another tab cannot replace newer detail or undo a retained
tombstone. Schema mismatch, denied storage, quota failures and oversize entries become cache
misses. Clearing browser storage also clears these records.

Restored detail can be displayed promptly, while pending approvals, questions, provider actions
and automatic queue dispatch wait for an applied authoritative snapshot or complete replay. The
opt-in batched replay includes an empty confirmation after validating the thread and cursor.
Servers that omit that confirmation trigger an authoritative snapshot fallback after two seconds.
If a paged detail stream fails after verification, queued sends wait for authoritative detail to
return. Existing user-stop/failure queue pause markers remain in the composer draft and survive
cache verification until their ordinary explicit Resume behavior clears them.

Cached running or streaming detail does not count as observed live work. If confirmation shows
that the turn already finished, it opens folded without replaying a completion animation. Once
a running turn is authoritative, its later live completion keeps the existing disclosure motion.

A genuine server process identity change discards old display detail and resume cursors atomically,
and keeps actions blocked until the new process supplies a snapshot. Old namespace records are
never hydrated for the new process and remain subject to the global storage limits.
