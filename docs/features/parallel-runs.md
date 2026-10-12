# Parallel model runs

In a code project, open a chat and choose **Parallel run** in its header. Enter
one task and choose two or three provider/model attempts. Matching providers copy
the current model settings. Every attempt gets a separate conversation, provider
session and managed worktree. They all start from the same committed HEAD;
uncommitted source changes are excluded. The source access mode is frozen for the
batch. A provider/model without Auto support falls back to approval mode.

The sidebar groups these independent attempts without using the Beta Groups
coordinator feature. Open any attempt and choose **Compare attempts** to inspect
answers, status, branches and changes from the common base. **Stop all attempts**
uses the existing interrupt path. Wait for all attempts to settle before selecting
one. **Keep this attempt** archives the other conversations and preserves their
branches and files. Use the existing Worktrees settings panel for explicit removal.

**Compare in new thread** refreshes and validates settled answers, then sends the
task, answer excerpts, branch names and
worktree locations to the currently selected model in a new approval-mode chat.
It asks for a recommendation; it does not merge code. Large answers are marked as
excerpts, and the original conversations remain available for inspection. Task text,
provider answers and repository references are sent as tagged untrusted JSON; they
do not authorize tools, credential access or file changes. The budget applies to
the escaped prompt, and retries reuse the original comparison operation IDs.

The complete batch request is persisted before the first worktree is created.
An attempt retains the source conversation's working directory relative to the
repository root, including a nested package directory.

All worktrees and threads are staged before provider turns are admitted. A lost
acknowledgement can be retried with the original run id and command ids, so an
accepted prompt is not delivered a second time. The frozen request is also stored
with the group. After a partial launch and reload, **Resume launch** retries it.
A changed or dirty orphan worktree, deleted attempt, archived source/attempt, or
changed request is preserved and reported instead of being overwritten. Starting
a new run after an error preserves any attempts that were already created.

The first version supports two or three total attempts. The per-model counts of
one through five and separate per-entry effort/options requested in #1560 remain
follow-up work; this dialog copies existing composer options for matching providers.
Automatic judging and automatic branch merging remain outside this feature.

Launching from a new draft saves that source conversation before staging attempts and keeps it available for launch recovery. It does not start a provider turn on the source.
