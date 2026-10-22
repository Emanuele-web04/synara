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
terminals, enabled continuation automations, and other active owners preserve the
worktree. Cleanup rechecks ownership, work, settings and Git state before removal.
It saves a recovery snapshot for the current commit and uses ordinary Git
worktree removal without force. A snapshot or removal failure preserves the
worktree instead of treating cleanup as successful.

This setting removes eligible worktree directories; it does not automatically
merge branches or delete branches. Explicit removal remains available through
the existing Worktrees controls.
