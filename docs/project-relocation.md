# Reconnect a moved or restored project

When a drive is disconnected or a project folder has moved, do not import a second project to recover the existing conversation.

Right-click the existing project in the sidebar, select **Change project path…**, and enter the restored folder's path **on the machine running Synara's server**. The destination must already exist. The old directory does not need to be available. Confirm that this is a restored copy of the same project, not an unrelated folder.

The update preserves the existing project, thread IDs, messages, and conversation history. Explicit working directories beneath the old project root are relocated in the same orchestration event batch. The provider is restarted at the new working directory when needed; its saved resume cursor is retained rather than discarded by a normal session-stop command. Native resumption still depends on the provider's retained session data; existing transcript bootstrap is used where supported.

Save or discard pending editor changes and finish active turns/checkpoint restores first. Stop development servers and close terminals still running in the old folder. Background provider tasks must finish or be stopped before the next turn can restart at the new path. This action does not move files, recover a corrupted disk, or repair Git worktree metadata. Linked worktrees inside the old folder are rejected; externally located worktrees and explicit directories outside the old root are left unchanged and may need separate relocation/repair.

A thread blocked by an earlier ambiguous provider failure is not automatically unblocked: changing a folder must not silently abandon or replay an earlier command. Use the thread's existing **Unblock** action after reviewing that failure. Restart Synara after upgrading if an old process failure is still held in memory.

For maintainers: a Node child with no PID is treated as safely absent only when the shared spawn boundary actually observed its spawn error. Unknown PID-less handles still fail closed, and normal process-tree exit proof remains unchanged. Verify packaged macOS/Windows behavior and live provider-native resume before release; mocked provider tests are not a live-session guarantee.
