// FILE: managedTerminalWrappers.ts
// Purpose: Create Superset-style managed command wrappers so terminal agent identity is canonical
// and survives zsh startup that rewrites PATH.

import fs from "node:fs";
import path from "node:path";

import {
  defaultTerminalTitleForCliKind,
  managedTerminalCommandNameForCliKind,
  SYNARA_TERMINAL_HOOK_OSC_PREFIX,
  SYNARA_TERMINAL_CLI_KIND_ENV_KEY,
  type TerminalAgentHookEventType,
  type TerminalCliKind,
} from "@synara/shared/terminalThreads";

export interface ManagedTerminalWrapperState {
  binDir: string | null;
  codexHomeDir: string | null;
  hookScriptPath: string | null;
  claudeSettingsPath: string | null;
  zshDir: string | null;
  targetPathByCliKind: Partial<Record<TerminalCliKind, string>>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function envPathKeyFor(env: NodeJS.ProcessEnv): "PATH" | "Path" | "path" {
  if ("PATH" in env) return "PATH";
  if ("Path" in env) return "Path";
  return "path";
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableCandidates(commandName: string): string[] {
  if (process.platform !== "win32") {
    return [commandName];
  }

  const pathExt = process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT"];
  const lowerCommandName = commandName.toLowerCase();
  const hasExtension = pathExt.some((extension) =>
    lowerCommandName.endsWith(extension.toLowerCase()),
  );
  return hasExtension ? [commandName] : pathExt.map((extension) => `${commandName}${extension}`);
}

function resolveExecutableOnPath(commandName: string, env: NodeJS.ProcessEnv): string | null {
  const envPathKey = envPathKeyFor(env);
  const envPath = env[envPathKey]?.trim();
  if (!envPath) {
    return null;
  }

  for (const entry of envPath.split(path.delimiter)) {
    const directory = entry.trim();
    if (!directory) {
      continue;
    }
    for (const candidateName of executableCandidates(commandName)) {
      const candidatePath = path.join(directory, candidateName);
      if (isExecutableFile(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return null;
}

function buildHookOscSequence(eventType: TerminalAgentHookEventType): string {
  return `\\033]${SYNARA_TERMINAL_HOOK_OSC_PREFIX}${eventType}\\007`;
}

function buildNotifyHookScript(): string {
  return `#!/bin/sh
set -eu
if [ "$#" -gt 0 ]; then
  _synara_hook_input="$1"
else
  _synara_hook_input="$(cat)"
fi

_synara_extract_event() {
  printf '%s' "$_synara_hook_input" | sed -n "s/.*\\\"$1\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p" | head -n 1
}

_synara_event="$(_synara_extract_event hook_event_name)"
if [ -z "$_synara_event" ]; then
  _synara_type="$(_synara_extract_event type)"
  case "$_synara_type" in
    task_started|userPromptSubmitted|user_prompt_submit)
      _synara_event="Start"
      ;;
    task_complete|agent-turn-complete|stop|session_end|sessionEnd)
      _synara_event="Stop"
      ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      _synara_event="PermissionRequest"
      ;;
  esac
fi

_synara_emit_osc() {
  _synara_sequence="$1"
  if [ -w /dev/tty ]; then
    printf '%b' "$_synara_sequence" > /dev/tty 2>/dev/null || printf '%b' "$_synara_sequence"
    return
  fi
  printf '%b' "$_synara_sequence"
}

case "$_synara_event" in
  UserPromptSubmit|PostToolUse|PostToolUseFailure|Start)
    _synara_emit_osc '${buildHookOscSequence("Start")}'
    ;;
  Stop)
    _synara_emit_osc '${buildHookOscSequence("Stop")}'
    ;;
  PermissionRequest|PreToolUse|Notification)
    _synara_emit_osc '${buildHookOscSequence("PermissionRequest")}'
    ;;
esac
`;
}

function buildClaudeSettingsJson(notifyHookPath: string): string {
  const command = notifyHookPath;
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
        Stop: [{ hooks: [{ type: "command", command }] }],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        Notification: [{ matcher: "*", hooks: [{ type: "command", command }] }],
      },
    },
    null,
    2,
  );
}

function buildCodexHooksJson(notifyHookPath: string): string {
  const command = notifyHookPath;
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
        Stop: [{ hooks: [{ type: "command", command }] }],
      },
    },
    null,
    2,
  );
}

