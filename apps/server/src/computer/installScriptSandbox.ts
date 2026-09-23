/**
 * A sealed environment for running the plugins' installer scripts in tests.
 *
 * The scripts talk to a live compositor, a session bus and a compiler, and on
 * a developer's machine all three are real: an installer test that reached
 * the real `busctl`, `hyprctl` or `kwin_wayland` would act on the desktop the
 * developer is sitting at. So the PATH here holds nothing but an allowlist of
 * plain tools (linked from the system) and the stubs a test writes, HOME and
 * the XDG roots are fresh temp directories, and no bus or display variable is
 * passed through. A command the test did not stub and the allowlist does not
 * name is simply not there.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Plain tools the installers use; nothing that talks to a desktop or a compiler. */
const ALLOWED_TOOLS = [
  "awk",
  "basename",
  "bash",
  "cat",
  "chmod",
  "cp",
  "date",
  "dirname",
  "env",
  "find",
  "flock",
  "grep",
  "head",
  "id",
  "install",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "readlink",
  "rm",
  "sed",
  "sh",
  "sleep",
  "sort",
  "sha256sum",
  "stat",
  "tail",
  "touch",
  "tr",
] as const;

const SYSTEM_BIN_DIRECTORIES = ["/usr/bin", "/bin"] as const;

function systemTool(name: string): string {
  for (const directory of SYSTEM_BIN_DIRECTORIES) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`installScriptSandbox: ${name} is not installed on this host`);
}

export interface ScriptRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface InstallScriptSandbox {
  readonly root: string;
  readonly home: string;
  /** Where stubs append one line per invocation (`<name> <args>`). */
  readonly callLog: string;
  /** Scratch directory stubs may keep state in (`$STUB_STATE`). */
  readonly stubState: string;
  /** Writes a stub command; `body` runs under bash with `$STUB_STATE` and `$STUB_LOG` set. */
  stub(name: string, body: string): Promise<void>;
  /** Every stub invocation so far, oldest first. */
  calls(): Promise<readonly string[]>;
  /** Runs `script` under bash with core dumps off and only the sandbox environment. */
  run(script: string, args: readonly string[], env?: Record<string, string>): ScriptRun;
  dispose(): Promise<void>;
}

export async function createInstallScriptSandbox(): Promise<InstallScriptSandbox> {
  const root = await mkdtemp(join(tmpdir(), "synara-install-script-"));
  const home = join(root, "home");
  const tools = join(root, "tools");
  const stubs = join(root, "stubs");
  const stubState = join(root, "stub-state");
  const callLog = join(root, "calls.log");
  await Promise.all([home, tools, stubs, stubState].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(callLog, "");
  await Promise.all(ALLOWED_TOOLS.map((name) => symlink(systemTool(name), join(tools, name))));
  const bash = systemTool("bash");

  const baseEnv: Record<string, string> = {
    PATH: `${stubs}:${tools}`,
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    LANG: "C",
    STUB_STATE: stubState,
    STUB_LOG: callLog,
  };

  return {
    root,
    home,
    callLog,
    stubState,
    async stub(name, body) {
      const path = join(stubs, name);
      await writeFile(
        path,
        `#!${bash}\nset -euo pipefail\nprintf '%s\\n' "${name} $*" >>"$STUB_LOG"\n${body}\n`,
      );
      await chmod(path, 0o755);
    },
    async calls() {
      return (await readFile(callLog, "utf8")).split("\n").filter(Boolean);
    },
    run(script, args, env = {}) {
      const result = spawnSync(bash, ["-c", 'ulimit -c 0; exec bash "$0" "$@"', script, ...args], {
        env: { ...baseEnv, ...env },
        encoding: "utf8",
        timeout: 60_000,
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
