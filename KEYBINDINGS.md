# Keybindings

Synara reads keybindings from:

- `~/.synara/userdata/keybindings.json`

The file must be a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

See the full schema for more details: [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts)

## Editing in Settings

Settings → Keybindings lists every built-in command with its shortcuts and writes the same file:

- The pencil opens the recorder: press the new keys, then Save (or Enter). Escape cancels. A shortcut needs ⌘, ⌥ or ⌃ (Ctrl or Alt elsewhere) unless it is an F-key.
- Some chords cannot be taken, because something else gets the key first. The list lives in [`apps/web/src/fixedShortcuts.ts`](apps/web/src/fixedShortcuts.ts):
  - text editing: Copy, Paste, Cut, Select All, Undo, Redo, plus line and word movement and deletion;
  - the system: Quit, Hide, and Minimize on macOS;
  - Synara's own chords:
    - Settings and the keybindings sheet;
    - back and forward in the desktop app (⌘[ / ⌘] on macOS, Alt+← / Alt+→ elsewhere);
    - file search (Mod+P) and search in files (Mod+Shift+F);
    - terminal search (Mod+F, only while the terminal has focus).
- If the chord types a character on your keyboard layout (for example ⌥L types "@" on a German Mac), the recorder warns that saving stops those keys from typing it.
- When the keys already run another command in a context that can overlap, the recorder names it and saving moves the shortcut over. If it has no other shortcuts, the other command is left unassigned. Commands for two different focused surfaces, such as `composerFocus` and `terminalFocus`, never overlap, because only one surface has focus at a time.
- The plus adds another shortcut to a command, and the trash removes one. A command with none left shows as Unassigned.
- "Jump to visible thread 1–9" and "Jump to space 1–9" are each rebound as one modifier combination across the number keys. Rebind a single number in the file and the list shows the nine commands separately.
- "Reset to default" in the recorder restores one command. If another command has since taken one of its shipped keys, the recorder names it first, and resetting takes the key back. "Reset all to defaults" restores every built-in command. Project script shortcuts are kept.
- If the bindings change while the recorder is open (another window, or `keybindings.json` edited by hand), it says so and won't save. The server also rejects any edit made against bindings that are no longer there.

A new shortcut takes the `when` condition its command ships with. Edit the file to change a condition.

In the desktop app, the View menu's New Terminal Tab, Toggle Sidebar, and Toggle Browser items follow unconditional shortcuts that do not share their keys with a conditional command. Conditional shortcuts stay in the app's keyboard dispatcher so their `when` conditions are respected; those menu items have no native accelerator. Unassigned commands also have no native accelerator. Menu clicks remain available.

Shortcuts follow the character your layout types: on AZERTY, the key labelled A fires a binding on `a`. A key that types something other than a letter or digit, such as Option+S typing "ß" on macOS or Shift+1 typing "!", matches by its physical key.

## Defaults

