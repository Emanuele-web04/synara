# Import projects from Codex and Claude Code

Open the command palette and choose **Import projects from…**, then pick Claude Code, Codex, or
both; the dialog opens with that source preselected. You can also choose **Import projects** while
adding your first project in the welcome tour, or click the import banner at the top of an empty
chat. Hover the banner and press its **×** to remove it for good. Existing installations also get a
dismissible introduction card in the sidebar.

1. Select Codex, Claude Code, or both, then choose **Find projects**.
2. Select projects or expand a project to choose individual conversations. Enable **Include
   archived** to include archived Codex conversations; they remain archived in Synara.
3. Review the destination folders and choose **Import selected**. The result lists failures
   individually. **Retry failed** retries those items; **Stop after current** preserves completed work.

Discovery reads local archives on the machine running the Synara server. A browser connected to a
remote server sees that server's archives. Codex's configured home and `CODEX_SQLITE_HOME`, and
Claude Code's `CLAUDE_CONFIG_DIR`, are respected. Cloud-only conversations are outside this flow.

## Projects use their existing folders

Importing links the original project folder. It does not clone a repository, copy project files, or
create a new working tree. Codex and Claude conversations associated with the same canonical folder
are grouped into one Synara project. Existing Synara projects retain their names, settings, and
conversations. Equal names or Git remotes alone do not establish that folders are the same project.

Existing Git worktrees retain their task working directories. Codex projects with multiple roots
are presented as separate destination folders. A missing folder does not prevent importing history;
select its new location in the preview when available. Link a usable project folder before resuming
work whose original directory is missing.

## Conversations become independent copies

Synara creates a provider-native copy during import. Continuing it does not append messages to the
original conversation. The code files still belong to the original linked folder or its existing
worktree. Import does not submit a model turn, and a copied Codex goal is not automatically resumed.

The importer checks native IDs already owned by Synara and saves durable import provenance. Repeating
an import skips completed copies that still exist, including archived conversations. Deleting an
imported conversation or its destination project makes the source available to import again; the
next import creates a new independent copy. An interrupted import can reuse its copy and continue materializing
history in the destination chosen for the first attempt. Pending imports cannot accept new messages
until they finish successfully.

Native copies preserve provider conversation context. Synara's imported history currently displays
supported user and assistant text, with original timestamps where available and stable ordering.
Historical tool activity, reasoning, plans, and attachments are not reconstructed as interactive UI
items. Subagent transcripts are not listed as separate ordinary conversations. Active Codex turns
must finish or be stopped before importing. Claude conversations need a settled assistant response
without unfinished tool interactions; unsupported boundaries are reported individually.

The single-conversation **Import thread** action remains available separately.
