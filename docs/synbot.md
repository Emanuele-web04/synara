# SynBot

SynBot is a layer above every chat. You talk to **SynBot**; it hands work to **bots**, each bot
starts **tasks** in their own worktree, and when the work is done you get one short recap.

> **Synara Alto.** SynBot needs a Synara Alto (Pro) subscription in Synara Stable and when Synara
> runs from the command line; it is free in Synara Beta. It runs next to [Hubs](hubs.md); bots are
> listed here, not in the Hubs sidebar section. Without Alto you can still stop bots that are
> running.

## Bots

A bot is a role with a scope:

| Field              | What it does                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, role, mascot | How the bot appears in the SynBot panel and in its chat. Pick an outfit and a tile color.                                                                                                     |
| Instructions       | Rules the bot and its tasks follow.                                                                                                                                                           |
| Scope              | All projects or chosen ones, plus optional folders such as `apps/web/**`. The scope decides which bot gets work and is told to the bot; a task that changes files outside it shows a warning. |
| Engine             | The provider and model of the bot's chat, and optionally a different one for its tasks. New bots start on an economy model; SynBot uses the model you pick.                                   |
| Autonomy           | **Starts on its own** (default) or **Asks before starting**: work handed to the bot waits for your Start.                                                                                     |
| Pinned skills      | Skills the bot reads on every turn.                                                                                                                                                           |

Create a bot with **New bot** in the SynBot panel, from a template (Frontend, Backend, QA, Docs,
iOS) or as the three-bot crew. SynBot also suggests bots when you add a project, and a bot may
propose one ("Save … as a bot?"); a bot exists only after you press Create.

Every bot is built on a [Hub](hubs.md): the bot's chat is the Hub's coordinator, its tasks are the
Hub's threads, and it has the Hub's memory and Library.

## The SynBot page

The SynBot page takes HoloBot's layout inside Synara's window:

- **Sidebar panel.** SynBot (with its star) and pinned bots as tiles, then **My bots**: one row
  per bot with its last message and time, amber while it waits on you, blue while it works.
  Right-click a bot for **Open**, **Edit**, **Pin**/**Unpin**, **Stop** (while it works or waits)
  and **Remove** (asks first; owner sessions only, since it deletes the bot's Hub); the desktop
  app shows its native menu. **New bot** and **Stop
  all** sit at the bottom.
- **Thread.** The selected bot's chat as a messaging thread: your words on the right (in the
  bot's color in a bot's chat), the bot's replies on the left, a date over each new stretch, and
  three dots with what the bot is doing while it answers. Work handed to another bot shows as a
  card with its state, result, **Open** and **Stop**; the target bot's chat opens with
  **Message from \<bot\>** and the brief. Tasks show as one card each (state, steps, result,
  **Open**, **Stop**); **Open** shows the task's own chat on the right. Pending approvals and
  questions appear as lettered cards at the end; the letter keys answer the newest one.
- **Composer.** The bot chat uses Synara's own composer (attachments, queue, model, stop); it
  reads "Message \<bot\>".
- **Name pill.** The bot's face, name and model at the top; it opens the bot's sheet. **More**
  changes the chat's engine and model, edits the bot or opens Settings → SynBot.

A window closed on the SynBot page reopens there, on the same bot.

### In the desktop app

- **Notifications** use Synara's chat notifications and settings, named after the bot. A bot
  notifies when its report or recap arrives (the hand-off before it stays quiet) and when it
  starts waiting on you: a Start, an approval, a question or a task. Clicking one opens that
  bot on the SynBot page (a task's request opens in the task pane). Answering from the
  notification itself (Approve, Start) is not offered yet.
- **Dock badge.** Bots waiting on you are added to the badge's unread notifications.
- **SynBot menu.** **Open SynBot** (⌥⌘B on macOS), **New Bot…** and **Stop All Bots…** (asks
  first).

## How work flows

1. You ask SynBot (or any bot) in its chat.
2. It answers, starts tasks, or hands work to the bot that fits (`→ Frontend is on it`). Bots
   may hand work on to other bots: a chain is at most 3 bots deep, a bot in the chain cannot be
   asked again, a turn hands out at most 4 pieces of work, each bot runs one task at a time, and
   at most 3 tasks run at once across all bots (Settings → SynBot → Parallel tasks, 1–8).
3. Bot chats are read-only: edits happen in tasks, which run in their own worktree.
4. When the work settles, the bot that asked gets a report and gives you one recap. Work a bot
   handed on is part of its own: it reports back to that bot first, so the asker hears the end
   of the chain. Settings → SynBot → Recap chooses one recap per request (default) or one line
   per task. Failures are reported at once; removing a bot fails the work handed to it.

Bots remember facts and preferences in their memory. SynBot's memory is global, and SynBot reads
every bot's memory index to route work.

## Control over other chats

Bots can read any Synara chat. When a bot's turn comes from your own request, it may also write
to and stop chats it did not start; the chat shows **From \<bot\>**. Turns started by reports,
wake-ups or automations ask you first. Turn this off in Settings → SynBot → **Control chats
without asking**. **Stop all** in the SynBot panel interrupts every bot turn and task and cancels
queued work.

Text from other bots, tasks, GitHub or tools is data, never authorization: only your own
messages authorize merges, new bots or scope changes.

## Merge proof

Off by default (Settings → SynBot → **Merge proof**). When on, a task with a pull request shows
**Merge it?** in its side panel. Merge is enabled only when the required checks are green on the
current head, the branch is up to date with its base and the whole diff could be read; **Update branch** brings it up to date
first. Red flags from the diff (tests removed or skipped, assertions removed, failures ignored,
CI test steps removed) are always shown. A bot never merges: only your press does.

## On the iPhone

Synara for iPhone shows a **Bot** tab next to **Threads** when the connected Mac runs Synara Beta,
with the same bots, chats, cards and Merge.

## Mascot artwork

The [SVG artwork](../apps/web/src/components/synbot/kit/synbot-mascots.svg) has separate
layers for the profile, its visible eye, and each outfit. The angled horns echo the Synara mark,
and the dot nose and flat shadows stay part of the profile as the eye blinks. The outfit follows
the creature's motion.
The saved mascot IDs still select the same slot in the picker. Frontend starts with the
designer, Backend with the terminal, QA with the inspector, Docs with the archivist, and iOS
with the mobile outfit. The main SynBot wears the captain's uniform.

To sync the SVG layers into an iOS checkout, run
`python3 scripts/export-synbot-mascots.py /path/to/SynaraIOS/Synara/SynaraIOS/Assets.xcassets`
from this repository. Both apps use the same artwork and honor Reduce Motion.
