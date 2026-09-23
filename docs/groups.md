# Groups

A group is a shared home for related work. It has **one coordinator conversation** that you talk
to, and **many threads** that do the work in parallel. Every thread in the group starts from the
same instructions and memory, and files the threads deliver land in one shared Library.

A group does not need a repository. It works just as well for research, writing, planning, or any
other non-code work.

> **Before you begin:** Groups appear under the **Groups** tab of the sidebar switcher. If you do
> not see the tab, open Settings → **Sidebar sections** and turn on **Groups** ("Show the Groups
> tab in the sidebar switcher.").

## Group or ordinary thread?

| Use an ordinary project thread when           | Use a group when                                                  |
| --------------------------------------------- | ----------------------------------------------------------------- |
| The work is one objective in one repository   | The work spans several threads, repositories, or kinds of work    |
| You want to drive a single agent turn by turn | You want one place to ask for work and get status back            |
| Instructions live in that repository          | Several threads should share the same instructions and memory     |
| Results are a diff you review in place        | Results include files (reports, bundles, charts) you want to keep |

## Create a group

1. Open the **Groups** tab in the sidebar and choose **New group**.
2. Type a **Group name** and choose **Create group**. Synara creates a folder for the group under
   `~/Documents/Synara/Groups/`.
3. The **Set up your group** dialog opens. On **General**, set the goal, the coordinator and thread
   models, and (optionally) an icon.
4. Optionally add **Group instructions** on **Memory** and link repositories on **Environment**.
5. Choose **Create group**. Setup does not launch a model.

The coordinator conversation opens with a welcome message. Until you send your first message, a
**Suggestions** row offers three shortcuts: **Connect repositories**, **Add a goal**, and **Write
instructions**. Each one opens the matching settings section.

![New group dialog](./screenshots/groups-new-group.png)

![Set up your group dialog](./screenshots/groups-onboarding.png)

In the sidebar, each group row expands to show its coordinator row first, then the group's
threads. Right-click the coordinator row and choose **Change icon…** to restyle it, or pin it so it
stays visible while the group is collapsed. A group whose coordinator is not set up shows **Set up
coordinator** instead.

## Talk to the coordinator

The coordinator directs work; threads do the work. It does not write application code itself.
Each message you send ends up in one of three places:

- **Answered in place** — quick questions, status checks, and short explanations.
- **Sent to an existing thread** — a follow-up for a thread already working in that area, instead
  of a duplicate.
- **Started as new threads** — one thread per independent task, started in parallel.

When a request could mean either "do it now" or "just suggest", the coordinator proposes a short
list of suggested threads (title, repository, one-line brief) and waits for your confirmation.
Tell it once if you always want this, and it will remember.

After it starts threads, the coordinator stays on watch. When a thread finishes, fails, hits a
quota limit, or is interrupted, the coordinator wakes up and posts a short status in its chat. If a
thread dies, it starts a new thread for the same job or picks another path.

Useful requests:

```text
How is everything going?
Run at most 3 threads at a time.
Propose threads before starting them.
Link the repository at ~/code/api to this group.
Every Monday, summarize open pull requests.
```

You can also start a thread in a group yourself: open a new chat while the group is active. It
uses the group's thread model and effort and receives the same instructions and memory.

![Coordinator conversation](./screenshots/groups-coordinator-chat.png)

## The Group panel and Overview

Open the **Group** panel from the chat header. It shows the group folder, the coordinator and its
model, a **Focus** card (a short summary of what matters now), and an overview with three tabs:

- **Threads** — every thread in the group, sorted into live states.
- **Pull requests** — PRs opened by group threads, with an **Open on GitHub** link.
- **Automations** — scheduled work that belongs to the group, with its last run.

| State                | Meaning                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| **Waiting on you**   | The thread asked for an approval or input, or its session or turn failed            |
| **Working**          | The thread is starting or actively running a turn                                   |
| **Ready for review** | The thread is not running and has an open, non-draft pull request                   |
| **Idle**             | The thread is not running and has nothing waiting                                   |
| **Resolved**         | Archived, its task is done or cancelled, or its PR was merged or closed (collapsed) |

Threads in linked repositories appear here too, labelled with their repository. Right-click a row
for **Mark resolved** (or **Reopen**) and **Open in split view**.

When any thread is **Waiting on you**, the group's sidebar row shows an amber dot ("A thread needs
you").

The panel's **Context** section shows the group's Instructions, Notes, Decisions, and Playbook
files. Instructions and Notes are editable there.

![Group panel overview](./screenshots/groups-overview.png)

## Instructions and memory

Every turn of every group thread, including threads the group runs in linked repositories,
receives a context packet with:

- The group **instructions**
- The group **goal**, if you set one
- The **MEMORY.md** index of shared group memory
- The list of **linked repositories** and the **Library** location
- The group's default thread model

Edit these in group settings → **Memory**:

- **Group instructions** — like a `CLAUDE.md`: rules every new thread reads and follows (up to
  16,000 characters).
- **Write memory notes** — notes the coordinator writes itself as it works. While this is on,
  per-thread memory files (`memory/threads/<threadId>.md`, listed under **Thread memory**) are
  also added to the packet. The MEMORY.md index is sent either way.
- **MEMORY.md** — choose **View** to read the coordinator's running memory.
- **Memory files** — every saved memory note. Type in the note box (for example, "Note that
  releases go out on Tuesdays") to add one yourself. Notes apply immediately.

**How "remember" works.** When you tell the coordinator a preference or a fact ("always use the
small model for reviews"), it saves the note as `memory/<date>-<slug>.md` and adds one line to the
`MEMORY.md` index. A near-identical note updates the existing file instead of creating a second
one. Any group thread can remember or forget notes the same way. Ask the coordinator to forget a
note when it is stale.

## The Library

The Library is a folder of files for the group, versioned as a Git repository. Every change is a
commit. Open it from the chat header (**Library**).

- **Add** uploads files. Right-click a folder for **Upload here**.
- Search, filter by type (**All**, **Documents**, **Images**, **Code**, **Other**), and switch
  between **List** and **Grid**.
- Right-click an entry to **Rename**, **Delete**, or see its **History**.
- **History** lists every version. Choose **Restore** to bring back an earlier version or a
  deleted file.

Threads deliver files to the Library themselves: when a thread produces something worth keeping,
the coordinator asks it to add the file, then links the Library path in its reply. A thread can
only add files from its own workspace.

To back up the Library, set a **Git remote** in settings → **Environment** → **Library hosting**
and turn on **Push on change**. Pushes happen in the background and never block a write. The
Library shows **Pushed**, **Not pushed yet**, or **Push failed**. Pushes are non-interactive, so
the remote must already work with your saved SSH key or Git credentials.

![Library panel](./screenshots/groups-library.png)

## Linked repositories

Link an existing Synara project to let the coordinator start threads in it. Use **Add repository**
in settings → **Environment**, or ask the coordinator to link it. Only you can unlink a repository
(**Remove**). Linking and unlinking apply immediately.

The coordinator can start threads only in the group folder or in a linked repository. It uses the
group folder for non-code work such as notes, research, and planning.

## Lifecycle

These controls live at the bottom of settings → **General**.

| Action            | What happens                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Pause**         | Interrupts running threads and stops new coordinator wakes and group automations. **Resume** restores them       |
| **Restart**       | Stops and restarts the coordinator's session. The transcript is kept. Not available while paused or archived     |
| **Archive**       | Archives every thread in the group folder and hides the group. Find it under **Archived groups** → **Unarchive** |
| **Delete group…** | Type the group name to confirm. Deletes the group, its coordinator, context, and automations                     |

When you delete a group:

- Linked repositories and their threads are untouched.
- The default Library folder is moved to the trash when possible.
- A Library folder you chose yourself is never moved or deleted; Synara tells you where it was left.

**Continue as a group.** Right-click an ordinary thread and choose **Continue as a group**. Synara
creates a new group named after the thread, links the thread's project, and opens group setup. The
coordinator is then asked to read the thread and continue its work. **Move to group…** does the
same for an existing group.

**Hand off.** Group threads can hand off to another provider, and the new thread stays in the
group. Workspace hand off (to a new worktree or to local) is not available for group threads. The
coordinator cannot be handed off.

## Settings reference

Open settings from the gear in the Group panel (**Group settings**).

| Section         | Settings                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **General**     | Name, Icon, Goal; coordinator Appearance (icon and color); Coordinator model and effort; Thread model and effort; Lifecycle       |
| **Memory**      | Group instructions; Write memory notes; MEMORY.md; Memory files; Thread memory                                                    |
| **Environment** | Linked repositories; Group folder; Worker environment (Local or Worktree); Library hosting (Location, Git remote, Push on change) |
| **Plugins**     | Plugins discovered from the group's folder                                                                                        |

## Where data lives on disk

| Data                            | Location                                                             |
| ------------------------------- | -------------------------------------------------------------------- |
| Group folder                    | `~/Documents/Synara/Groups/<group-name>/`                            |
| Instructions, memory, decisions | `~/.synara/userdata/project-context/<project-id>/` (Markdown mirror) |
| Library (default)               | `~/.synara/userdata/project-context/<project-id>/library/`           |
| Library (custom)                | The folder you chose in **Library hosting** → **Location**           |

Synara's database is the source of truth; the Markdown files are a mirror. `~/.synara` moves if you
set `SYNARA_HOME`. Deleting a group does not remove the group folder under `Documents`.

## Limits and troubleshooting

- A group runs at most 8 threads at once and starts at most 8 new threads per coordinator turn.
- The context packet is capped at 32,000 characters and is truncated past that.
- A single Library add is limited to 256 MB. The MEMORY.md index keeps the newest 256 entries.
- Group name: 160 characters. Goal: 8,000. Instructions: 16,000.
- Library remotes must be `https://`, `ssh://`, or `git@host:path`.
- **No Groups tab** — turn on Settings → **Sidebar sections** → **Groups**.
- **Restart is greyed out** — resume or unarchive the group first.
- **Push failed** — hover the pill to see the error; failed pushes retry with a growing delay up to
  10 minutes.
- **A paused or archived group is missing from Move to group…** — only active groups are listed.

## How Groups compare to Claude Code and Cursor Projects

Groups follow the same idea as Claude Code
[Projects](https://code.claude.com/docs/en/claude-projects) and Cursor Projects: one place that
holds shared instructions, memory, and files for related work. Synara adds a coordinator that starts
and watches threads for you, a live overview of every thread and PR, and a Git-versioned Library.
Threads can use any provider Synara supports, and a group can span several repositories or none.