function buildCodexWrapperScript(input: {
  codexHomeDir: string;
  notifyHookPath: string;
  targetPath: string;
}): string {
  const { codexHomeDir, notifyHookPath, targetPath } = input;
  return [
    `export CODEX_HOME=${shellQuote(codexHomeDir)}`,
    `if [ -f ${shellQuote(notifyHookPath)} ]; then`,
    "  export CODEX_TUI_RECORD_SESSION=1",
    '  if [ -z "${CODEX_TUI_SESSION_LOG_PATH:-}" ]; then',
    '    _synara_codex_ts="$(date +%s 2>/dev/null || echo "$$")"',
    '    export CODEX_TUI_SESSION_LOG_PATH="${TMPDIR:-/tmp}/synara-codex-session-$$_${_synara_codex_ts}.jsonl"',
    "  fi",
    "  (",
    '    _synara_log="$CODEX_TUI_SESSION_LOG_PATH"',
    `    _synara_notify=${shellQuote(notifyHookPath)}`,
    '    _synara_last_turn_id=""',
    '    _synara_last_approval_id=""',
    '    _synara_last_exec_call_id=""',
    "    _synara_approval_fallback_seq=0",
    "",
    "    _synara_emit_event() {",
    '      _synara_event="$1"',
    `      _synara_payload=$(printf '{"hook_event_name":"%s"}' "$_synara_event")`,
    '      "$_synara_notify" "$_synara_payload" >/dev/null 2>&1 || true',
    "    }",
    "",
    "    _synara_i=0",
    '    while [ ! -f "$_synara_log" ] && [ "$_synara_i" -lt 200 ]; do',
    "      _synara_i=$((_synara_i + 1))",
    "      sleep 0.05",
    "    done",
    '    if [ ! -f "$_synara_log" ]; then',
    "      exit 0",
    "    fi",
    "",
    '    tail -n 0 -F "$_synara_log" 2>/dev/null | while IFS= read -r _synara_line; do',
    '      case "$_synara_line" in',
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"task_started"'*)`,
    `          _synara_turn_id=$(printf '%s\n' "$_synara_line" | awk -F'"turn_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          [ -n "$_synara_turn_id" ] || _synara_turn_id="task_started"',
    '          if [ "$_synara_turn_id" != "$_synara_last_turn_id" ]; then',
    '            _synara_last_turn_id="$_synara_turn_id"',
    '            _synara_emit_event "Start"',
    "          fi",
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"'*'_approval_request"'*)`,
    `          _synara_approval_id=$(printf '%s\n' "$_synara_line" | awk -F'"id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          [ -n "$_synara_approval_id" ] || _synara_approval_id=$(printf '%s\n' "$_synara_line" | awk -F'"approval_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          [ -n "$_synara_approval_id" ] || _synara_approval_id=$(printf '%s\n' "$_synara_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          if [ -z "$_synara_approval_id" ]; then',
    "            _synara_approval_fallback_seq=$((_synara_approval_fallback_seq + 1))",
    '            _synara_approval_id="approval_request_${_synara_approval_fallback_seq}"',
    "          fi",
    '          if [ "$_synara_approval_id" != "$_synara_last_approval_id" ]; then',
    '            _synara_last_approval_id="$_synara_approval_id"',
    '            _synara_emit_event "PermissionRequest"',
    "          fi",
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"exec_command_begin"'*)`,
    `          _synara_exec_call_id=$(printf '%s\n' "$_synara_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          if [ -n "$_synara_exec_call_id" ]; then',
    '            if [ "$_synara_exec_call_id" != "$_synara_last_exec_call_id" ]; then',
    '              _synara_last_exec_call_id="$_synara_exec_call_id"',
    '              _synara_emit_event "Start"',
    "            fi",
    "          else",
    '            _synara_emit_event "Start"',
    "          fi",
    "          ;;",
    "      esac",
    "    done",
    "  ) &",
    "  SYNARA_CODEX_START_WATCHER_PID=$!",
    "fi",
    `${shellQuote(targetPath)} --enable codex_hooks -c ${shellQuote(`notify=["bash",${JSON.stringify(notifyHookPath)}]`)} "$@"`,
    "_synara_status=$?",
    'if [ -n "${SYNARA_CODEX_START_WATCHER_PID:-}" ]; then',
    '  kill "$SYNARA_CODEX_START_WATCHER_PID" >/dev/null 2>&1 || true',
    '  wait "$SYNARA_CODEX_START_WATCHER_PID" 2>/dev/null || true',
    "fi",
    'exit "$_synara_status"',
  ].join("\n");
}

function buildWrapperScript(input: {
  claudeSettingsPath: string;
  cliKind: TerminalCliKind;
  codexHomeDir: string;
  notifyHookPath: string;
  targetPath: string;
}): string {
  const { claudeSettingsPath, cliKind, codexHomeDir, notifyHookPath, targetPath } = input;
  const commandName = managedTerminalCommandNameForCliKind(cliKind);
  const title = defaultTerminalTitleForCliKind(cliKind);
  const commandBody =
    cliKind === "claude"
      ? `exec ${shellQuote(targetPath)} --settings ${shellQuote(claudeSettingsPath)} "$@"`
      : buildCodexWrapperScript({ codexHomeDir, notifyHookPath, targetPath });
  return [
    "#!/bin/sh",
    `# Managed ${commandName} wrapper injected by synara terminal sessions.`,
    `printf '\\033]0;%s\\007' ${shellQuote(title)}`,
    `export ${SYNARA_TERMINAL_CLI_KIND_ENV_KEY}=${shellQuote(cliKind)}`,
    commandBody,
    "",
  ].join("\n");
}

