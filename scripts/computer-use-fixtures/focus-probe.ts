/**
 * focus-probe: standalone focus-theft meter for fixture and certification
 * runs. Wraps the focus_probe.m sampler binary (NDJSON on stdout) with the
 * analyzer from apps/desktop/src/cuaFixtures/focusProbe.ts and turns the
 * result into an assertable exit code plus a JSON report.
 *
 * Usage:
 *   bun scripts/computer-use-fixtures/focus-probe.ts --duration 30
 *   bun scripts/computer-use-fixtures/focus-probe.ts --wrap -- ./my-cert-script.sh
 *   bun scripts/computer-use-fixtures/focus-probe.ts --duration 30 \
 *     --expect-frontmost-pid 4242 --expect-key-window 9001 \
 *     --report report.json --samples-out samples.ndjson
 *
 * Exit codes: 0 theft-free, 1 usage/environment error, 2 off-baseline
 * samples detected (or coverage too thin to make the claim).
 *
 * The probe is read-only: NSWorkspace/SLPS for the frontmost pid, AX for the
 * key window and focused element, CGWindowList for the top window, and a
 * private SLSGetActiveSpace read for the Space. A null field means the
 * matching grant/symbol was unavailable; it narrows coverage, it never
 * counts as theft. Grant the *runner's* terminal/app Accessibility (and
 * Screen Recording for window titles) to measure keyWin and focused.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeFocusSamples,
  parseFocusProbeLine,
  type FocusProbeDone,
  type FocusProbeExpect,
  type FocusProbeMeta,
  type FocusProbeSample,
} from "../../apps/desktop/src/cuaFixtures/focusProbe";

const root = fileURLToPath(new URL("../../", import.meta.url));
const defaultBinary = "/private/tmp/synara-cua-implementation/focus-probe";

interface CliOptions {
  binary: string;
  durationSeconds: number | null;
  wrap: string[] | null;
  hz: number;
  settleMs: number;
  expect: FocusProbeExpect;
  strictFocus: boolean;
  minSamples: number;
  reportPath: string | null;
  samplesPath: string | null;
  label: string;
}

const usage = `focus-probe.ts --duration <seconds> | --wrap -- <command...>
  --binary <path>            sampler binary (default ${defaultBinary}; built with clang when missing)
  --duration <seconds>       sample for a fixed duration
  --wrap -- <command...>     sample until the wrapped command exits
  --hz <rate>                samples per second (default 50, binary allows 1-500)
  --settle-ms <ms>           warm-up window that seeds the baseline (default 0)
  --expect-frontmost-pid <n> pin baseline frontmost pid (e.g. the human's app)
  --expect-key-window <n>    pin baseline AX key-window CGWindowID
  --expect-top-window <n>    pin baseline top-window CGWindowID
  --expect-space <n>         pin baseline active Space id (space-ctl active-space)
  --expect-focused-pid <n>   pin baseline focused-element owner pid
  --strict-focus             count AX focused-element changes as theft
  --min-samples <n>          post-settle samples required for ok (default 10)
  --report <path>            write the JSON report (default <cwd>/focus-probe-report.json)
  --samples-out <path>       also write the raw NDJSON sample stream
  --label <text>             label recorded in the report (default "cli")`;

const fail = (message: string): never => {
  console.error(`focus-probe: ${message}\n\n${usage}`);
  process.exit(1);
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    binary: process.env.SYNARA_CUA_FOCUS_PROBE ?? defaultBinary,
    durationSeconds: null,
    wrap: null,
    hz: 50,
    settleMs: 0,
    expect: {},
    strictFocus: false,
    minSamples: 10,
    reportPath: null,
    samplesPath: null,
    label: "cli",
  };
  const integer = (name: string, value: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) fail(`${name} needs an integer, got ${value}`);
    return parsed;
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const value = () => {
      if (index + 1 >= argv.length) fail(`${argument} needs a value`);
      return argv[++index]!;
    };
    switch (argument) {
      case "--binary":
        options.binary = value();
        break;
      case "--duration":
        options.durationSeconds = Number(value());
        if (!(options.durationSeconds > 0)) fail("--duration needs a positive number");
        break;
      case "--wrap":
        if (argv[index + 1] !== "--") fail("--wrap must be followed by -- and a command");
        index += 1;
        options.wrap = argv.slice(index + 1);
        if (options.wrap.length === 0) fail("--wrap needs a command after --");
        return options;
      case "--hz":
        options.hz = Number(value());
        if (!(options.hz >= 1 && options.hz <= 500)) fail("--hz out of range (1-500)");
        break;
      case "--settle-ms":
        options.settleMs = integer("--settle-ms", value());
        break;
      case "--expect-frontmost-pid":
        options.expect.pid = integer("--expect-frontmost-pid", value());
        break;
      case "--expect-key-window":
        options.expect.keyWin = integer("--expect-key-window", value());
        break;
      case "--expect-top-window":
        options.expect.topWin = integer("--expect-top-window", value());
        break;
      case "--expect-space":
        options.expect.space = integer("--expect-space", value());
        break;
      case "--expect-focused-pid":
        options.expect.focusedPid = integer("--expect-focused-pid", value());
        break;
      case "--strict-focus":
        options.strictFocus = true;
        break;
      case "--min-samples":
        options.minSamples = integer("--min-samples", value());
        break;
      case "--report":
        options.reportPath = value();
        break;
      case "--samples-out":
        options.samplesPath = value();
        break;
      case "--label":
        options.label = value();
        break;
      case "--help":
        console.log(usage);
        process.exit(0);
      default:
        fail(`unknown argument: ${argument}`);
    }
  }
  if (!options.durationSeconds && !options.wrap) fail("pass --duration or --wrap");
  return options;
}

function ensureBinary(path: string): void {
  if (existsSync(path)) return;
  if (path !== defaultBinary)
    fail(
      `probe binary missing at ${path} (build with scripts/computer-use-fixtures/build-focus-probe.sh)`,
    );
  const source = join(root, "scripts/computer-use-fixtures/focus_probe.m");
  const built = spawnSync(
    "/usr/bin/clang",
    [
      "-fobjc-arc",
      "-O2",
      "-o",
      path,
      source,
      "-framework",
      "AppKit",
      "-framework",
      "ApplicationServices",
      "-framework",
      "CoreGraphics",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (built.status !== 0 || !existsSync(path))
    fail(`probe binary missing and clang build failed (status ${built.status ?? "spawn error"})`);
  console.error(`focus-probe: built ${path}`);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  ensureBinary(options.binary);

  const args = ["--hz", String(options.hz), "--label", options.label];
  // --duration runs are self-terminated by the sampler; --wrap holds stdin
  // open and closes it when the wrapped command exits.
  if (options.wrap) args.push("--stdin");
  else args.push("--duration", String(options.durationSeconds));
  const sampler: ChildProcessWithoutNullStreams = spawn(options.binary, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const samples: FocusProbeSample[] = [];
  const rawLines: string[] = [];
  let meta: FocusProbeMeta | null = null;
  let done: FocusProbeDone | null = null;
  let stderr = "";
  let buffer = "";
  sampler.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (options.samplesPath) rawLines.push(line);
      const parsed = parseFocusProbeLine(line);
      if (!parsed) continue;
      if (parsed.kind === "meta") meta = parsed.meta;
      else if (parsed.kind === "done") done = parsed.done;
      else samples.push(parsed.sample);
    }
  });
  sampler.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 16_384) stderr += chunk.toString("utf8");
  });
  const samplerExited = new Promise<number | null>((resolve) => {
    sampler.once("error", () => resolve(null));
    sampler.once("exit", (code) => resolve(code));
  });

  let interrupted = false;
  let wrapped: ChildProcessWithoutNullStreams | null = null;
  const onSignal = () => {
    interrupted = true;
    wrapped?.kill("SIGTERM");
    sampler.stdin.destroy();
    sampler.kill("SIGTERM");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let wrappedExit: number | null = null;
  if (options.wrap) {
    wrapped = spawn(options.wrap[0]!, options.wrap.slice(1), {
      stdio: "inherit",
      env: process.env,
    });
    wrappedExit = await new Promise<number | null>((resolve) => {
      wrapped!.once("error", () => resolve(null));
      wrapped!.once("exit", (code) => resolve(code));
    });
    sampler.stdin.end();
  }

  const killTimer = setTimeout(() => sampler.kill("SIGKILL"), 15_000);
  const samplerExit = await samplerExited;
  clearTimeout(killTimer);

  const report = analyzeFocusSamples(samples, {
    settleMs: options.settleMs,
    expect: options.expect,
    strictFocus: options.strictFocus,
    minSamples: options.minSamples,
  });

  const reportPath = options.reportPath ?? join(process.cwd(), "focus-probe-report.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        probe: "focus-probe",
        label: options.label,
        options: {
          binary: options.binary,
          hz: options.hz,
          settleMs: options.settleMs,
          expect: options.expect,
          strictFocus: options.strictFocus,
          minSamples: options.minSamples,
          wrap: options.wrap,
          durationSeconds: options.durationSeconds,
        },
        meta,
        done,
        samplerExit,
        wrappedExit,
        interrupted,
        stderr: stderr.trim() || undefined,
        report,
      },
      null,
      2,
    ) + "\n",
  );
  if (options.samplesPath) {
    await mkdir(dirname(options.samplesPath), { recursive: true });
    await writeFile(options.samplesPath, rawLines.join("\n") + (rawLines.length ? "\n" : ""));
  }

  const summary = {
    theftFree: report.theftFree,
    ok: report.ok,
    samples: report.sampleCount,
    measuredMs: Math.round(report.measuredMs),
    baseline: report.baseline,
    offBaseline: report.offBaseline.length,
    offBaselineSamples: report.offBaselineSamples,
    drift: report.driftSamples,
    uncertainSamples: report.uncertainSamples,
    coverage: report.coverage,
    issues: report.issues,
    reportPath,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (!report.theftFree) return 2;
  // An interrupted run is not a completed clean measurement even when the
  // partial samples pass the thresholds.
  if (interrupted) return 1;
  if (!report.ok) return 1;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`focus-probe: ${String(error)}`);
    process.exit(1);
  });