```json
[
  { "key": "mod+b", "command": "sidebar.toggle", "when": "!terminalFocus" },
  { "key": "cmd+k", "command": "sidebar.search" },
  { "key": "ctrl+k", "command": "sidebar.search", "when": "!isMac" },
  { "key": "mod+alt+u", "command": "sidebar.activity", "when": "!terminalFocus || isMac" },
  { "key": "mod+shift+o", "command": "sidebar.addProject", "when": "!terminalFocus" },
  { "key": "mod+i", "command": "sidebar.importThread", "when": "!terminalFocus" },
  { "key": "mod+alt+arrowleft", "command": "space.previous", "when": "!terminalFocus" },
  { "key": "mod+alt+arrowright", "command": "space.next", "when": "!terminalFocus" },
  { "key": "mod+alt+1", "command": "space.jump.1", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+2", "command": "space.jump.2", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+3", "command": "space.jump.3", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+4", "command": "space.jump.4", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+5", "command": "space.jump.5", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+6", "command": "space.jump.6", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+7", "command": "space.jump.7", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+8", "command": "space.jump.8", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+9", "command": "space.jump.9", "when": "!terminalFocus || isMac" },
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+t", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+shift+j", "command": "terminal.workspace.newFullWidth" },
  { "key": "mod+w", "command": "terminal.workspace.closeActive", "when": "terminalWorkspaceOpen" },
  { "key": "ctrl+1", "command": "terminal.workspace.terminal", "when": "terminalWorkspaceOpen" },
  { "key": "ctrl+2", "command": "terminal.workspace.chat", "when": "terminalWorkspaceOpen" },
  { "key": "mod+shift+b", "command": "browser.toggle", "when": "!terminalFocus" },
  { "key": "mod+alt+s", "command": "sidechat.toggle", "when": "!terminalFocus || isMac" },
  { "key": "mod+d", "command": "diff.toggle", "when": "!terminalFocus" },
  { "key": "alt+arrowdown", "command": "diff.change.next", "when": "!terminalFocus" },
  { "key": "alt+arrowup", "command": "diff.change.previous", "when": "!terminalFocus" },
  { "key": "cmd+l", "command": "composer.focus.toggle", "when": "!terminalFocus" },
  { "key": "mod+f", "command": "chat.find", "when": "!terminalFocus" },
  { "key": "mod+p", "command": "search.files", "when": "!terminalFocus" },
  { "key": "mod+shift+f", "command": "search.content", "when": "!terminalFocus" },
  { "key": "mod+shift+m", "command": "modelPicker.toggle", "when": "!terminalFocus" },
  { "key": "alt+]", "command": "model.next", "when": "!terminalFocus" },
  { "key": "alt+[", "command": "model.previous", "when": "!terminalFocus" },
  { "key": "shift+tab", "command": "model.effort.next", "when": "composerFocus" },
  { "key": "mod+shift+e", "command": "traitsPicker.toggle", "when": "!terminalFocus" },
  { "key": "mod+shift+u", "command": "settings.usage", "when": "!terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus || isMac" },
  { "key": "mod+shift+n", "command": "chat.newLatestProject", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+n", "command": "chat.newChat", "when": "!terminalFocus || isMac" },
  { "key": "mod+shift+t", "command": "chat.newTerminal", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+c", "command": "chat.newClaude", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+x", "command": "chat.newCodex", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+r", "command": "chat.newCursor", "when": "!terminalFocus || isMac" },
  { "key": "mod+\\", "command": "chat.split", "when": "!terminalFocus || isMac" },
  { "key": "ctrl+tab", "command": "view.recent.next" },
  { "key": "ctrl+shift+tab", "command": "view.recent.previous" },
  {
    "key": "mod+1",
    "command": "thread.jump.1",
    "when": "(!terminalFocus && !terminalWorkspaceOpen) || isMac"
  },
  {
    "key": "mod+2",
    "command": "thread.jump.2",
    "when": "(!terminalFocus && !terminalWorkspaceOpen) || isMac"
  },
  {
    "key": "mod+3",
    "command": "thread.jump.3",
    "when": "(!terminalFocus && !terminalWorkspaceOpen) || isMac"
  },
  {
    "key": "mod+4",
    "command": "thread.jump.4",
    "when": "(!terminalFocus && !terminalWorkspaceOpen) || isMac"
  },
  {
    "key": "mod+5",
    "command": "thread.jump.5",
    "when": "(!terminalFocus && !terminalWorkspaceOpen) || isMac"
  },
  {
    "key": "mod+6",
    "command": "thread.jump.6",
    "when": "(!terminalFocus && !terminalWorkspaceOpen) || isMac"
  },
  {
    "key": "mod+7",
    "command": "thread.jump.7",
    "when": "(!terminalFocus && !terminalWorkspaceOpen) || isMac"
  },
  {
    "key": "mod+8",
    "command": "thread.jump.8",
    "when": "(!terminalFocus && !terminalWorkspaceOpen) || isMac"
  },
  {
    "key": "mod+9",
    "command": "thread.jump.9",
    "when": "(!terminalFocus && !terminalWorkspaceOpen) || isMac"
  },
  { "key": "mod+shift+c", "command": "thread.copyId", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+shift+a", "command": "thread.archive", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+shift+s", "command": "thread.snooze", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+shift+u", "command": "thread.markUnread", "when": "!terminalFocus || isMac" },
  { "key": "mod+shift+]", "command": "chat.visible.next", "when": "!terminalFocus" },
  { "key": "mod+shift+[", "command": "chat.visible.previous", "when": "!terminalFocus" },
  { "key": "mod+ctrl+arrowright", "command": "threadTab.next", "when": "isMac" },
  { "key": "mod+ctrl+arrowleft", "command": "threadTab.previous", "when": "isMac" },
  { "key": "ctrl+pagedown", "command": "threadTab.next", "when": "!terminalFocus && !isMac" },
  { "key": "ctrl+pageup", "command": "threadTab.previous", "when": "!terminalFocus && !isMac" },
  { "key": "meta+ctrl+p", "command": "git.commitAndPush", "when": "!terminalFocus && isMac" },
  { "key": "ctrl+alt+p", "command": "git.commitAndPush", "when": "!terminalFocus && !isMac" },
  { "key": "mod+o", "command": "editor.openFavorite" },
  { "key": "mod+s", "command": "editor.file.save", "when": "!terminalFocus" }
]
```

