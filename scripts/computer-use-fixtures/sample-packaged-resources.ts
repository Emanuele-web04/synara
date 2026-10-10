/** Read-only macOS sampler. Run alongside the sequential packaged workload. */
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { parseArgs } from "node:util";
import { spawnProcessSync } from "@synara/shared/processRuntime";
import {
  makeResourceTracker,
  parseResourceSnapshot,
  resourceIdentity,
  resourceSamplingOptions,
  type ResourceProcess,
} from "./resource-sampling.ts";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PROCESSES_PER_SAMPLE = 512;
const MAX_IDENTITIES = 4_096;
const SAMPLE_COLUMNS = "pid=,ppid=,lstart=,rss=,%cpu=,time=,comm=";

function readCommand(command: string, args: string[]): string {
  const result = spawnProcessSync(command, args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 8 * 1024 * 1024,
    timeout: 1_000,
  });
  if (result.error || result.status !== 0) throw new Error("Bounded resource discovery failed.");
  return result.stdout;
}

function readSnapshot(): ResourceProcess[] {
  // comm excludes argument vectors, unlike command/args or pgrep -f.
  return parseResourceSnapshot(readCommand("/bin/ps", ["-ww", "-axo", SAMPLE_COLUMNS]));
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function role(row: ResourceProcess, rootPid: number, bundle: string): string {
  if (row.pid === rootPid) return "app-main";
  const name = basename(row.executable).toLowerCase();
  if (/^(?:cua-driver|appsnap|app-snap)$/.test(name)) return "native-helper";
  if (/^(?:codex|claude|cursor-agent|agent|opencode|agy|grok|droid|devin|pi)$/.test(name)) {
    return "provider";
  }
  if (
    /^(?:google chrome|chromium|firefox|safari|microsoft edge|brave browser|dia|arc)(?: helper.*)?$/.test(
      name,
    )
  ) {
    return "browser";
  }
  return within(bundle, row.executable) ? "app-helper" : "other-descendant";
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      bundle: { type: "string" },
      pid: { type: "string" },
      seconds: { type: "string" },
      "interval-ms": { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  if (process.platform !== "darwin") throw new Error("Packaged resource sampling requires macOS.");
  if (!values.bundle || !isAbsolute(values.bundle) || !values.bundle.endsWith(".app")) {
    throw new Error("Use the exact absolute application bundle path.");
  }
  if (!values.out || !isAbsolute(values.out))
    throw new Error("Use an explicit absolute output path.");
  const options = resourceSamplingOptions({
    pid: values.pid,
    seconds: values.seconds,
    intervalMs: values["interval-ms"],
  });
  const bundle = await realpath(values.bundle);
  const executableName = readCommand("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleExecutable",
    join(bundle, "Contents/Info.plist"),
  ]).trim();
  if (
    !executableName ||
    executableName !== basename(executableName) ||
    /[\r\n]/.test(executableName)
  ) {
    throw new Error("The selected bundle has an invalid executable name.");
  }
  const executable = await realpath(join(bundle, "Contents/MacOS", executableName));
  if (!within(bundle, executable) || !(await stat(executable)).isFile()) {
    throw new Error("The selected executable must be inside its bundle.");
  }
  const initialRows = readSnapshot();
  const root = initialRows.find((row) => row.pid === options.rootPid);
  if (!root || root.executable !== executable) {
    throw new Error("Root PID does not match the exact bundle executable.");
  }
  const select = makeResourceTracker(root);
  if (select(initialRows).processes.some((row) => row.pid === process.pid)) {
    throw new Error("Run the resource sampler outside the selected application's process tree.");
  }
  const output = await open(values.out, "wx", 0o600);
  let bytes = 0;
  const write = async (value: unknown) => {
    const line = `${JSON.stringify(value)}\n`;
    bytes += Buffer.byteLength(line, "utf8");
    if (bytes > MAX_OUTPUT_BYTES) throw new Error("Resource report exceeded its output bound.");
    await output.writeFile(line);
  };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let stopRequested = false;
  const stop = () => {
    stopRequested = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let reason = "duration-complete";
  let samples = 0;
  let peakTreeRssKiB = 0;
  let observedCpuSeconds = 0;
  let counterRegressions = 0;
  let samplingError = false;
  let rootReplaced = false;
  const previousCpu = new Map<string, number>();
  try {
    await write({
      type: "metadata",
      version: 1,
      startedAt,
      bundle,
      rootStartedAt: root.startedAt,
      ...options,
      units: {
        rssKiB: "1024-byte units",
        cpuPercent: "OS process %CPU estimate",
        lifetimeCpuSeconds: "cumulative process CPU seconds",
      },
      limits: [
        "RSS includes shared pages and is not unique memory, a leak diagnosis or incremental overhead.",
        "CPU percentage is the OS estimate; sums may exceed 100%. No battery or savings claim is made.",
        "Observed CPU seconds sum same-identity lifetime-counter deltas between samples, not complete workload CPU.",
        "Short-lived processes and descendants reparented before first observation may be missed; unrelated browser instances are excluded.",
        "PID plus lstart rejects observed PID reuse; lstart has one-second precision and ps snapshots are not atomic.",
        "Roles are executable-name hints; generic runtimes remain other-descendant. No argv, environment, windows or account data is collected.",
      ],
      bounds: {
        outputBytes: MAX_OUTPUT_BYTES,
        processesPerSample: MAX_PROCESSES_PER_SAMPLE,
        identities: MAX_IDENTITIES,
      },
    });
    let rows = initialRows;
    while (performance.now() - started <= options.durationMs && !stopRequested) {
      const snapshot = select(rows);
      rootReplaced ||= snapshot.rootState === "replaced";
      if (snapshot.processes.length > MAX_PROCESSES_PER_SAMPLE) {
        reason = "process-count-limit";
        break;
      }
      const processes = snapshot.processes.map((row) => ({
        ...row,
        executable: basename(row.executable),
        role: role(row, root.pid, bundle),
      }));
      const identities = new Set([...previousCpu.keys(), ...processes.map(resourceIdentity)]);
      if (identities.size > MAX_IDENTITIES) {
        reason = "identity-count-limit";
        break;
      }
      const treeRssKiB = processes.reduce((sum, row) => sum + row.rssKiB, 0);
      const row = {
        type: "sample",
        capturedAt: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        rootState: snapshot.rootState,
        processes,
        totals: {
          rssKiB: treeRssKiB,
          cpuPercent: processes.reduce((sum, process) => sum + process.cpuPercent, 0),
        },
      };
      if (bytes + Buffer.byteLength(JSON.stringify(row), "utf8") + 4_096 > MAX_OUTPUT_BYTES) {
        reason = "output-size-limit";
        break;
      }
      await write(row);
      for (const process of processes) {
        const identity = resourceIdentity(process);
        const previous = previousCpu.get(identity);
        if (previous !== undefined) {
          if (process.lifetimeCpuSeconds < previous) counterRegressions += 1;
          else observedCpuSeconds += process.lifetimeCpuSeconds - previous;
        }
        previousCpu.set(identity, process.lifetimeCpuSeconds);
      }
      samples += 1;
      if (samples === 1)
        console.info(`Resource sampler ready for PID ${root.pid}; output: ${values.out}`);
      peakTreeRssKiB = Math.max(peakTreeRssKiB, treeRssKiB);
      if (processes.length === 0) {
        reason = "observed-tree-ended";
        break;
      }
      const remaining = options.durationMs - (performance.now() - started);
      if (remaining <= 0) break;
      await pause(Math.min(options.intervalMs, remaining));
      if (stopRequested || performance.now() - started > options.durationMs) break;
      rows = readSnapshot();
    }
  } catch {
    samplingError = true;
    reason = "sampling-failed";
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (stopRequested) reason = "interrupted";
    const complete =
      !samplingError &&
      !rootReplaced &&
      counterRegressions === 0 &&
      samples > 0 &&
      (reason === "duration-complete" || reason === "observed-tree-ended");
    try {
      await write({
        type: "summary",
        complete,
        reason,
        samples,
        elapsedMs: performance.now() - started,
        peakTreeRssKiB,
        observedCpuSeconds,
        identities: previousCpu.size,
        counterRegressions,
        rootReplaced,
      });
    } finally {
      await output.close();
    }
    if (!complete) process.exitCode = 2;
    console.info(`Resource sampling ${complete ? "completed" : "incomplete"}: ${samples} samples.`);
  }
}

void main().catch((error: unknown) => {
  // Argument-parser/system errors may embed arbitrary argument values. Keep
  // only our own fixed messages; never print the raw discovery command/output.
  console.error(
    error instanceof Error && !("code" in error)
      ? error.message
      : "Resource sampling setup failed; check arguments, selected bundle/PID and new output path.",
  );
  process.exitCode = 1;
});
