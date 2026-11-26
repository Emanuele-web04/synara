# Cleanup after a pull request is merged

In **Settings → Worktrees**, enable **Remove archived worktrees after merge** to allow
automatic cleanup of eligible managed worktrees. This setting is off by default
and applies to the current server. Cleanup runs through the existing worktree
pruning paths, including worktree inventory refresh and conversation retention.

A worktree is eligible only when every conversation that owns it is archived,
has no active or unresolved provider work, and has a recorded pull request.
GitHub must confirm that each pull request was merged and that its head branch
and commit match the worktree's current branch and HEAD. Local ancestry alone is
not sufficient, so squash and rebase merges use the same exact-commit check.

Dirty files, detached HEADs, missing pull request data, lookup failures, live
terminals, enabled continuation automations, active provider work, and other
active owners preserve the worktree. Automatic removal, including the older
archived-thread retention path, rechecks ownership, work, settings and Git state
under the same lifecycle fence as running turns.

Ignored files are not part of the recovery snapshot unless `.worktreeinclude`
lists them, and ordinary Git worktree removal still deletes them. A worktree
with ignored files outside `.worktreeinclude` is therefore kept.

Cleanup saves a recovery snapshot for the current commit and uses ordinary Git
worktree removal without force. A snapshot or removal failure preserves the
worktree instead of treating cleanup as successful. Merge cleanup preserves the
local branch ref; recovery snapshots expire after 30 days.

This setting removes eligible worktree directories; it does not automatically
merge branches. Explicit removal remains available through the existing
Worktrees controls.
