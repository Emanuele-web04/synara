/**
 * multi-display-cert: second-display certification harness for Computer use.
 *
 * Runs the display matrix described in docs/computer-use-cua/multi-display-cert.md
 * against the real backend path (CuaComputerBackend over a CuaDriverHost socket)
 * on a Mac with two or more displays. On a single-display machine it refuses
 * gracefully — prints exactly what the matrix needs and exits 3 — so the script
 * is safe to ship and run anywhere.
 *
 * Usage:
 *   bun scripts/computer-use-fixtures/multi-display-cert.ts \
 *       [--driver <cua-driver path>] \
 *       [--endpoint <host.sock> --capability <token>] \
 *       [--targets fixture|textedit] [--interactive] \
 *       [--report <path>] [--keep-targets] \
 *       [--display-ctl <path>] [--focus-probe <path>|--no-focus-probe]
 *
 * Exit codes: 0 every applicable rung passed; 1 harness/environment error;
 * 2 one or more rungs failed or the environment refused; 3 refused — the
 * machine does not have the displays this certification measures.
 *
 * Driver host: either attach to an already-trusted external host
 * (--endpoint/--capability, or SYNARA_CUA_CERT_ENDPOINT /
 * SYNARA_CUA_CERT_CAPABILITY — the same pattern the canary uses), or pass
 * --driver and this script spawns CuaDriverHost itself. Run it from a terminal
 * whose process ancestry already holds the TCC grants (the external trusted
 * host pattern in belief-canary-runbook.md); the spawned driver inherits that
 * trust, which is the point of the exercise.
 *
 * Targets: `fixture` builds and spawns scripts/computer-use-fixtures/
 * NativeFixture.swift — one process per display, each contributing one window
 * with a counter button (click landing is independently observable in-process)
 * and a labelled text field (set_value read-back). `textedit` drives real
 * TextEdit instances instead: same placement and write path, weaker landing
 * evidence (no in-process counter), recorded honestly.
 */
