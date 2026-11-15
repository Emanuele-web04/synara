// Process-tree memory, CPU, wake-ups and GPU readings from macOS tools that need no sudo.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyProcess, processTree, screenLocked } from "./launch.mjs";
import { sleep } from "./cdp.mjs";

/**
 * Physical footprint per process in MB (the figure Activity Monitor shows as "Memory"),
 * read with `footprint`. Falls back to RSS when a process cannot be inspected.
 */
export function footprintMb(pids) {
  const result = new Map();
  if (pids.length === 0) return result;
  const directory = mkdtempSync(join(tmpdir(), "synara-bench-footprint-"));
  const file = join(directory, "footprint.json");
  try {
    spawnSync("footprint", ["-j", file, ...pids.flatMap((pid) => ["-p", String(pid)])], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const report = JSON.parse(readFileSync(file, "utf8"));
    for (const entry of report.processes ?? []) {
      const bytes = entry.footprint ?? entry.phys_footprint ?? entry.auxiliary?.phys_footprint;
      if (typeof entry.pid === "number" && typeof bytes === "number")
        result.set(entry.pid, bytes / 1024 / 1024);
    }
  } catch {
    // Left empty: the caller records RSS and marks the footprint as unavailable.
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return result;
}

/** One memory snapshot of the app's whole process tree, grouped by process role. */
export function memorySnapshot(app) {
  const backendPid = app.backendState()?.pid;
  const tree = processTree(app.pid);
  const footprints = footprintMb(tree.map((row) => row.pid));
  const processes = tree.map((row) => ({
    pid: row.pid,
    role: classifyProcess(row, { rootPid: app.pid, backendPid }),
    footprintMb: footprints.has(row.pid) ? Math.round(footprints.get(row.pid) * 10) / 10 : null,
    rssMb: Math.round((row.rssKb / 1024) * 10) / 10,
  }));
  const byRole = {};
  for (const entry of processes) {
    const value = entry.footprintMb ?? entry.rssMb;
    byRole[entry.role] = Math.round(((byRole[entry.role] ?? 0) + value) * 10) / 10;
  }
  const isApp = (role) => !role.startsWith("provider:") && role !== "other";
  const sum = (filter) =>
    Math.round(
      processes
        .filter((entry) => filter(entry.role))
        .reduce((total, entry) => total + (entry.footprintMb ?? entry.rssMb), 0) * 10,
    ) / 10;
  return {
    totalMb: sum(() => true),
    appMb: sum(isApp),
    processCount: processes.length,
    appProcessCount: processes.filter((entry) => isApp(entry.role)).length,
    footprintAvailable: processes.every((entry) => entry.footprintMb !== null),
    byRole,
    processes,
  };
}

/** Fast total (RSS based) for sampling a peak once a second without `footprint`'s cost. */
export function rssTotalMb(app) {
  return (
    Math.round((processTree(app.pid).reduce((total, row) => total + row.rssKb, 0) / 1024) * 10) / 10
  );
}

function cpuByRole(app) {
  const backendPid = app.backendState()?.pid;
  const totals = {};
  const pids = new Map();
  for (const row of processTree(app.pid)) {
    const role = classifyProcess(row, { rootPid: app.pid, backendPid });
    totals[role] = (totals[role] ?? 0) + row.cpuSeconds;
    pids.set(row.pid, { role, cpuSeconds: row.cpuSeconds });
  }
  return { totals, pids };
}

/**
 * CPU use over a window as percent of one core, from cumulative CPU time of every
 * process in the tree. Processes that start or exit inside the window are counted
 * for the time they were seen.
 */
export async function cpuOverWindow(app, seconds) {
  const before = cpuByRole(app);
  const startedAt = performance.now();
  await sleep(seconds * 1000);
  const elapsed = (performance.now() - startedAt) / 1000;
  const after = cpuByRole(app);
  const byRole = {};
  let total = 0;
  for (const [pid, entry] of after.pids) {
    const delta = Math.max(0, entry.cpuSeconds - (before.pids.get(pid)?.cpuSeconds ?? 0));
    byRole[entry.role] = (byRole[entry.role] ?? 0) + delta;
    total += delta;
  }
  const percent = (value) => Math.round((value / elapsed) * 100 * 1000) / 1000;
  const isApp = (role) => !role.startsWith("provider:") && role !== "other";
  return {
    seconds: Math.round(elapsed * 10) / 10,
    totalPercent: percent(total),
    appPercent: percent(
      Object.entries(byRole)
        .filter(([role]) => isApp(role))
        .reduce((sum, [, value]) => sum + value, 0),
    ),
    byRolePercent: Object.fromEntries(
      Object.entries(byRole).map(([role, value]) => [role, percent(value)]),
    ),
  };
}

/**
 * Idle wake-ups per second for the tree over a window. top's IDLEW column counts
 * wake-ups since each process started, so this is the difference between the two
 * samples `top -l 2` prints, per process, divided by the interval.
 */
export function wakeupsOverWindow(app, seconds) {
  const backendPid = app.backendState()?.pid;
  const tree = processTree(app.pid);
  const roles = new Map(
    tree.map((row) => [row.pid, classifyProcess(row, { rootPid: app.pid, backendPid })]),
  );
  return new Promise((resolve) => {
    const child = spawn(
      "top",
      [
        "-l",
        "2",
        "-s",
        String(seconds),
        "-stats",
        "pid,idlew,power",
        ...tree.flatMap((row) => ["-pid", String(row.pid)]),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("close", () => {
      const samples = output
        .split(/^PID\s+IDLEW\s+POWER\s*$/m)
        .slice(1)
        .map((block) => {
          const counts = new Map();
          for (const line of block.split("\n")) {
            const match = line.trim().match(/^(\d+)\s+(\d+)\+?\s+([\d.]+)/);
            if (match)
              counts.set(Number(match[1]), { wakeups: Number(match[2]), power: Number(match[3]) });
          }
          return counts;
        });
      if (samples.length < 2) return resolve(null);
      const [first, second] = samples;
      const byRole = {};
      let total = 0;
      let power = 0;
      let processes = 0;
      for (const [pid, after] of second) {
        const before = first.get(pid);
        if (!before) continue;
        const delta = Math.max(0, after.wakeups - before.wakeups);
        const role = roles.get(pid) ?? "other";
        byRole[role] = (byRole[role] ?? 0) + delta;
        total += delta;
        power += after.power;
        processes += 1;
      }
      const rate = (count) => Math.round((count / seconds) * 10) / 10;
      resolve(
        processes === 0
          ? null
          : {
              wakeupsPerSecond: rate(total),
              byRolePerSecond: Object.fromEntries(
                Object.entries(byRole).map(([role, count]) => [role, rate(count)]),
              ),
              powerScore: Math.round(power * 100) / 100,
              processes,
            },
      );
    });
    child.on("error", () => resolve(null));
  });
}

/**
 * System-wide GPU readings from the IOAccelerator registry entry (no sudo needed).
 * This is the whole machine, not one app: compare it with the reading taken before launch.
 */
export function gpuSystemSample() {
  const output =
    spawnSync("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], { encoding: "utf8" })
      .stdout ?? "";
  const number = (key) => {
    const match = output.match(new RegExp(`"${key}"=(\\d+)`));
    return match ? Number(match[1]) : null;
  };
  return {
    deviceUtilizationPercent: number("Device Utilization %"),
    rendererUtilizationPercent: number("Renderer Utilization %"),
    inUseSystemMemoryMb:
      number("In use system memory") === null
        ? null
        : Math.round(number("In use system memory") / 1024 / 1024),
  };
}

/** Samples system GPU utilization once a second for a window and returns every reading. */
export async function gpuSystemOverWindow(seconds) {
  const samples = [];
  for (let index = 0; index < seconds; index += 1) {
    const sample = gpuSystemSample();
    if (sample.deviceUtilizationPercent !== null) samples.push(sample.deviceUtilizationPercent);
    await sleep(1000);
  }
  return samples;
}

export function machineState() {
  const run = (command, args) =>
    spawnSync(command, args, { encoding: "utf8" }).stdout?.trim() ?? "";
  const load = run("sysctl", ["-n", "vm.loadavg"]);
  const power = run("pmset", ["-g", "batt"]).split("\n")[0] ?? "";
  const pressure =
    run("memory_pressure", ["-Q"])
      .split("\n")
      .find((line) => line.includes("free percentage")) ?? "";
  const others = run("pgrep", ["-fl", "Synara"])
    .split("\n")
    .filter((line) => /\/Applications\/Synara( Beta)?\.app\/Contents\/MacOS\//.test(line)).length;
  const idle = run("ioreg", ["-c", "IOHIDSystem", "-d", "4"]).match(/"HIDIdleTime" = (\d+)/);
  return {
    at: new Date().toISOString(),
    secondsSinceUserInput: idle ? Math.round(Number(idle[1]) / 1e9) : null,
    screenLocked: screenLocked(),
    loadAverage: load,
    power,
    memoryFree: pressure.trim(),
    installedSynaraRunning: others > 0,
  };
}

export function machineIdentity() {
  const run = (command, args) =>
    spawnSync(command, args, { encoding: "utf8" }).stdout?.trim() ?? "";
  const display = run("system_profiler", ["SPDisplaysDataType"])
    .split("\n")
    .filter((line) => /Resolution|Chipset Model|Refresh|UI Looks like/.test(line))
    .map((line) => line.trim());
  return {
    chip: run("sysctl", ["-n", "machdep.cpu.brand_string"]),
    cores: Number(run("sysctl", ["-n", "hw.ncpu"])),
    memoryGb: Math.round(Number(run("sysctl", ["-n", "hw.memsize"])) / 1024 ** 3),
    macos: run("sw_vers", ["-productVersion"]),
    display,
  };
}