These rules mirror [`DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`](apps/server/src/keybindings.ts). That source is authoritative when defaults change.

At startup, the server adds defaults for commands missing from a valid config, unless their shortcut and condition already belong to another rule or the file would exceed its rule limit. It leaves malformed files and files containing invalid entries untouched. A configured command replaces all defaults for that command, including when its key is `unassigned`. Runtime snapshots can still provide missing defaults without rewriting a full file.

The web dispatcher also has [`DEFAULT_SHORTCUT_FALLBACKS`](apps/web/src/keybindings.ts) for commands with no configured binding. A custom or `unassigned` rule suppresses that command's fallback. `git.commitAndPush` now ships server defaults as well: Cmd+Ctrl+P on macOS and Ctrl+Alt+P elsewhere.

### Built-in (not configurable)

- `Esc`: stop the running turn while the Stop control is visible (composer or transcript focus; menus, dialogs, and the terminal keep their own Escape)
- `Ctrl+C` (macOS): interrupt the running turn from the composer

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored and reported as issues, and saving from Settings keeps them in the file as written. Invalid config files are ignored. Warnings are logged by the server. The file holds at most 256 rules: past that, saving from Settings is refused and nothing is dropped. Runtime snapshots reserve additional room for missing built-in defaults, so a full user file keeps every configured rule and the remaining default commands. Legacy files above 256 remain intact on disk; their newest 256 user rules are active, and edits that shrink them remain allowed.

### Unassigned Commands

A command with a default shortcut gets it back whenever the file has no rule for it. To leave such a command without a shortcut, give it the key `unassigned`:

```json
[{ "key": "unassigned", "command": "terminal.toggle" }]
```

Removing a command's last shortcut in Settings writes this rule. It never matches a key press, and adding a shortcut to the command in Settings replaces it.

### Available Commands

The command identifiers are defined by [`STATIC_KEYBINDING_COMMANDS`](packages/contracts/src/keybindings.ts). Settings labels and surface availability are described in [`shortcutsSheet.ts`](apps/web/src/shortcutsSheet.ts).

| Command                                                  | Action                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `sidebar.toggle`                                         | Show or hide the sidebar.                                                                            |
| `sidebar.search`                                         | Open the project and thread search palette.                                                          |
| `sidebar.activity`                                       | Show or hide Activity.                                                                               |
| `sidebar.addProject`                                     | Open the Create project dialog to import a local folder.                                             |
| `sidebar.importThread`                                   | Open thread import.                                                                                  |
| `space.previous`, `space.next`                           | Switch project spaces and restore the last working context.                                          |
| `space.jump.1` … `space.jump.9`                          | Select a space by its visual tab order; the first slot is Void.                                      |
| `terminal.toggle`                                        | Show or hide the active thread's terminal surface.                                                   |
| `terminal.new`                                           | Open or focus the thread's terminal panel.                                                           |
| `terminal.close`                                         | Close the thread's terminal session.                                                                 |
| `terminal.workspace.newFullWidth`                        | Open the full-width terminal workspace.                                                              |
| `terminal.workspace.closeActive`                         | Close the active workspace panel or tab.                                                             |
| `terminal.workspace.terminal`, `terminal.workspace.chat` | Select the terminal or chat workspace tab.                                                           |
| `browser.toggle`                                         | Show or hide the built-in browser panel.                                                             |
| `device.toggle`                                          | Show or hide the iOS Simulator panel when supported by a macOS server; no default binding.           |
| `diff.toggle`                                            | Show or hide the working tree diff panel.                                                            |
| `diff.change.next`, `diff.change.previous`               | Scroll an open diff panel to the next or previous changed file.                                      |
| `composer.focus.toggle`                                  | Focus or blur the chat composer.                                                                     |
| `chat.find`                                              | Find text in the current transcript.                                                                 |
| `search.files`, `search.content`                         | Open workspace file-name or snippet-content search.                                                  |
| `modelPicker.toggle`                                     | Open the provider and model picker.                                                                  |
| `model.next`, `model.previous`                           | Cycle models within the active provider, with favorites first.                                       |
| `model.effort.next`                                      | Cycle the model's available effort levels while the composer or its effort control has focus.        |
| `traitsPicker.toggle`                                    | Open the composer reasoning and trait controls.                                                      |
| `settings.usage`                                         | Open Settings → Usage.                                                                               |
| `chat.new`                                               | Start a new thread in the current project, falling back to the most recent usable project.           |
| `chat.newLatestProject`                                  | Start a new thread in the most recently used project.                                                |
| `chat.newChat`, `chat.newLocal`                          | Open the new-chat landing view; `chat.newLocal` remains a configurable alias with no server default. |
| `chat.newTerminal`                                       | Start a terminal-first thread.                                                                       |
| `chat.newClaude`, `chat.newCodex`, `chat.newCursor`      | Start a thread with the named provider selected.                                                     |
| `chat.split`                                             | Open the current conversation in a second pane.                                                      |
| `sidechat.toggle`                                        | Open or hide the active main thread's side chat.                                                     |
| `view.recent.next`, `view.recent.previous`               | Cycle recent primary views in an installed Electron or standalone PWA window.                        |
| `thread.jump.1` … `thread.jump.9`                        | Select a visible sidebar thread by its numbered position.                                            |
| `thread.copyId`                                          | Copy the active thread's ID.                                                                         |
| `thread.archive`                                         | Archive the active chat using the thread menu's confirmation and undo.                               |
| `thread.snooze`                                          | Open the existing snooze date and time picker.                                                       |
| `thread.markUnread`                                      | Mark the active chat unread and restore its dismissed notification.                                  |
| `chat.visible.next`, `chat.visible.previous`             | Cycle threads currently visible in the sidebar.                                                      |
| `threadTab.next`, `threadTab.previous`                   | Select the next or previous open thread tab.                                                         |
| `editor.openFavorite`                                    | Open the current project or worktree in the last-used editor.                                        |
| `editor.file.save`                                       | Save the focused file editor's unsaved changes.                                                      |
| `git.commitAndPush`                                      | Commit pending changes and push the active thread's repository.                                      |
| `script.{id}.run`                                        | Run a project script, for example `script.test.run`.                                                 |