import {
  spawn,
  spawnSync,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import type { ComputerRect, ComputerUiNode } from "@synara/contracts";
import { cuaRequest, type CuaReply, type CuaToolResult } from "@synara/shared/cuaDriverProtocol";
import release from "../../packages/shared/src/cuaDriverRelease.json" with { type: "json" };
import { CuaDriverHost } from "../../apps/desktop/src/cuaDriverHost";
import {
  CuaComputerBackend,
  CuaActionError,
} from "../../apps/server/src/computer/CuaComputerBackend";
import type { ComputerBackendActionResult } from "../../apps/server/src/computer/ComputerBackend";
import { startFocusProbe } from "../../apps/desktop/src/cuaFixtures/focusProbe";

const root = fileURLToPath(new URL("../../", import.meta.url));
const implementationDir = "/private/tmp/synara-cua-implementation";
const defaultDisplayCtl = join(implementationDir, "display-ctl");
const defaultFocusProbe = join(implementationDir, "focus-probe");
const defaultFixture = join(implementationDir, "native-fixture");
const defaultDriver = join(root, "apps/desktop/resources/cua-driver/cua-driver");

// ── CLI ──────────────────────────────────────────────────────────────

interface Options {
  driver: string | null;
  endpoint: string | null;
  capability: string | null;
  targets: "fixture" | "textedit";
  interactive: boolean;
  report: string | null;
  keepTargets: boolean;
  displayCtl: string;
  focusProbe: string | null;
  fixture: string;
  maxDisplays: number;
}

const usage = `multi-display-cert — second-display certification harness
  --driver <path>            cua-driver binary to host in-process (default
                             apps/desktop/resources/cua-driver/cua-driver,
                             or SYNARA_CUA_DRIVER)
  --endpoint <sock>          attach to an external trusted host instead
                             (or SYNARA_CUA_CERT_ENDPOINT)
  --capability <token>       capability for --endpoint (or
                             SYNARA_CUA_CERT_CAPABILITY)
  --targets fixture|textedit target apps (default fixture)
  --interactive              enable manual phases: display disconnect/
                             reconnect, per-display Space switch
  --report <path>            evidence JSON path (default
                             /private/tmp/synara-cua-implementation/
                             multi-display-cert-<timestamp>.json)
  --keep-targets             leave target windows/apps running afterwards
  --display-ctl <path>       display helper binary (built with clang if absent)
  --focus-probe <path>       focus-theft sampler; --no-focus-probe disables
  --max-displays <n>         cap the matrix at n displays (default 4)
  --help                     this text`;

function parseArgs(argv: string[]): Options {
  const options: Options = {
    driver: process.env.SYNARA_CUA_DRIVER ?? null,
    endpoint: process.env.SYNARA_CUA_CERT_ENDPOINT ?? null,
    capability: process.env.SYNARA_CUA_CERT_CAPABILITY ?? null,
    targets: "fixture",
    interactive: false,
    report: null,
    keepTargets: false,
    displayCtl: process.env.SYNARA_CUA_DISPLAY_CTL ?? defaultDisplayCtl,
    focusProbe: defaultFocusProbe,
    fixture: process.env.SYNARA_CUA_NATIVE_FIXTURE ?? defaultFixture,
    maxDisplays: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i]!;
    };
    switch (arg) {
      case "--driver":
        options.driver = value();
        break;
      case "--endpoint":
        options.endpoint = value();
        break;
      case "--capability":
        options.capability = value();
        break;
      case "--targets": {
        const picked = value();
        if (picked !== "fixture" && picked !== "textedit")
          throw new Error(`--targets must be fixture or textedit, got ${picked}`);
        options.targets = picked;
        break;
      }
      case "--interactive":
        options.interactive = true;
        break;
      case "--report":
        options.report = value();
        break;
      case "--keep-targets":
        options.keepTargets = true;
        break;
      case "--display-ctl":
        options.displayCtl = value();
        break;
      case "--focus-probe":
        options.focusProbe = value();
        break;
      case "--no-focus-probe":
        options.focusProbe = null;
        break;
      case "--fixture":
        options.fixture = value();
        break;
      case "--max-displays": {
        const n = Number(value());
        if (!Number.isSafeInteger(n) || n < 2)
          throw new Error("--max-displays needs an integer >= 2");
        options.maxDisplays = n;
        break;
      }
      case "--help":
        console.log(usage);
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}\n\n${usage}`);
    }
  }
  if (options.endpoint && !options.capability)
    throw new Error("--endpoint requires --capability (or SYNARA_CUA_CERT_CAPABILITY).");
  if (!options.endpoint && !options.driver) options.driver = defaultDriver;
  if (options.endpoint && options.driver)
    // Endpoint wins: an external host was explicitly supplied.
    options.driver = null;
  return options;
}

// ── display-ctl ──────────────────────────────────────────────────────

interface CertDisplay {
  index: number;
  id: number;
  uuid: string;
  uuidStable: boolean;
  bounds: ComputerRect;
  modeScale: number | null;
  backingScaleFactor: number | null;
  main: boolean;
  builtin: boolean;
  online: boolean;
  active: boolean;
  spaceInfo: {
    currentSpaceId: number | null;
    currentSpaceIdAlt: number | null;
    spaces: Array<{ id: number; type: number; current: boolean }>;
  } | null;
}

function ensureBinary(path: string, source: string, frameworks: string[]): void {
  if (existsSync(path)) return;
  const built = spawnSync(
    "/usr/bin/clang",
    ["-fobjc-arc", "-O2", "-o", path, source, ...frameworks.flatMap((f) => ["-framework", f])],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (built.status !== 0 || !existsSync(path))
    throw new Error(`helper build failed for ${path} (status ${built.status ?? "spawn error"})`);
  // Fresh binaries can be Gatekeeper-killed on first exec on this machine;
  // rewriting the inode clears it (documented in space-management-findings.md).
  const probe = spawnSync(path, ["count"], { encoding: "utf8" });
  if (probe.error || probe.status === null || probe.status === 137) {
    const tmp = `${path}.tmp-${process.pid}`;
    spawnSync("sh", ["-c", 'cat "$1" > "$2" && mv "$2" "$1" && chmod +x "$1"', "sh", path, tmp]);
  }
}

function displayCtlJson(path: string): { displayCount: number; displays: CertDisplay[] } {
  const out = execFileSync(path, ["json"], { encoding: "utf8" });
  return JSON.parse(out);
}

function displayCtlFront(path: string): { pid: number; name: string } | null {
  try {
    const out = execFileSync(path, ["front"], { encoding: "utf8", timeout: 10_000 }).trim();
    const match = out.match(/^front pid=(-?\d+) name=(.*)$/);
    if (!match) return null;
    return { pid: Number(match[1]), name: match[2] ?? "" };
  } catch {
    return null;
  }
}

function windowDisplayAuth(path: string, wids: number[]): Record<number, string | null> {
  const result: Record<number, string | null> = {};
  try {
    const out = execFileSync(path, ["window-display", ...wids.map(String)], {
      encoding: "utf8",
      timeout: 10_000,
    });
    for (const line of out.split("\n")) {
      const match = line.match(/^window (\d+) display=(.*)$/);
      if (match) result[Number(match[1])] = match[2] === "(none)" ? null : match[2]!;
    }
  } catch {
    for (const wid of wids) result[wid] = null;
  }
  return result;
}

// ── window → display mapping ─────────────────────────────────────────

function rectIntersectionArea(a: ComputerRect, b: ComputerRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function displayForBounds(
  bounds: ComputerRect,
  displays: readonly CertDisplay[],
): { index: number; share: number; straddling: boolean } | null {
  const area = bounds.width * bounds.height;
  if (!(area > 0)) return null;
  let best = -1;
  let bestArea = 0;
  let secondArea = 0;
  displays.forEach((display, index) => {
    const overlap = rectIntersectionArea(bounds, display.bounds);
    if (overlap > bestArea) {
      secondArea = bestArea;
      bestArea = overlap;
      best = index;
    } else if (overlap > secondArea) secondArea = overlap;
  });
  if (best < 0 || bestArea === 0) return null;
  return {
    index: best,
    share: bestArea / area,
    // A meaningful second-display overlap makes bounds-inference ambiguous —
    // recorded rather than hidden, since the WindowServer answer is authoritative.
    straddling: secondArea / area > 0.1,
  };
}

// ── targets ──────────────────────────────────────────────────────────

interface FixtureState {
  label: string;
  pid: number;
  windowId: number;
  title: string;
  clicks: number;
  edits: number;
  text: string;
  mouseEvents?: Array<{ type: string; x: number; y: number; buttonContains: boolean }>;
}

interface FixtureProc {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  states: Map<string, FixtureState>;
  stateResponses: number;
  ready: boolean;
  error: unknown;
}

async function spawnFixture(binary: string): Promise<FixtureProc> {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  const proc: FixtureProc = {
    child,
    lines: createInterface({ input: child.stdout }),
    states: new Map(),
    stateResponses: 0,
    ready: false,
    error: undefined,
  };
  child.once("error", (failure) => {
    proc.error = failure;
  });
  child.stderr.resume();
  proc.lines.on("line", (line) => {
    try {
      const value = JSON.parse(line);
      if (value.pid !== child.pid) {
        proc.error = new Error("Fixture process identity mismatch.");
        return;
      }
      if (value.ready === true) proc.ready = true;
      if (value.event === "state") {
        proc.states.set(value.label, value);
        proc.stateResponses += 1;
      }
    } catch (failure) {
      proc.error = failure;
    }
  });
  // The fixture reports both windows before `ready`; once ready is seen both
  // states are already in the map (the wait covers event ordering anyway).
  const deadline = Date.now() + 15_000;
  while (!proc.ready || !proc.states.has("A") || !proc.states.has("B")) {
    if (proc.error) throw proc.error;
    if (child.exitCode !== null) throw new Error(`fixture exited early (code ${child.exitCode})`);
    if (Date.now() > deadline) throw new Error("fixture did not report ready windows");
    await pause(50);
  }
  return proc;
}

async function fixtureState(proc: FixtureProc, label: string): Promise<FixtureState> {
  const before = proc.stateResponses;
  proc.child.stdin.write("state\n");
  const deadline = Date.now() + 10_000;
  while (proc.stateResponses < before + 2) {
    if (proc.error) throw proc.error;
    if (Date.now() > deadline) throw new Error("fixture state read timed out");
    await pause(25);
  }
  return proc.states.get(label)!;
}

function quitFixture(proc: FixtureProc): Promise<void> {
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      proc.child.kill("SIGKILL");
      resolve();
    }, 4_000);
    proc.child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    try {
      proc.child.stdin.end("quit\n");
    } catch {
      proc.child.kill("SIGKILL");
    }
  });
}

function buildFixture(binary: string): void {
  if (existsSync(binary)) return;
  const source = join(root, "scripts/computer-use-fixtures/NativeFixture.swift");
  // Same toolchain spelling build-electron.mjs uses, with xcrun fallbacks so
  // the operator's Mac only needs one of them present.
  const candidates = [
    "/Library/Developer/CommandLineTools/usr/bin/swiftc",
    spawnSync("xcrun", ["-f", "swiftc"], { encoding: "utf8" }).stdout?.trim() ?? "",
    "swiftc",
  ].filter(Boolean);
  const sdk =
    spawnSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).stdout?.trim() ??
    "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
  let lastError = "no swiftc found";
  for (const swiftc of candidates) {
    const built = spawnSync(
      swiftc,
      [
        "-sdk",
        sdk,
        "-module-cache-path",
        join(implementationDir, "swift-module-cache"),
        source,
        "-o",
        binary,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (built.status === 0 && existsSync(binary)) return;
    lastError = built.error ? String(built.error) : `exit ${built.status}`;
  }
  throw new Error(
    `native fixture build failed (${lastError}). Xcode Command Line Tools are required on the cert machine.`,
  );
}

interface Target {
  /** Display index this window was placed on. */
  displayIndex: number;
  displayUuid: string;
  windowId: string; // backend id cua:pid:wid
  pid: number;
  nativeWid: number;
  kind: "fixture" | "textedit";
  /** Fixture process + label when kind === "fixture". */
  fixture?: { proc: FixtureProc; label: string };
  /** TextEdit cleanup pid when kind === "textedit". */
  textEditPid?: number;
}

function findTextNode(
  root: ComputerUiNode | undefined,
  kind: "fixture" | "textedit",
): ComputerUiNode | undefined {
  if (!root) return undefined;
  if (
    (kind === "fixture" && root.role === "AXTextField" && root.label === "Fixture text") ||
    (kind === "textedit" && root.role === "AXTextArea")
  )
    return root;
  for (const child of root.children) {
    const found = findTextNode(child, kind);
    if (found) return found;
  }
  return undefined;
}

function findButtonNode(root: ComputerUiNode | undefined): ComputerUiNode | undefined {
  if (!root) return undefined;
  if (root.role === "AXButton" && /^Counter: \d+$/.test(root.label ?? "")) return root;
  for (const child of root.children) {
    const found = findButtonNode(child);
    if (found) return found;
  }
  return undefined;
}

// ── host plumbing ────────────────────────────────────────────────────

async function rawCall(
  endpoint: string,
  capability: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CuaToolResult> {
  const reply = await cuaRequest<CuaReply>(
    endpoint,
    { method: "call", name, args, capability },
    { timeoutMs: 35_000 },
  );
  if (!reply.ok) throw new Error(reply.error ?? `${name} failed`);
  return reply.result ?? {};
}

async function promptLine(rl: Interface, text: string): Promise<void> {
  await new Promise<void>((resolve) => rl.question(text, () => resolve()));
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const reportPath =
    options.report ??
    join(
      implementationDir,
      `multi-display-cert-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
  const runInfo: Record<string, unknown> = {
    at: new Date().toISOString(),
    targetsMode: options.targets,
    interactive: options.interactive,
    pinned: release,
  };
  const report: Record<string, unknown> = {
    probe: "multi-display-cert",
    schema: 1,
    run: runInfo,
    environment: {},
    preflight: {},
    targets: [],
    rungs: [],
    crossDisplay: {},
    manualPhases: {},
    maskedShield: {},
    summary: {},
  };
  const counts = { passed: 0, failed: 0, skipped: 0, refused: 0 };
  const finish = async (verdict: string, exitCode: number): Promise<number> => {
    report.summary = { ...counts, verdict };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`report: ${reportPath}`);
    console.log(
      `verdict: ${verdict} (passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped} refused=${counts.refused})`,
    );
    return exitCode;
  };

  // ── Phase 0: display enumeration + graceful refusal ────────────────
  // Helpers and reports live under implementationDir; on a fresh cert machine
  // nothing has created it yet, and clang/swiftc will not create the output
  // directory for their -o path either.
  await mkdir(implementationDir, { recursive: true });
  ensureBinary(options.displayCtl, join(root, "scripts/computer-use-fixtures/display_ctl.m"), [
    "AppKit",
    "CoreFoundation",
    "CoreGraphics",
  ]);
  const enumeration = displayCtlJson(options.displayCtl);
  report.environment = {
    arch: process.arch,
    os: spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout?.trim() ?? "",
    enumeration,
  };
  if (enumeration.displayCount < 2) {
    console.log("multi-display-cert: this machine has one display; the matrix needs two or more.");
    console.log("Attach an external display (or a second headless/display emulator) and re-run.");
    console.log("Preflight ran: display enumeration via display-ctl is recorded in the report.");
    return finish("skipped-single-display", 3);
  }
  const displays = enumeration.displays.slice(0, options.maxDisplays);
  console.log(
    `displays: ${enumeration.displayCount} detected, certifying ${displays.length}` +
      displays
        .map(
          (d) =>
            `\n  [${d.index}] ${d.uuid} ${d.bounds.width}x${d.bounds.height}@${d.bounds.x},${d.bounds.y} scale=${d.modeScale ?? "?"}`,
        )
        .join(""),
  );

  // ── Phase 1: trusted host ──────────────────────────────────────────
  let host: CuaDriverHost | undefined;
  let endpoint: string;
  let capability: string;
  if (options.endpoint) {
    endpoint = options.endpoint;
    capability = options.capability!;
    runInfo.hostMode = "external";
  } else {
    const driver = options.driver!;
    if (!existsSync(driver)) {
      console.error(
        `multi-display-cert: driver binary missing: ${driver}\n` +
          "Provision it (apps/desktop/scripts/provision-cua-driver.mjs) or pass --endpoint/--capability.",
      );
      report.error = "driver missing";
      return finish("error", 1);
    }
    capability = randomBytes(32).toString("base64url");
    host = new CuaDriverHost({
      binaryPath: driver,
      capability,
      // Describes the responsible process for permission reporting only; it
      // cannot impersonate a bundle. The real TCC attribution is the spawning
      // terminal's ancestry.
      bundleId: "com.synara.cua-display-cert",
      setup: async () => {
        throw new Error("the cert harness never requests permissions");
      },
    });
    endpoint = await host.listen();
    runInfo.hostMode = "spawned";
    runInfo.driver = { path: driver, sha256: sha256File(driver) };
  }

  const backend = new CuaComputerBackend({ endpoint, capability });
  const fixtureProcs: FixtureProc[] = [];
  const textEditPids: number[] = [];
  const targets: Target[] = [];
  let rl: Interface | undefined;
  const cleanup = async (): Promise<void> => {
    for (const proc of fixtureProcs) await quitFixture(proc).catch(() => undefined);
    for (const pid of textEditPids) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    await backend.dispose().catch(() => undefined);
    await host?.dispose().catch(() => undefined);
    rl?.close();
  };

  try {
    const permissions =
      (await rawCall(endpoint, capability, "check_permissions", { prompt: false }))
        .structuredContent ?? {};
    report.preflight = { permissions };
    const accessibility = permissions.accessibility === true;
    const screenRecording = permissions.screen_recording === true;
    console.log(`permissions: accessibility=${accessibility} screenRecording=${screenRecording}`);
    if (!accessibility) {
      report.preflight = { permissions, blocked: "accessibility grant missing" };
      console.error(
        "multi-display-cert: the trusted ancestry lacks Accessibility — the driver cannot observe or act. " +
          "Grant the terminal/host app Accessibility + Screen Recording in System Settings and re-run.",
      );
      return finish("blocked-no-accessibility", 2);
    }
    if (!screenRecording)
      console.log("note: no Screen Recording grant — screenshot/pixel rungs will skip honestly.");

    // ── Phase 2: targets, one per display ────────────────────────────
    // The focus probe is a plain clang build like display-ctl; build it only
    // when it is the default path (a custom --focus-probe location is the
    // operator's to provide). --no-focus-probe skips this entirely.
    if (options.focusProbe === defaultFocusProbe && !existsSync(options.focusProbe))
      ensureBinary(options.focusProbe, join(root, "scripts/computer-use-fixtures/focus_probe.m"), [
        "AppKit",
        "ApplicationServices",
        "CoreGraphics",
      ]);
    const focus = options.focusProbe
      ? await startFocusProbe({
          binaryPath: options.focusProbe,
          hz: 20,
          label: "multi-display-cert",
          maxDurationSeconds: 900,
        })
      : null;
    report.focusProbe = focus ? "running" : "unavailable";

    if (options.targets === "fixture") {
      buildFixture(options.fixture);
      // One fixture process per display: window A of instance i serves display i.
      for (let i = 0; i < displays.length; i++) {
        const proc = await spawnFixture(options.fixture);
        fixtureProcs.push(proc);
        const state = await fixtureState(proc, "A");
        targets.push({
          displayIndex: i,
          displayUuid: displays[i]!.uuid,
          windowId: `cua:${proc.child.pid}:${state.windowId}`,
          pid: proc.child.pid!,
          nativeWid: state.windowId,
          kind: "fixture",
          fixture: { proc, label: "A" },
        });
      }
    } else {
      // Snapshot existing TextEdit windows first so the operator's own
      // documents are never adopted as cert targets.
      const existing = new Set(
        (await backend.listWindows()).filter((w) => w.appName === "TextEdit").map((w) => w.id),
      );
      for (let i = 0; i < displays.length; i++) {
        spawnSync("/usr/bin/open", ["-g", "-n", "-a", "TextEdit"], { stdio: "ignore" });
        await pause(600);
      }
      const deadline = Date.now() + 15_000;
      let candidates: Awaited<ReturnType<typeof backend.listWindows>> = [];
      while (Date.now() < deadline) {
        const windows = await backend.listWindows();
        candidates = windows.filter(
          (w) => w.appName === "TextEdit" && !existing.has(w.id) && w.bounds,
        );
        if (candidates.length >= displays.length) break;
        await pause(300);
      }
      for (let i = 0; i < displays.length; i++) {
        const window = candidates[i];
        if (!window?.pid)
          throw new Error(`no TextEdit window for display ${i} (found ${candidates.length})`);
        const wid = Number(window.id.split(":")[2]);
        textEditPids.push(window.pid);
        targets.push({
          displayIndex: i,
          displayUuid: displays[i]!.uuid,
          windowId: window.id,
          pid: window.pid,
          nativeWid: wid,
          kind: "textedit",
          textEditPid: window.pid,
        });
      }
    }

    // Place each target on its display and verify by read-back, twice:
    // bounds∩display inference and the WindowServer's own answer.
    const placement: Array<Record<string, unknown>> = [];
    for (const target of targets) {
      const display = displays[target.displayIndex]!;
      const frame = { x: display.bounds.x + 60, y: display.bounds.y + 60, width: 540, height: 320 };
      let result: unknown = null;
      try {
        result = await backend.setWindowFrame(target.windowId, frame);
      } catch (error) {
        result = { error: String(error) };
      }
      await pause(350);
      const observed = (await backend.listWindows()).find((w) => w.id === target.windowId);
      const mapping = observed?.bounds ? displayForBounds(observed.bounds, displays) : null;
      const authoritative = windowDisplayAuth(options.displayCtl, [target.nativeWid]);
      placement.push({
        windowId: target.windowId,
        displayIndex: target.displayIndex,
        displayUuid: target.displayUuid,
        requestedFrame: frame,
        result,
        observedBounds: observed?.bounds ?? null,
        inferredDisplay: mapping,
        authoritativeDisplay: authoritative[target.nativeWid] ?? null,
        placed:
          mapping?.index === target.displayIndex &&
          authoritative[target.nativeWid] === target.displayUuid,
      });
    }
    report.targets = targets.map((target) => ({ ...target, fixture: undefined }));
    report.placement = placement;
    const misplaced = placement.filter((p) => p.placed !== true);
    if (misplaced.length)
      console.log(
        `warning: ${misplaced.length} target(s) did not verify on their assigned display; rungs record what the driver actually saw.`,
      );

    // ── Phase 3: per-display rungs ───────────────────────────────────
    const rungs: Array<Record<string, unknown>> = [];
    const push = (rung: Record<string, unknown>, name: string, status: string, detail: unknown) => {
      if (status === "passed") counts.passed += 1;
      else if (status === "skipped") counts.skipped += 1;
      else if (status === "refused") counts.refused += 1;
      else counts.failed += 1;
      (rung.cases as unknown[]).push({ name, status, detail });
      console.log(`  [${status}] ${name}`);
    };

    for (const target of targets) {
      const display = displays[target.displayIndex]!;
      const rung: Record<string, unknown> = {
        displayIndex: target.displayIndex,
        displayUuid: target.displayUuid,
        windowId: target.windowId,
        cases: [],
      };
      rungs.push(rung);
      console.log(`display ${target.displayIndex} (${target.displayUuid}) — ${target.windowId}`);

      // (a) Raw observation — the display/Space fields the backend drops.
      let rawState: Record<string, unknown> = {};
      try {
        const result = await rawCall(endpoint, capability, "get_window_state", {
          pid: target.pid,
          window_id: target.nativeWid,
          include_accessibility_tree: false,
          include_screenshot: false,
        });
        rawState = result.structuredContent ?? {};
        push(rung, "raw-observation", "passed", {
          window_bounds: rawState.window_bounds,
          window_on_current_space: rawState.window_on_current_space,
          window_is_on_screen: rawState.window_is_on_screen,
          current_space_id: rawState.current_space_id,
          window_space_ids: rawState.window_space_ids,
          displayCurrentSpace: display.spaceInfo?.currentSpaceId ?? null,
        });
        if (rawState.window_on_current_space !== true)
          push(
            rung,
            "on-current-space",
            "failed",
            `window_on_current_space=${String(rawState.window_on_current_space)} — the driver's Space gate does not see this display's active Space as current; pointer input will refuse.`,
          );
      } catch (error) {
        push(rung, "raw-observation", "failed", String(error));
      }

      // (b) Backend observation — element tokens for semantic rungs.
      let observation: Awaited<ReturnType<typeof backend.getState>> | null = null;
      try {
        observation = await backend.getState({
          windowId: target.windowId,
          includeTree: true,
          includeScreenshot: screenRecording,
        });
        push(rung, "backend-observation", "passed", {
          elements: observation.root?.children.length ?? 0,
          truncated: observation.root?.truncated ?? null,
          screenshotScale: observation.screenshot?.scale ?? null,
          screenshotRegion: observation.screenshot?.region ?? null,
          previewNote: observation.previewNote ?? null,
        });
      } catch (error) {
        push(rung, "backend-observation", "failed", String(error));
      }

      // (c) Scale cross-check — the window PNG's px/point ratio against both
      // independent display-ctl readings of THIS display's backing factor.
      if (observation?.screenshot?.scale) {
        const scale = observation.screenshot.scale;
        const expected = display.backingScaleFactor ?? display.modeScale;
        // No independent scale reading for this display means the rung is
        // unmeasurable, not failed — record that honestly like every other
        // unprovable comparison in this matrix.
        if (expected === null) {
          push(rung, "scale-match", "skipped", {
            reason: "display-ctl reported no scale for this display",
            screenshotScale: scale,
          });
        } else {
          const match = Math.abs(scale - expected) < 0.01;
          push(rung, "scale-match", match ? "passed" : "failed", {
            screenshotScale: scale,
            displayModeScale: display.modeScale,
            displayBackingScaleFactor: display.backingScaleFactor,
          });
        }
      } else {
        push(
          rung,
          "scale-match",
          "skipped",
          screenRecording ? "no screenshot scale" : "no-screen-recording",
        );
      }

      // (d) Background click at a display-local point — the backend converts
      // the global point to window_points and validates the expected bounds.
      const frontBefore = displayCtlFront(options.displayCtl);
      const button = observation?.root ? findButtonNode(observation.root) : undefined;
      if (!screenRecording) {
        push(
          rung,
          "background-click",
          "skipped",
          "no-screen-recording (pixel grounding requires an observation)",
        );
      } else if (target.kind === "fixture" && !button?.activationPoint) {
        push(rung, "background-click", "skipped", "fixture button not in AX tree");
      } else {
        const bounds = observation?.windows[0]?.bounds;
        const point =
          target.kind === "fixture"
            ? button!.activationPoint!
            : bounds
              ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
              : undefined;
        if (!point) {
          push(rung, "background-click", "skipped", "no window bounds for click point");
        } else {
          try {
            const result = await backend.click(point, target.windowId);
            await pause(250);
            const front = displayCtlFront(options.displayCtl);
            let landed: unknown = null;
            let landedOk: boolean | null = null;
            if (target.fixture) {
              const state = await fixtureState(target.fixture.proc, target.fixture.label);
              const last = state.mouseEvents?.at(-1);
              landed = { clicks: state.clicks, lastEvent: last ?? null };
              landedOk = state.clicks >= 1 && last?.buttonContains === true;
            }
            push(rung, "background-click", landedOk === false ? "failed" : "passed", {
              point,
              result,
              landed,
              frontmost: {
                before: frontBefore,
                after: front,
                preserved:
                  frontBefore === null || front === null ? null : frontBefore.pid === front.pid,
              },
            });
          } catch (error) {
            push(
              rung,
              "background-click",
              error instanceof CuaActionError ? "refused" : "failed",
              error instanceof CuaActionError
                ? { code: error.code, effect: error.effect, error: String(error) }
                : String(error),
            );
          }
        }
      }

      // (e) set_value write + independent read-back.
      const field = observation?.root ? findTextNode(observation.root, target.kind) : undefined;
      if (!field) {
        push(rung, "set-value", "skipped", "no text element in AX tree");
      } else {
        const marker = `MDC-d${target.displayIndex}-${Date.now().toString(36)}`;
        const frontBeforeWrite = displayCtlFront(options.displayCtl);
        try {
          const result: ComputerBackendActionResult | void = await backend.setValue(
            {
              target: { windowId: target.windowId, label: field.label ?? "text" },
              node: field,
              point: field.activationPoint ?? { x: field.frame.x, y: field.frame.y },
            },
            marker,
          );
          await pause(300);
          // Read-back 1: the target's own state (fixture in-process).
          let appReadback: unknown = null;
          let appMatch: boolean | null = null;
          if (target.fixture) {
            const state = await fixtureState(target.fixture.proc, target.fixture.label);
            appReadback = state.text;
            appMatch = state.text === marker;
          }
          // Read-back 2: fresh driver AX read of the same element.
          let axReadback: string | null = null;
          try {
            const fresh = await backend.getState({ windowId: target.windowId, includeTree: true });
            axReadback = findTextNode(fresh.root, target.kind)?.value ?? null;
          } catch (error) {
            axReadback = `read error: ${String(error)}`;
          }
          const front = displayCtlFront(options.displayCtl);
          const ok = axReadback === marker && appMatch !== false;
          push(rung, "set-value", ok ? "passed" : "failed", {
            marker,
            result: result ?? null,
            appReadback,
            axReadback,
            frontmost: {
              before: frontBeforeWrite,
              after: front,
              preserved:
                frontBeforeWrite === null || front === null
                  ? null
                  : frontBeforeWrite.pid === front.pid,
            },
          });
        } catch (error) {
          push(
            rung,
            "set-value",
            error instanceof CuaActionError ? "refused" : "failed",
            error instanceof CuaActionError
              ? { code: error.code, effect: error.effect, error: String(error) }
              : String(error),
          );
        }
      }
    }
    report.rungs = rungs;

    // ── Phase 4: cross-display checks ────────────────────────────────
    const cross: Record<string, unknown> = {};

    // Concurrent writes, one per display — the semantic-lane story across
    // display boundaries (host serializes dispatch; the driver admits
    // concurrent exact targets).
    {
      const markers = targets.map((t) => `MDC-x${t.displayIndex}-${Date.now().toString(36)}`);
      const fields = await Promise.all(
        targets.map(async (t) => {
          const observation = await backend
            .getState({ windowId: t.windowId, includeTree: true })
            .catch(() => null);
          return {
            t,
            field: observation?.root ? findTextNode(observation.root, t.kind) : undefined,
          };
        }),
      );
      const started = Date.now();
      const writes = fields.map(({ t, field }, i) =>
        field
          ? backend
              .setValue(
                {
                  target: { windowId: t.windowId, label: field.label ?? "text" },
                  node: field,
                  point: field.activationPoint ?? { x: field.frame.x, y: field.frame.y },
                },
                markers[i]!,
              )
              .then((result) => ({ windowId: t.windowId, result: result ?? null }))
              .catch((error: unknown) => ({ windowId: t.windowId, error: String(error) }))
          : Promise.resolve({ windowId: t.windowId, error: "no text element" }),
      );
      const settled = await Promise.all(writes);
      const elapsedMs = Date.now() - started;
      // Independent read-back per window.
      const readbacks = await Promise.all(
        targets.map(async (t, i) => {
          try {
            const fresh = await backend.getState({ windowId: t.windowId, includeTree: true });
            return {
              windowId: t.windowId,
              value: findTextNode(fresh.root, t.kind)?.value ?? null,
              marker: markers[i],
            };
          } catch (error) {
            return { windowId: t.windowId, error: String(error), marker: markers[i] };
          }
        }),
      );
      const allMatch = readbacks.every((r) => (r as { value?: string }).value === r.marker);
      cross.concurrentSetValue = { elapsedMs, writes: settled, readbacks, verified: allMatch };
      if (allMatch) counts.passed += 1;
      else counts.failed += 1;
      console.log(
        `  [${allMatch ? "passed" : "failed"}] cross-display concurrent set_value (${elapsedMs} ms)`,
      );
    }

    // Desktop-state overview coverage: which displays the capture covers.
    try {
      const desktop = await rawCall(endpoint, capability, "get_desktop_state", {});
      const data = desktop.structuredContent ?? {};
      const png = desktop.content?.find(
        (c) => c.type === "image" && c.mimeType === "image/png" && c.data,
      );
      const region = {
        x: 0,
        y: 0,
        width: Number(data.screen_width ?? 0),
        height: Number(data.screen_height ?? 0),
      };
      cross.desktopState = {
        screen_width: data.screen_width,
        screen_height: data.screen_height,
        screen_scale: data.scale_factor ?? null,
        screenshotBytes: png?.data ? Buffer.byteLength(png.data, "base64") : null,
        coverage: displays.map((display) => ({
          index: display.index,
          uuid: display.uuid,
          coveredShare:
            region.width > 0
              ? rectIntersectionArea(display.bounds, region) /
                (display.bounds.width * display.bounds.height)
              : 0,
        })),
        note: "the overview is documented as primary-display only; coverage rows record what it actually covered",
      };
    } catch (error) {
      cross.desktopState = { error: String(error) };
    }

    // get_screen_size vs the main display's display-ctl bounds.
    try {
      const size =
        (await rawCall(endpoint, capability, "get_screen_size", {})).structuredContent ?? {};
      const main = displays.find((d) => d.main) ?? displays[0]!;
      cross.screenSize = {
        reported: size,
        mainDisplay: { uuid: main.uuid, bounds: main.bounds, modeScale: main.modeScale },
        matchesMainBounds:
          Number(size.width) === main.bounds.width && Number(size.height) === main.bounds.height,
        note: "driver reports the primary display only; no per-display enumeration exists in the protocol",
      };
    } catch (error) {
      cross.screenSize = { error: String(error) };
    }

    // Authoritative window→display mapping for every target (WindowServer's
    // own answer, not bounds inference).
    cross.windowDisplayAuth = windowDisplayAuth(
      options.displayCtl,
      targets.map((t) => t.nativeWid),
    );
    report.crossDisplay = cross;

    // ── Phase 5: masked-shield protocol readiness (the native shield is
    // unbuilt — cert records whether the protocol carries everything its
    // placement math needs per display; see masked-activation-findings.md).
    report.maskedShield = {
      status: "not-implemented",
      reference: "docs/computer-use-cua/masked-activation-findings.md",
      protocolReadiness: displays.map((display) => ({
        index: display.index,
        uuid: display.uuid,
        // The shield needs: the target frame in global points (list_windows
        // bounds), the display rect it must cover (CGDisplayBounds), and the
        // display's menu-bar state. All derivable today; the native
        // excursion itself is unimplemented and unexercised.
        dataAvailable: true,
        bounds: display.bounds,
        main: display.main,
      })),
    };

    // ── Phase 6: interactive phases (manual, gated) ──────────────────
    const manual: Record<string, unknown> = {};
    if (!options.interactive) {
      manual.disconnectReconnect = "skipped: pass --interactive to run the unplug/replug phase";
      manual.perDisplaySpaces = "skipped: pass --interactive to run the per-display Space phase";
    } else {
      rl = createInterface({ input: process.stdin, output: process.stdout });

      // Display disconnect/reconnect — inherently manual.
      const before = displayCtlJson(options.displayCtl);
      await promptLine(rl, "\n>>> Unplug the external display now, then press Enter.\n");
      await pause(1_500);
      const during = displayCtlJson(options.displayCtl);
      const goneUuids = before.displays
        .map((d) => d.uuid)
        .filter((uuid) => !during.displays.some((d) => d.uuid === uuid));
      // The disconnected display's target should migrate or vanish; the
      // driver must still answer for every surviving window.
      const survivors = await backend.listWindows();
      const migrated = targets.map((t) => {
        const row = survivors.find((w) => w.id === t.windowId);
        return {
          windowId: t.windowId,
          stillListed: row !== undefined,
          bounds: row?.bounds ?? null,
          display: row?.bounds ? displayForBounds(row.bounds, during.displays) : null,
        };
      });
      await promptLine(rl, "\n>>> Reconnect the display now, then press Enter.\n");
      await pause(2_000);
      const after = displayCtlJson(options.displayCtl);
      const returned = after.displays.filter((d) => goneUuids.includes(d.uuid));
      manual.disconnectReconnect = {
        beforeUuids: before.displays.map((d) => d.uuid),
        duringUuids: during.displays.map((d) => d.uuid),
        afterUuids: after.displays.map((d) => d.uuid),
        removedUuids: goneUuids,
        returnedUuids: returned.map((d) => d.uuid),
        uuidStableAcrossReconnect: returned.every((d) => d.uuidStable),
        migratedWindows: migrated,
      };
      if (goneUuids.length === 0 || returned.length === 0) {
        counts.failed += 1;
        console.log("  [failed] disconnect/reconnect — display set did not change as expected");
      } else {
        counts.passed += 1;
        console.log("  [passed] disconnect/reconnect — display UUID stable across replug");
      }

      // Per-display Spaces: on a chosen secondary display the operator makes
      // a second Space (fullscreen an app or swipe), which must flip the
      // target's on_current_space while leaving semantic writes testable.
      const secondary = displays.find((d) => !d.main) ?? displays[1]!;
      const target = targets.find((t) => t.displayUuid === secondary.uuid);
      if (!target) {
        manual.perDisplaySpaces = "skipped: no target on a non-main display";
      } else {
        await promptLine(
          rl,
          `\n>>> On the SECONDARY display (${secondary.uuid}), make any app fullscreen\n` +
            "    or swipe to a second Space so the fixture window's Space is not current,\n" +
            "    then press Enter.\n",
        );
        await pause(1_000);
        const spacesAfter = displayCtlJson(options.displayCtl);
        const displayAfter = spacesAfter.displays.find((d) => d.uuid === secondary.uuid);
        const currentNow = displayAfter?.spaceInfo?.currentSpaceId ?? null;
        const offSpace = await rawCall(endpoint, capability, "get_window_state", {
          pid: target.pid,
          window_id: target.nativeWid,
          include_accessibility_tree: false,
          include_screenshot: false,
        }).catch((error: unknown) => {
          const result: CuaToolResult = { structuredContent: { error: String(error) } };
          return result;
        });
        const state = offSpace.structuredContent ?? {};
        // Pointer input must refuse; an exact semantic write is measured
        // either way — admission or refusal is the certification data.
        const offBounds = (state.window_bounds as ComputerRect | undefined) ?? undefined;
        let pointerRefusal: unknown = null;
        try {
          await backend.click(
            offBounds
              ? { x: offBounds.x + offBounds.width / 2, y: offBounds.y + offBounds.height / 2 }
              : { x: 0, y: 0 },
            target.windowId,
          );
          pointerRefusal = { admitted: true };
        } catch (error) {
          pointerRefusal = {
            refused: true,
            code: error instanceof CuaActionError ? error.code : null,
            error: String(error),
          };
        }
        const field = await backend
          .getState({ windowId: target.windowId, includeTree: true })
          .then((o) => findTextNode(o.root, target.kind))
          .catch(() => undefined);
        let semantic: unknown = "skipped: no field";
        if (field) {
          try {
            semantic = await backend.setValue(
              {
                target: { windowId: target.windowId, label: field.label ?? "text" },
                node: field,
                point: field.activationPoint ?? { x: field.frame.x, y: field.frame.y },
              },
              `MDC-offspace-${Date.now().toString(36)}`,
            );
            semantic = semantic ?? { admitted: true };
          } catch (error) {
            semantic = {
              refused: true,
              code: error instanceof CuaActionError ? error.code : null,
              error: String(error),
            };
          }
        }
        manual.perDisplaySpaces = {
          displayUuid: secondary.uuid,
          currentSpaceAfterSwitch: currentNow,
          window_on_current_space: state.window_on_current_space ?? null,
          window_space_ids: state.window_space_ids ?? null,
          pointerRefusal,
          semanticWrite: semantic,
        };
        console.log("  [recorded] per-display Space switch — see report");
        await promptLine(
          rl,
          "\n>>> Switch the secondary display back to the fixture's Space, then press Enter.\n",
        );
      }
    }
    report.manualPhases = manual;

    // Focus-theft analysis for the whole run.
    if (focus) {
      const finished = await focus.finish();
      report.focusProbe = {
        meta: finished.meta,
        done: finished.done,
        exitCode: finished.exitCode,
        report: finished.report,
      };
      if (!finished.report.theftFree) {
        counts.failed += 1;
        console.log("  [failed] focus-probe: off-baseline focus samples detected");
      } else if (!finished.report.ok) {
        console.log("  [thin] focus-probe: coverage too thin to assert theft-free (see report)");
      } else {
        console.log("  [passed] focus-probe: zero off-baseline focus samples");
      }
    }

    // Teardown of targets.
    if (!options.keepTargets) {
      for (const proc of fixtureProcs) await quitFixture(proc);
      for (const pid of textEditPids) {
        // Clear the marker first so autosave cannot resurrect it.
        const t = targets.find((x) => x.textEditPid === pid);
        if (t) {
          const field = await backend
            .getState({ windowId: t.windowId, includeTree: true })
            .then((o) => findTextNode(o.root, "textedit"))
            .catch(() => undefined);
          if (field)
            await backend
              .setValue(
                {
                  target: { windowId: t.windowId, label: field.label ?? "text" },
                  node: field,
                  point: field.activationPoint ?? { x: field.frame.x, y: field.frame.y },
                },
                "",
              )
              .catch(() => undefined);
        }
        await backend.killApp(pid).catch(() => undefined);
      }
    } else {
      console.log("targets left running (--keep-targets)");
    }

    await cleanup();
    const failed = counts.failed + counts.refused > 0;
    return finish(failed ? "failed" : "passed", failed ? 2 : 0);
  } catch (error) {
    report.error = String(error);
    console.error(`multi-display-cert: ${String(error)}`);
    await cleanup();
    return finish("error", 1);
  }
}

function sha256File(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`multi-display-cert: ${String(error)}`);
    process.exit(1);
  });
