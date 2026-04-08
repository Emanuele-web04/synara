// FILE: managedTerminalWrappers.ts
// Purpose: Create Superset-style managed command wrappers so terminal agent identity is canonical
// and survives zsh startup that rewrites PATH.

import fs from "node:fs";
import path from "node:path";

import {
  defaultTerminalTitleForCliKind,
  managedTerminalCommandNameForCliKind,
  T3CODE_TERMINAL_CLI_KIND_ENV_KEY,
  type TerminalCliKind,
} from "@t3tools/shared/terminalThreads";

export interface ManagedTerminalWrapperState {
  binDir: string | null;
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

function buildWrapperScript(cliKind: TerminalCliKind, targetPath: string): string {
  const commandName = managedTerminalCommandNameForCliKind(cliKind);
  const title = defaultTerminalTitleForCliKind(cliKind);
  return [
    "#!/bin/sh",
    `# Managed ${commandName} wrapper injected by t3code terminal sessions.`,
    `printf '\\033]0;%s\\007' ${shellQuote(title)}`,
    `export ${T3CODE_TERMINAL_CLI_KIND_ENV_KEY}=${shellQuote(cliKind)}`,
    `exec ${shellQuote(targetPath)} "$@"`,
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
  return `# T3 Code zsh rc wrapper
_t3code_home="\${T3CODE_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_t3code_home"
[[ -f "$_t3code_home/.zshrc" ]] && source "$_t3code_home/.zshrc"
export ZDOTDIR=${quotedZshDir}
if [ -n "\${T3CODE_MANAGED_BIN_DIR:-}" ] && [ -d "\${T3CODE_MANAGED_BIN_DIR}" ]; then
  case ":$PATH:" in
    *:\${T3CODE_MANAGED_BIN_DIR}:*) ;;
    *) export PATH="\${T3CODE_MANAGED_BIN_DIR}:$PATH" ;;
  esac
  unalias claude 2>/dev/null || true
  claude() {
    if [ -x "\${T3CODE_MANAGED_BIN_DIR}/claude" ] && [ ! -d "\${T3CODE_MANAGED_BIN_DIR}/claude" ]; then
      "\${T3CODE_MANAGED_BIN_DIR}/claude" "$@"
    else
      command claude "$@"
    fi
  }
  unalias codex 2>/dev/null || true
  codex() {
    if [ -x "\${T3CODE_MANAGED_BIN_DIR}/codex" ] && [ ! -d "\${T3CODE_MANAGED_BIN_DIR}/codex" ]; then
      "\${T3CODE_MANAGED_BIN_DIR}/codex" "$@"
    else
      command codex "$@"
    fi
  }
  typeset -ga precmd_functions 2>/dev/null || true
  _t3code_ensure_managed_bin() {
    case ":$PATH:" in
      *:\${T3CODE_MANAGED_BIN_DIR}:*) ;;
      *) PATH="\${T3CODE_MANAGED_BIN_DIR}:$PATH" ;;
    esac
  }
  {
    precmd_functions=(\${precmd_functions:#_t3code_ensure_managed_bin} _t3code_ensure_managed_bin)
  } 2>/dev/null || true
fi
`;
}

function ensureManagedZshWrappers(zshDir: string): void {
  fs.mkdirSync(zshDir, { recursive: true });
  const quotedZshDir = shellQuote(zshDir);
  writeFileIfChanged(
    path.join(zshDir, ".zshenv"),
    `# T3 Code zsh env wrapper
_t3code_home="\${T3CODE_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_t3code_home"
[[ -f "$_t3code_home/.zshenv" ]] && source "$_t3code_home/.zshenv"
export ZDOTDIR=${quotedZshDir}
`,
    0o644,
  );
  writeFileIfChanged(
    path.join(zshDir, ".zprofile"),
    `# T3 Code zsh profile wrapper
_t3code_home="\${T3CODE_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_t3code_home"
[[ -f "$_t3code_home/.zprofile" ]] && source "$_t3code_home/.zprofile"
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
    return { binDir: null, zshDir: null, targetPathByCliKind: {} };
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
    return { binDir: null, zshDir: null, targetPathByCliKind };
  }

  fs.mkdirSync(options.rootDir, { recursive: true });
  for (const [cliKind, targetPath] of Object.entries(targetPathByCliKind) as Array<
    [TerminalCliKind, string]
  >) {
    const wrapperPath = path.join(options.rootDir, managedTerminalCommandNameForCliKind(cliKind));
    writeFileIfChanged(wrapperPath, buildWrapperScript(cliKind, targetPath), 0o755);
  }
  ensureManagedZshWrappers(options.zshRootDir);

  return { binDir: options.rootDir, zshDir: options.zshRootDir, targetPathByCliKind };
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
    T3CODE_MANAGED_BIN_DIR: wrapperState.binDir,
    T3CODE_ORIGINAL_ZDOTDIR: env.ZDOTDIR ?? env.HOME ?? "",
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