The legacy identifiers `terminal.split`, `terminal.splitRight`, `terminal.splitLeft`, `terminal.splitDown`, and `terminal.splitUp` remain accepted by the schema for old files. They have no defaults, are omitted from Settings, and the dispatcher ignores them so they cannot consume terminal input.

The active-chat actions default to Mod+Alt+Shift+A (archive), Mod+Alt+Shift+S
(snooze), and Mod+Alt+Shift+U (mark unread). Mod is ⌘ on macOS and Ctrl elsewhere.
They target the focused chat pane in a split view and do nothing in an empty pane,
Settings, or while a menu or dialog is open. Terminal focus yields these chords
to the shell on Windows/Linux. Archive excludes subagent threads; snooze follows
the thread menu's availability rules and opens its existing date and time picker.
All three can be changed or unassigned in Settings → Keyboard shortcuts.

`sidechat.toggle` defaults to ⌘⌥S on macOS and Ctrl+Alt+S elsewhere. In the single-chat view, it reopens an existing side chat (or creates one using `/side`) and focuses its composer. Pressing it again hides the panel and focuses the main composer without interrupting either chat. Escape also hides a visible side chat when no menu or dialog needs dismissal; terminal input keeps Escape. The shortcut can be changed in Settings → Keyboard shortcuts.

Enter while a composer voice note is recording is not a configurable command: a plain Enter (no modifiers) finishes the recording instead of sending the typed draft. Settings → Behavior → Enter while dictating decides whether it only transcribes into the composer (the default) or also sends the message once the transcript is in.

### Key Syntax

Supported modifiers:

- `mod` (`cmd` on macOS, `ctrl` on non-macOS)
- `cmd` / `meta`
- `ctrl` / `control`
- `shift`
- `alt` / `option`

Examples:

- `mod+j`
- `mod+shift+d`
- `ctrl+l`
- `cmd+k`

### `when` Conditions

Context keys supplied by the relevant shortcut surface include:

- `terminalFocus`: a terminal has keyboard focus.
- `terminalOpen`: the terminal surface is open.
- `terminalWorkspaceOpen`: the full-width terminal workspace is open.
- `composerFocus`: the composer or its effort control has focus.
- `isMac`: the resolved platform is macOS.

`true` and `false` are also accepted. A surface that does not supply a context key treats it as false.

Supported operators:

- `!` (not)
- `&&` (and)
- `||` (or)
- parentheses: `(` `)`

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "terminalFocus || terminalOpen"`

Unknown condition keys evaluate to `false`.

### Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.
