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

Every enabled Codex and Claude Code account (provider instance) is scanned with the same home and
environment it runs with. Conversations from a non-default account show the account name, and an
imported copy is created in, and continues with, the account it was found in. Accounts that share one
history store list each conversation once, under the default account. A disabled non-default
account is not scanned.

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
next import creates a new independent copy. An interrupted import reuses its copy and the saved initial display page in the destination chosen
for the first attempt. Pending imports cannot accept new messages until the native copy, initial
page, and runtime cleanup finish successfully.

Native copies preserve provider conversation context independently of the messages displayed in
Synara. Import does not force compaction or replace native context with a summary. Initially, Codex
imports display up to ten recent turn summaries (the user message and final assistant reply), and
Claude imports display up to twenty recent text messages from the SDK-selected conversation chain.
Original timestamps are retained where available; older pages stay ordered before newer messages.

Choose **Load earlier messages** at the top of an imported transcript to read previous pages.
Ordinary Synara chats do not request imported history. If the server is temporarily busy, history
loading retries automatically with backoff and keeps messages already on screen. These are
read-only display history: loading them does not send a model turn, add messages to the live session,
or change its activity time. They do not expose actions that require a Synara message, such as pinning
or forking, and are not added to Synara's searchable message store. Reopening a chat starts with its recent messages again; fetched pages are cached durably
and reused on retry, including after a server restart. Unfetched pages require the original import
account's storage location and the native copy to remain available. Existing fully imported chats
are unchanged. Interrupted imports from before paginated history finish their original full
transcript: the already saved messages stay intact, and missing messages are read in bounded
provider pages and saved for retry before being appended. This compatibility recovery gathers
the remaining display history before completing, so unusually large legacy imports can still
require more memory than new imports.

Codex must support `thread/turns/list` with lightweight item views. Older incompatible CLI versions
are reported with an upgrade instruction instead of falling back to an unbounded full-history read.
Each display page is bounded to 1 MiB, below the transport envelope limit. A single oversized display
message or unavailable native history produces an explicit error; Synara never silently truncates
native context or treats a failed initial import as complete.

Historical tool activity, reasoning, plans, and attachments are not reconstructed as interactive UI
items. Subagent transcripts are not listed as separate ordinary conversations. Active Codex turns
must finish or be stopped before importing. Claude conversations need a settled assistant response
without unfinished tool interactions; unsupported boundaries are reported individually.

The single-conversation **Import thread** action remains available separately.
