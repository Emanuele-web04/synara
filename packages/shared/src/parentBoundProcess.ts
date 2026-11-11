// Owns a quiet helper process whose stdin is a kernel-backed parent lifetime lease.
import type { ChildProcess } from "node:child_process";
import { prepareProcess } from "./platformProcess";
import { resolveWindowsSystemExecutable } from "./platformEnvironment";
import { spawnProcess } from "./processRuntime";

// Static source also works in packaged Electron's Node mode without another
// build entrypoint. Credentials stay in the environment, never the source/argv.
const guardianSource = String.raw`
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const config = JSON.parse(process.argv[1]);
const env = { ...process.env };
if (config.electronRunAsNode === null) delete env.ELECTRON_RUN_AS_NODE;
else env.ELECTRON_RUN_AS_NODE = config.electronRunAsNode;
let child;
let stopping = false;
let forceTimer;
let treeKillPending = false;
let treeKillFailed = false;
let exitCode;
const ownsProcessGroup = process.platform !== "win32";
// Parent death closes stdout as well as the lease. An acknowledgement is only
// useful to a living parent and must never crash this cleanup owner.
process.stdout.on("error", () => {});
function finish(code) {
  exitCode = code;
  if (treeKillPending) return;
  // A shell override can exit before its foreground connector. Its isolated
  // group remains ours until empty, including after the direct child exits.
  if (groupIsAlive()) {
    stop();
    setTimeout(() => finish(code), 25);
    return;
  }
  stopping = true;
  clearTimeout(forceTimer);
  process.stdin.destroy();
  process.exitCode = code;
  if (!treeKillFailed) process.stdout.end("stopped\n");
}
function groupIsAlive() {
  if (!ownsProcessGroup || !child || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    if (process.platform !== "linux") return true;
    // Container PID 1 may leave dead adopted children unreaped. Zombies are
    // not live connectors and must not keep the guardian polling forever.
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      let stat;
      try { stat = fs.readFileSync("/proc/" + name + "/stat", "utf8"); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === child.pid && fields[0] !== "Z" && fields[0] !== "X") return true;
    }
    return false;
  }
  catch (error) {
    // Darwin can transiently refuse inspection while a dying group's leader
    // is reaped; Linux may hide /proc entries. Only ESRCH proves absence.
    // Otherwise retain ownership and escalation, even if inspection is denied.
    return error.code !== "ESRCH";
  }
}
function signalChild(signal) {
  if (ownsProcessGroup) {
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if (error.code !== "ESRCH" && error.code !== "EPERM") treeKillFailed = true;
    }
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
}
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child || child.pid === undefined) return;
  if (!ownsProcessGroup && (child.exitCode !== null || child.signalCode !== null)) return;
  if (config.treeKillCommand) {
    // A configured .cmd shim owns descendants: kill its tree while its exact
    // child handle is still live, rather than killing cmd.exe alone.
    treeKillPending = true;
    execFile(config.treeKillCommand, ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true, timeout: 1500,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot },
    }, error => {
      treeKillPending = false;
      treeKillFailed = Boolean(error);
      if (exitCode !== undefined) finish(exitCode);
    });
  } else {
    signalChild("SIGTERM");
  }
  forceTimer = setTimeout(() => {
    signalChild("SIGKILL");
  }, 1500);
  forceTimer.unref();
}
// The backend need not run any finalizers: a fatal error or SIGKILL closes this
// pipe. Slow work on the backend's event loop does not expire the lease.
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.on("error", stop);
process.stdin.resume();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
if (!stopping) {
  child = spawn(config.plan.command, config.plan.args, {
    cwd: config.cwd,
    env,
    shell: false,
    detached: ownsProcessGroup,
    windowsHide: config.plan.windowsHide,
    windowsVerbatimArguments: config.plan.windowsVerbatimArguments,
    stdio: "ignore",
  });
  child.on("error", () => {
    if (child.pid === undefined) finish(1);
  });
  child.once("exit", code => finish(code === 0 ? 0 : 1));
}
`;

/**
 * Runs a background native executable behind a lifetime guardian. Used for the
 * cloudflared leaf process, which does not monitor stdin itself. The returned
 * stop closes that lease and requires the guardian's child-exit acknowledgement.
 * Never send competing kill timers to the guardian: killing it before its child
 * exits loses the only owner of a child that started after a process snapshot.
 */
export function spawnParentBoundProcess(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): { readonly child: ChildProcess; readonly stop: () => Promise<void> } {
  const plan = prepareProcess(command, args, options);
  const child = spawnProcess(
    process.execPath,
    [
      "--eval",
      guardianSource,
      JSON.stringify({
        plan,
        cwd: options.cwd,
        electronRunAsNode: options.env.ELECTRON_RUN_AS_NODE ?? null,
        treeKillCommand:
          process.platform === "win32" && plan.command !== plan.resolvedCommand
            ? resolveWindowsSystemExecutable(["System32", "taskkill.exe"], options.env)
            : null,
      }),
    ],
    {
      cwd: options.cwd,
      env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  // The handle is held open, never written. EOF is the only lifetime signal.
  child.stdin?.on("error", () => child.stdin?.destroy());
  let acknowledgement = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    // Only the static guardian writes this pipe; native output is ignored.
    if (acknowledgement.length < 16) acknowledgement += chunk.toString();
  });
  let failedToSpawn = false;
  child.on("error", () => {
    failedToSpawn = child.pid === undefined;
  });
  // close follows exit and drains stdout, so an exit cannot race its receipt.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stoppingPromise: Promise<void> | undefined;
  return {
    child,
    stop: () => {
      stoppingPromise ??= (async () => {
        child.stdin?.end();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closed,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("Connector guardian did not confirm child exit")),
                10_000,
              );
            }),
          ]);
          if (!failedToSpawn && acknowledgement !== "stopped\n") {
            throw new Error("Connector guardian exited without confirming child exit");
          }
        } finally {
          clearTimeout(timer);
        }
      })();
      return stoppingPromise;
    },
  };
}