function writeFileIfChanged(filePath: string, content: string, mode: number): void {
  const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (currentContent !== content) {
    fs.writeFileSync(filePath, content, { mode });
  }
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best effort.
  }
}

function buildManagedZshRc(quotedZshDir: string): string {
  return `# Synara zsh rc wrapper
_synara_home="\${SYNARA_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_synara_home"
[[ -f "$_synara_home/.zshrc" ]] && source "$_synara_home/.zshrc"
export ZDOTDIR=${quotedZshDir}
if [ -n "\${SYNARA_MANAGED_BIN_DIR:-}" ] && [ -d "\${SYNARA_MANAGED_BIN_DIR}" ]; then
  case ":$PATH:" in
    *:\${SYNARA_MANAGED_BIN_DIR}:*) ;;
    *) export PATH="\${SYNARA_MANAGED_BIN_DIR}:$PATH" ;;
  esac
  unalias claude 2>/dev/null || true
  claude() {
    if [ -x "\${SYNARA_MANAGED_BIN_DIR}/claude" ] && [ ! -d "\${SYNARA_MANAGED_BIN_DIR}/claude" ]; then
      "\${SYNARA_MANAGED_BIN_DIR}/claude" "$@"
    else
      command claude "$@"
    fi
  }
  unalias codex 2>/dev/null || true
  codex() {
    if [ -x "\${SYNARA_MANAGED_BIN_DIR}/codex" ] && [ ! -d "\${SYNARA_MANAGED_BIN_DIR}/codex" ]; then
      "\${SYNARA_MANAGED_BIN_DIR}/codex" "$@"
    else
      command codex "$@"
    fi
  }
  typeset -ga precmd_functions 2>/dev/null || true
  _synara_ensure_managed_bin() {
    case ":$PATH:" in
      *:\${SYNARA_MANAGED_BIN_DIR}:*) ;;
      *) PATH="\${SYNARA_MANAGED_BIN_DIR}:$PATH" ;;
    esac
  }
  {
    precmd_functions=(\${precmd_functions:#_synara_ensure_managed_bin} _synara_ensure_managed_bin)
  } 2>/dev/null || true
fi
`;
}

function ensureManagedZshWrappers(zshDir: string): void {
  fs.mkdirSync(zshDir, { recursive: true });
  const quotedZshDir = shellQuote(zshDir);
  writeFileIfChanged(
    path.join(zshDir, ".zshenv"),
    `# Synara zsh env wrapper
_synara_home="\${SYNARA_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_synara_home"
[[ -f "$_synara_home/.zshenv" ]] && source "$_synara_home/.zshenv"
export ZDOTDIR=${quotedZshDir}
`,
    0o644,
  );
  writeFileIfChanged(
    path.join(zshDir, ".zprofile"),
    `# Synara zsh profile wrapper
_synara_home="\${SYNARA_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_synara_home"
[[ -f "$_synara_home/.zprofile" ]] && source "$_synara_home/.zprofile"
export ZDOTDIR=${quotedZshDir}
`,
    0o644,
  );
  writeFileIfChanged(path.join(zshDir, ".zshrc"), buildManagedZshRc(quotedZshDir), 0o644);
}

