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

- The pencil opens the recorder: press the new keys, then Save (or Enter). Escape cancels. A shortcut needs ⌘, ⌥ or ⌃ (Ctrl or Alt elsewhere) unless it is an F-key, and the chords for Copy, Paste, Cut, Select All, Undo, Redo, Settings, the keybindings sheet, and (on macOS) Quit, Hide, and Minimize cannot be taken.
- When the keys already run another command in a context that can overlap, the recorder names it and saving moves the shortcut over. If it has no other shortcuts, the other command is left unassigned.
- The plus adds another shortcut to a command, and the trash removes one. A command with none left shows as Unassigned.
- "Jump to visible thread 1–9" and "Jump to space 1–9" are each rebound as one modifier combination across the number keys. Rebind a single number in the file and the list shows the nine commands separately.
- "Reset to default" in the recorder restores one command, and "Reset all to defaults" restores every built-in command. Project script shortcuts are kept.

A new shortcut takes the `when` condition its command ships with. Edit the file to change a condition.

Desktop menu accelerators are currently fixed: for example, removing or moving Toggle sidebar does not disable the menu’s Cmd+B accelerator. The recorder suspends web shortcut dispatch; native menu accelerators are not customized by this editor.

## Defaults

```json
[
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+n", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+o", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+n", "command": "chat.newLocal", "when": "!terminalFocus" },
  { "key": "mod+shift+t", "command": "chat.newTerminal", "when": "!terminalFocus" },
  { "key": "mod+alt+s", "command": "sidechat.toggle", "when": "!terminalFocus || isMac" },
  { "key": "cmd+l", "command": "composer.focus.toggle", "when": "!terminalFocus" },
  { "key": "alt+arrowdown", "command": "diff.change.next", "when": "!terminalFocus" },
  { "key": "alt+arrowup", "command": "diff.change.previous", "when": "!terminalFocus" },
  { "key": "mod+o", "command": "editor.openFavorite" },
  { "key": "mod+s", "command": "editor.file.save", "when": "!terminalFocus" }
]
```

For most up to date defaults, see [`DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`](apps/server/src/keybindings.ts)

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Unassigned Commands

A command with a default shortcut gets it back whenever the file has no rule for it. To leave such a command without a shortcut, give it the key `unassigned`:

```json
[{ "key": "unassigned", "command": "terminal.toggle" }]
```

Removing a command's last shortcut in Settings writes this rule. It never matches a key press, and adding a shortcut to the command in Settings replaces it.

### Available Commands

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)
- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `chat.newTerminal`: create a new terminal-first thread preserving the active thread's branch/worktree state
- `diff.change.next`: scroll the diff panel to the next changed file (only while the diff panel is open)
- `diff.change.previous`: scroll the diff panel to the previous changed file (only while the diff panel is open)
- `sidechat.toggle`: open or hide the active main thread's side chat panel
- `composer.focus.toggle`: focus or blur the chat prompt composer
- `thread.copyId`: copy the active thread's ID to the clipboard
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `editor.file.save`: write the focused file editor's unsaved changes back to disk (editor view file and diff editors)
- `script.{id}.run`: run a project script by id (for example `script.test.run`)

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

Currently available context keys:

- `terminalFocus`
- `terminalOpen`

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