export function prepareManagedTerminalWrappers(options: {
  baseEnv: NodeJS.ProcessEnv;
  rootDir: string;
  zshRootDir: string;
}): ManagedTerminalWrapperState {
  if (process.platform === "win32") {
    return {
      binDir: null,
      codexHomeDir: null,
      hookScriptPath: null,
      claudeSettingsPath: null,
      zshDir: null,
      targetPathByCliKind: {},
    };
  }

  const targetPathByCliKind: Partial<Record<TerminalCliKind, string>> = {};
  for (const cliKind of ["codex", "claude"] as const) {
    const commandName = managedTerminalCommandNameForCliKind(cliKind);
    const targetPath = resolveExecutableOnPath(commandName, options.baseEnv);
    if (!targetPath) {
      continue;
    }
    targetPathByCliKind[cliKind] = targetPath;
  }

  if (Object.keys(targetPathByCliKind).length === 0) {
    return {
      binDir: null,
      codexHomeDir: null,
      hookScriptPath: null,
      claudeSettingsPath: null,
      zshDir: null,
      targetPathByCliKind,
    };
  }

  fs.mkdirSync(options.rootDir, { recursive: true });
  const codexHomeDir = path.join(options.rootDir, "codex-home");
  const hookScriptPath = path.join(options.rootDir, "notify-hook.sh");
  const claudeSettingsPath = path.join(options.rootDir, "claude-settings.json");
  fs.mkdirSync(codexHomeDir, { recursive: true });
  writeFileIfChanged(hookScriptPath, buildNotifyHookScript(), 0o755);
  writeFileIfChanged(claudeSettingsPath, buildClaudeSettingsJson(hookScriptPath), 0o644);
  writeFileIfChanged(
    path.join(codexHomeDir, "hooks.json"),
    buildCodexHooksJson(hookScriptPath),
    0o644,
  );
  for (const [cliKind, targetPath] of Object.entries(targetPathByCliKind) as Array<
    [TerminalCliKind, string]
  >) {
    const wrapperPath = path.join(options.rootDir, managedTerminalCommandNameForCliKind(cliKind));
    writeFileIfChanged(
      wrapperPath,
      buildWrapperScript({
        claudeSettingsPath,
        cliKind,
        codexHomeDir,
        notifyHookPath: hookScriptPath,
        targetPath,
      }),
      0o755,
    );
  }
  ensureManagedZshWrappers(options.zshRootDir);

  return {
    binDir: options.rootDir,
    codexHomeDir,
    hookScriptPath,
    claudeSettingsPath,
    zshDir: options.zshRootDir,
    targetPathByCliKind,
  };
}

function applyManagedTerminalWrapperEnvState(
  env: NodeJS.ProcessEnv,
  wrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  if (!wrapperState.binDir) {
    return env;
  }

  const envPathKey = envPathKeyFor(env);
  const currentPath = env[envPathKey]?.trim() ?? "";
  const currentEntries = currentPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!currentEntries.includes(wrapperState.binDir)) {
    currentEntries.unshift(wrapperState.binDir);
  }

  return {
    ...env,
    SYNARA_MANAGED_BIN_DIR: wrapperState.binDir,
    SYNARA_ORIGINAL_ZDOTDIR: env.ZDOTDIR ?? env.HOME ?? "",
    ...(wrapperState.zshDir ? { ZDOTDIR: wrapperState.zshDir } : {}),
    [envPathKey]: currentEntries.join(path.delimiter),
  };
}

export function applyManagedTerminalAgentWrapperEnv(
  env: NodeJS.ProcessEnv,
  wrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  return applyManagedTerminalWrapperEnvState(env, wrapperState);
}

export function prepareManagedTerminalAgentWrappers(options: {
  baseEnv: NodeJS.ProcessEnv;
  targetDir: string;
  zshDir: string;
}): ManagedTerminalWrapperState {
  return prepareManagedTerminalWrappers({
    baseEnv: options.baseEnv,
    rootDir: options.targetDir,
    zshRootDir: options.zshDir,
  });
}

export function prependManagedTerminalAgentWrapperPath(
  env: NodeJS.ProcessEnv,
  managedWrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  return applyManagedTerminalWrapperEnvState(env, managedWrapperState);
}
