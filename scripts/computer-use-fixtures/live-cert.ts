/**
 * live-cert: the single-command live gate for Synara computer use.
 *
 * Boots a trusted CuaDriverHost + the packaged driver on the current tree,
 * spawns real TextEdit targets without stealing focus (`open -g` / `open -j`
 * / minimized), samples the focus-theft probe at ~50 Hz for the whole run,
 * executes a named-assertion matrix through the same `cuaRequest` wire the
 * server uses, and emits one JSON report plus a markdown note under
 * `--out`. Exit 0 = every non-skipped row passed; exit 2 = a failure; exit 1
 * = environment/usage error (missing grants, missing binary).
 *
 * Rows (each reports pass|fail|skipped with evidence):
 *   launch-isolation        `open -g` target appears; frontmost unchanged
 *   visible-nonkey-write    set_value into visible non-key TextEdit + readback
 *   hidden-write            set_value into `open -j` hidden app + readback
 *   minimized-write         set_value into minimized window + readback
 *   concurrent-writes       three windows, Promise.all set_value, all confirmed
 *   operator-typing         keystrokes into the front app while agent writes a
 *                           hidden doc — no cross-contamination either way
 *   hidden-launch-default   ComputerManager.launchApp with no options lands
 *                           the window off-screen (invisible-workspace seam)
 *   chromium-semantic       real Chrome: hidden launch + re-hide + driver-
 *                           enabled AX tree + omnibox set_value + readback
 *   grant-lifecycle         per-app always-allow: prompt→mint→silent cover
 *                           →revoke→re-prompt through manager.admitDrivenApp
 *   locked-use-reauth       host.pauseDesktop→resume through the real
 *                           desktop-interrupted chain: standing task consent
 *                           revoked (re-prompt), declines held, pending
 *                           prompts survive, input paused→observation→resumed
 *   space-roundtrip         SLSManagedDisplaySetCurrentSpace switch→act→back
 *                           (skipped with `skipped-single-desktop` when only
 *                           one managed desktop space exists)
 *   off-space-refusal       element ops on an off-Space window refuse cleanly
 *   screenshot-fresh        get_window_state include_screenshot returns fresh
 *                           geometry+PNG bytes
 *   hidden-screenshot       hidden-window backing store tracks live content
 *                           (shot-A != shot-B across a semantic write)
 *   stale-token             forged element_token refuses `stale_element_token`
 *   verify-state            verify_state tri-state on a known value
 *   masked-activation       shield panel verified via all-layer CGWindowList
 *                           through a real activation + semantic write
 *   escape-kill-switch      synthetic-Escape immunity + host latch + refusal
 *                           + explicit rearm (physical key unverified on VM)
 *   cancellation            long type_text cancelled mid-flight; honest effect
 *   focus-invariant         probe: zero theft fields off baseline across run
 *
 * Requirements: the runner's terminal (or bun) needs Accessibility + Screen
 * Recording for the probe's keyWin/focused fields; the packaged driver needs
 * its own grants (the canary bundle id). Missing grants narrow coverage —
 * rows dependent on them report `skipped`, never `pass`.
 *
 * Usage: bun scripts/computer-use-fixtures/live-cert.ts [--out DIR] [--json]
 *        [--skip row,row] [--keep-targets] [--quiet]
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { cuaRequest, type CuaReply } from "@synara/shared/cuaDriverProtocol";
import { CuaDriverHost } from "../../apps/desktop/src/cuaDriverHost";
import { ComputerShield } from "../../apps/desktop/src/computerShield";
import { EscapeKillSwitchMonitor } from "../../apps/desktop/src/escapeKillSwitchMonitor";
import { CuaComputerBackend } from "../../apps/server/src/computer/CuaComputerBackend";
import { ComputerManager } from "../../apps/server/src/computer/ComputerManager";
import { computerApprovalGate } from "../../apps/server/src/computer/ComputerApprovalGate";
import {
  analyzeFocusSamples,
  parseFocusProbeLine,
  type FocusProbeExpect,
  type FocusProbeLine,
  type FocusProbeSample,
} from "../../apps/desktop/src/cuaFixtures/focusProbe";

const root = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(root, "apps/desktop/resources/cua-driver/cua-driver");
const PROBE_BIN = "/private/tmp/synara-cua-implementation/focus-probe";
const SPACE_CTL = "/private/tmp/synara-cua-implementation/space-ctl";
const APPSNAP = join(root, "apps/desktop/.electron-runtime/appsnap/synara-appsnap-helper");
const SENTINEL = `livecert-${Date.now().toString(36)}`;

type Verdict = "pass" | "fail" | "skipped";
interface Row {
  name: string;
  verdict: Verdict;
  detail?: string;
  evidence?: unknown;
  elapsedMs?: number;
}

const rows: Row[] = [];
const skipSet = new Set(
  (process.argv.find((a) => a.startsWith("--skip=")) ?? "")
    .replace("--skip=", "")
    .split(",")
    .filter(Boolean),
);
const outIdx = process.argv.indexOf("--out");
const outArg = outIdx > 0 ? process.argv[outIdx + 1] : undefined;
const outDir = outArg ?? join(root, "docs/computer-use-cua/evidence");
const keepTargets = process.argv.includes("--keep-targets");
const quiet = process.argv.includes("--quiet");
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const reportPath = join(outDir, `live-cert-${stamp}-${SENTINEL}-report.json`);
const notesPath = join(outDir, `live-cert-${stamp}-${SENTINEL}-notes.md`);

function log(...args: unknown[]) {
  if (!quiet) console.log(...args);
}

function row(
  name: string,
  verdict: Verdict,
  detail?: string,
  evidence?: unknown,
  elapsedMs?: number,
) {
  rows.push({
    name,
    verdict,
    ...(detail ? { detail } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  });
  log(
    `${verdict === "pass" ? "  PASS" : verdict === "fail" ? "  FAIL" : "  SKIP"} ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

const wanted = (name: string) => !skipSet.has(name);

// ── focus probe ──────────────────────────────────────────────────────────

const probeLines: FocusProbeLine[] = [];
let probe: ChildProcessWithoutNullStreams | undefined;
let probeMetaHz = 0;
let probeStartWall = 0;
/** Spans (probe-relative tMs) where the harness itself moves the operator's
 * Space/focus deliberately — theft analysis drops these samples, while the
 * row asserts the end-state returned to baseline. */
const exemptSpans: Array<{ start: number; end: number }> = [];
function exemptStart(): number {
  return Date.now() - probeStartWall;
}
function exemptEnd(start: number) {
  exemptSpans.push({ start, end: Date.now() - probeStartWall });
}

function startProbe(label: string) {
  if (!existsSync(PROBE_BIN)) {
    const build = spawnSync(
      "sh",
      [join(root, "scripts/computer-use-fixtures/build-focus-probe.sh")],
      {
        stdio: quiet ? "pipe" : "inherit",
      },
    );
    if (build.status !== 0 || !existsSync(PROBE_BIN)) return false;
  }
  probeStartWall = Date.now();
  probe = spawn(PROBE_BIN, ["--hz", "50", "--stdin", "--label", label], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  probe.stdout.on("data", (d) => {
    buf += String(d);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const parsed = parseFocusProbeLine(line);
      if (parsed) {
        probeLines.push(parsed);
        if (parsed.kind === "meta") probeMetaHz = parsed.meta.hz;
      }
    }
  });
  return true;
}

async function stopProbe(): Promise<ReturnType<typeof analyzeFocusSamples> | undefined> {
  if (!probe) return undefined;
  probe.stdin.end();
  await new Promise<void>((r) => {
    probe!.once("exit", () => r());
    setTimeout(r, 4000);
  });
  try {
    probe.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  const all = probeLines
    .filter((l): l is { kind: "sample"; sample: FocusProbeSample } => l.kind === "sample")
    .map((l) => l.sample);
  const samples = all.filter(
    (sample) => !exemptSpans.some((sp) => sample.t >= sp.start - 500 && sample.t <= sp.end + 500),
  );
  const report = analyzeFocusSamples(samples, {
    minSamples: 40,
    settleMs: 500,
  });
  return { ...report, exemptSpans } as ReturnType<typeof analyzeFocusSamples> & {
    exemptSpans: typeof exemptSpans;
  };
}

// ── driver calls ─────────────────────────────────────────────────────────

let endpoint = "";
let capability = "";

async function call<T = unknown>(
  name: string,
  args?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<T> {
  return cuaRequest<T>(
    endpoint,
    {
      method: "call",
      name,
      ...(args ? { args } : {}),
      capability,
    },
    { timeoutMs, mutation: true },
  );
}

/** Per-tool wall-clock samples — aggregated into the report's speed
 * table (count/p50/p95/max per driver tool). */
const callTimings = new Map<string, number[]>();

async function callReply(
  name: string,
  args?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<CuaReply> {
  const t0 = performance.now();
  try {
    return await cuaRequest<CuaReply>(
      endpoint,
      {
        method: "call",
        name,
        ...(args ? { args } : {}),
        capability,
      },
      { timeoutMs, mutation: true },
    );
  } finally {
    const ms = performance.now() - t0;
    const list = callTimings.get(name) ?? [];
    list.push(Math.round(ms * 10) / 10);
    callTimings.set(name, list);
  }
}

function speedTable(): Array<{
  tool: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
}> {
  const pct = (sorted: number[], q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
  return [...callTimings.entries()]
    .map(([tool, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return {
        tool,
        n: sorted.length,
        p50: pct(sorted, 0.5),
        p95: pct(sorted, 0.95),
        max: sorted[sorted.length - 1] ?? 0,
      };
    })
    .sort((a, b) => a.tool.localeCompare(b.tool));
}

/** A reply is only OK when it carries no refusal/error surface at all. */
function replyOk(res: CuaReply | undefined): boolean {
  if (!res || res.ok === false) return false;
  const top = res as unknown as Record<string, unknown>;
  if ("code" in top || "error" in top) return false;
  const sc = res.result?.structuredContent as Record<string, unknown> | undefined;
  if (sc && (sc.status === "refused" || "refusal" in sc)) return false;
  return true;
}

interface WinInfo {
  window_id: number;
  title: string;
  app_name: string;
  pid: number;
  bounds: { x: number; y: number; width: number; height: number };
  is_on_screen?: boolean;
  on_current_space?: boolean;
  minimized?: boolean;
  visible?: boolean;
  space_ids?: number[];
  layer?: number;
  z_index?: number;
}

async function listWindows(pid?: number): Promise<WinInfo[]> {
  const reply = await callReply("list_windows", pid ? { pid } : {});
  const sc = reply.result?.structuredContent as { windows?: WinInfo[] } | undefined;
  return sc?.windows ?? [];
}

interface AxElement {
  role?: string;
  label?: string;
  value?: string;
  element_token?: string;
  element_index?: number;
  frame?: { x: number; y: number; width: number; height: number };
}

async function textAreaToken(
  pid: number,
  windowId: number,
): Promise<{ token: string; elements: number } | undefined> {
  const reply = await callReply("get_window_state", {
    pid,
    window_id: windowId,
    max_elements: 512,
  });
  const sc = reply.result?.structuredContent as { elements?: AxElement[] } | undefined;
  const el = (sc?.elements ?? []).find(
    (e) => e.role === "AXTextArea" && typeof e.element_token === "string",
  );
  return el?.element_token
    ? { token: el.element_token, elements: sc?.elements?.length ?? 0 }
    : undefined;
}

async function textAreaValue(pid: number, windowId: number): Promise<string | undefined> {
  const reply = await callReply("get_window_state", {
    pid,
    window_id: windowId,
    max_elements: 512,
  });
  const sc = reply.result?.structuredContent as { elements?: AxElement[] } | undefined;
  const el = (sc?.elements ?? []).find((e) => e.role === "AXTextArea");
  return el?.value;
}

// ── targets ──────────────────────────────────────────────────────────────

const spawnedPids: number[] = [];

function osa(script: string): string {
  const r = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

function frontmostName(): string {
  return osa(
    'tell application "System Events" to get name of first process whose frontmost is true',
  );
}

function frontmostPid(): number | undefined {
  const out = osa(
    'tell application "System Events" to get unix id of first process whose frontmost is true',
  );
  const pid = Number(out);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function boundsNear(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    Math.abs(a.x - b.x) <= 8 &&
    Math.abs(a.y - b.y) <= 8 &&
    Math.abs(a.width - b.width) <= 8 &&
    Math.abs(a.height - b.height) <= 8
  );
}

interface ShieldPanel {
  id: number;
  layer: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/** Shield panels via CGWindowList (all layers) — the driver's list_windows
 * only reports layer-0 windows, so the statusBar-level mask needs space-ctl. */
async function shieldPanels(): Promise<ShieldPanel[]> {
  if (!existsSync(SPACE_CTL)) return [];
  const out = spawnSync("pgrep", ["-f", "appsnap-helper --shield"], {
    encoding: "utf8",
  }).stdout;
  const pids = out?.split("\n").map(Number).filter(Boolean) ?? [];
  const panels: ShieldPanel[] = [];
  for (const pid of pids) {
    const list =
      spawnSync(SPACE_CTL, ["windows", "--pid", String(pid)], {
        encoding: "utf8",
      }).stdout ?? "";
    for (const line of list.split("\n")) {
      const m = line.match(
        /^window (\d+) pid=\d+ layer=(-?\d+) x=(-?\d+) y=(-?\d+) w=(\d+) h=(\d+)/,
      );
      if (m)
        panels.push({
          id: Number(m[1]),
          layer: Number(m[2]),
          bounds: {
            x: Number(m[3]),
            y: Number(m[4]),
            width: Number(m[5]),
            height: Number(m[6]),
          },
        });
    }
  }
  return panels;
}

/** Switch the active Space — prefer the instant (animation-free) path, fall
 * back to the animated `set-current` when the SLS update-gate symbols are
 * absent. Returns the command's stdout for the `verified=1` check. */
function switchSpace(spaceId: number | string): string {
  for (const cmd of ["set-current-instant", "set-current"]) {
    const out = spawnSync(SPACE_CTL, [cmd, String(spaceId)], { encoding: "utf8" }).stdout ?? "";
    if (/verified=1/.test(out)) return out;
  }
  return "";
}

async function launchTextEdit(extra: string[] = []): Promise<number | undefined> {
  const before = new Set(
    spawnSync("pgrep", ["-x", "TextEdit"], { encoding: "utf8" })
      .stdout?.split("\n")
      .map(Number)
      .filter(Boolean) ?? [],
  );
  spawnSync("open", [
    ...extra,
    "-n",
    "-a",
    "TextEdit",
    "--args",
    "-ApplePersistenceIgnoreState",
    "YES",
  ]);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const now =
      spawnSync("pgrep", ["-x", "TextEdit"], { encoding: "utf8" })
        .stdout?.split("\n")
        .map(Number)
        .filter(Boolean) ?? [];
    const fresh = now.find((p) => !before.has(p));
    if (fresh) {
      spawnedPids.push(fresh);
      return fresh;
    }
  }
  return undefined;
}

async function windowOfPid(pid: number): Promise<WinInfo | undefined> {
  for (let i = 0; i < 20; i++) {
    const candidates = (await listWindows(pid))
      .filter((w) => w.pid === pid && w.title.startsWith("Untitled"))
      .sort((a, b) => (a.z_index ?? 999) - (b.z_index ?? 999));
    if (candidates[0]) return candidates[0];
    await new Promise((r) => setTimeout(r, 400));
  }
  return undefined;
}

// ── main ─────────────────────────────────────────────────────────────────

capability = randomBytes(32).toString("base64url");
const shieldHost = existsSync(APPSNAP) ? new ComputerShield({ helperPath: APPSNAP }) : undefined;
const escArmEvents: boolean[] = [];
let escMonitor: EscapeKillSwitchMonitor | undefined;
const host = new CuaDriverHost({
  binaryPath: DRIVER,
  bundleId: "com.synara.cua-canary",
  capability,
  setup: async () => {},
  ...(shieldHost ? { shield: shieldHost } : {}),
  onInputMonitorArmedChange: (armed: boolean) => {
    escArmEvents.push(armed);
    escMonitor?.setArmed(armed);
  },
});
if (existsSync(APPSNAP)) {
  escMonitor = new EscapeKillSwitchMonitor({
    helperPath: APPSNAP,
    onEscape: () => {
      host.emergencyStopInput();
    },
    onError: (m) => log(`esc-monitor: ${m}`),
  });
  escMonitor.start();
}

let failures = 0;
let skips = 0;
const t0 = Date.now();

try {
  if (!existsSync(DRIVER)) {
    console.error(`packaged driver missing: ${DRIVER}`);
    process.exit(1);
  }
  endpoint = await host.listen();
  log(`host ${endpoint}`);

  // Operator setup: a TextEdit doc the "human" owns and stays frontmost in.
  // Baseline = this doc frontmost; any agent-caused deviation flags as theft.
  const pidOp = await launchTextEdit(["-g"]);
  const opWin = pidOp ? await windowOfPid(pidOp) : undefined;
  if (opWin) {
    osa(
      `tell application "System Events" to tell (first process whose unix id is ${opWin.pid}) to set frontmost to true`,
    );
    await new Promise((r) => setTimeout(r, 900));
  }
  if (!existsSync(SPACE_CTL)) {
    spawnSync("sh", [join(root, "scripts/computer-use-fixtures/build-space-ctl.sh")], {
      stdio: quiet ? "pipe" : "inherit",
    });
  }
  const probeStarted = startProbe(SENTINEL);
  log(
    `probe ${probeStarted ? `up @${probeMetaHz || "?"}hz` : "UNAVAILABLE (rows needing theft coverage will skip)"}`,
  );
  const operatorFront = frontmostName();
  log(`operator front: ${operatorFront} (pid ${pidOp})`);

  // ── launch-isolation ──
  let pidVisible: number | undefined;
  {
    const t = Date.now();
    pidVisible = await launchTextEdit(["-g"]);
    const front = frontmostName();
    const win = pidVisible ? await windowOfPid(pidVisible) : undefined;
    if (wanted("launch-isolation")) {
      if (pidVisible && win && front === operatorFront)
        row(
          "launch-isolation",
          "pass",
          `open -g TextEdit pid ${pidVisible}; front stayed ${front}`,
          { pid: pidVisible, window: win.window_id, front },
          Date.now() - t,
        );
      else if (pidVisible && win)
        row(
          "launch-isolation",
          "fail",
          `front moved ${operatorFront}→${front}`,
          { pid: pidVisible, front },
          Date.now() - t,
        );
      else
        row(
          "launch-isolation",
          "fail",
          "no fresh TextEdit pid/window after open -g",
          { pidVisible, win: win?.window_id },
          Date.now() - t,
        );
    }
  }

  // ── visible-nonkey-write ──
  if (wanted("visible-nonkey-write")) {
    const t = Date.now();
    const win = pidVisible ? await windowOfPid(pidVisible) : undefined;
    const target = win ? await textAreaToken(win.pid, win.window_id) : undefined;
    if (win && target) {
      const value = `${SENTINEL}-visible`;
      const res = await callReply("set_value", {
        pid: win.pid,
        window_id: win.window_id,
        element_token: target.token,
        value,
      });
      const effect =
        (res.result?.structuredContent as { effect?: string } | undefined)?.effect ??
        (res.result as { effect?: string } | undefined)?.effect;
      const readback = await textAreaValue(win.pid, win.window_id);
      const ok = replyOk(res) && readback === value;
      row(
        "visible-nonkey-write",
        ok ? "pass" : "fail",
        `effect=${effect} readback=${readback === value ? "exact" : JSON.stringify(readback)?.slice(0, 80)}`,
        {
          effect,
          readback,
          reply: ok ? undefined : JSON.stringify(res).slice(0, 400),
        },
        Date.now() - t,
      );
    } else
      row(
        "visible-nonkey-write",
        "skipped",
        win ? "no AXTextArea token" : "no window",
        { win: win?.window_id, elements: target?.elements },
        Date.now() - t,
      );
  }

  // ── hidden-write ──
  if (wanted("hidden-write")) {
    const t = Date.now();
    const pid = await launchTextEdit(["-j"]);
    const win = pid ? await windowOfPid(pid) : undefined;
    const target = win ? await textAreaToken(win.pid, win.window_id) : undefined;
    if (win && target) {
      const value = `${SENTINEL}-hidden`;
      const res = await callReply("set_value", {
        pid: win.pid,
        window_id: win.window_id,
        element_token: target.token,
        value,
      });
      const readback = await textAreaValue(win.pid, win.window_id);
      const ok = replyOk(res) && readback === value;
      row(
        "hidden-write",
        ok ? "pass" : "fail",
        `is_on_screen=${win.is_on_screen} readback=${readback === value ? "exact" : "mismatch"}`,
        {
          visible: win.is_on_screen,
          elements: target.elements,
          readback,
          reply: ok ? undefined : JSON.stringify(res).slice(0, 400),
        },
        Date.now() - t,
      );
    } else
      row(
        "hidden-write",
        win ? "fail" : "skipped",
        win ? "hidden window found but no AXTextArea token" : "open -j produced no listable window",
        { pid, win: win?.window_id, elements: target?.elements },
        Date.now() - t,
      );
  }

  // ── minimized-write ──
  if (wanted("minimized-write")) {
    const t = Date.now();
    const pid = await launchTextEdit(["-g"]);
    const win = pid ? await windowOfPid(pid) : undefined;
    if (win) {
      await callReply("set_window_minimized", {
        pid: win.pid,
        window_id: win.window_id,
        minimized: true,
      }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1200));
      const min = (await listWindows(win.pid)).find((w) => w.window_id === win.window_id);
      const minimizedObserved =
        min?.minimized ?? (min?.is_on_screen === false ? "off-screen" : undefined);
      const target = await textAreaToken(win.pid, win.window_id);
      if (target) {
        const value = `${SENTINEL}-minimized`;
        const res = await callReply("set_value", {
          pid: win.pid,
          window_id: win.window_id,
          element_token: target.token,
          value,
        });
        const readback = await textAreaValue(win.pid, win.window_id);
        const ok = replyOk(res) && readback === value;
        row(
          "minimized-write",
          ok ? "pass" : "fail",
          `minimized=${min?.minimized ?? minimizedObserved} readback=${readback === value ? "exact" : "mismatch"}`,
          {
            minimized: min?.minimized,
            isOnScreen: min?.is_on_screen,
            readback,
            reply: ok ? undefined : JSON.stringify(res).slice(0, 400),
          },
          Date.now() - t,
        );
      } else
        row(
          "minimized-write",
          "skipped",
          "minimized window produced no AXTextArea token",
          { minimized: min?.minimized, isOnScreen: min?.is_on_screen },
          Date.now() - t,
        );
    } else row("minimized-write", "skipped", "no second TextEdit window", { pid }, Date.now() - t);
  }

  // ── concurrent-writes ──
  if (wanted("concurrent-writes")) {
    const t = Date.now();
    const pids = await Promise.all([launchTextEdit(["-g"]), launchTextEdit(["-g"])]);
    const targets = (
      await Promise.all(
        [pidVisible, ...pids]
          .filter((p): p is number => typeof p === "number")
          .map(async (p) => {
            const w = await windowOfPid(p);
            const tok = w ? await textAreaToken(w.pid, w.window_id) : undefined;
            return w && tok ? { w, tok } : undefined;
          }),
      )
    ).filter((x): x is { w: WinInfo; tok: { token: string; elements: number } } => !!x);
    if (targets.length >= 3) {
      const writes = targets.map(({ w, tok }, i) =>
        callReply("set_value", {
          pid: w.pid,
          window_id: w.window_id,
          element_token: tok.token,
          value: `${SENTINEL}-conc-${i}`,
        }),
      );
      const results = await Promise.all(writes);
      const readbacks = await Promise.all(
        targets.map(({ w }) => textAreaValue(w.pid, w.window_id)),
      );
      const ok =
        results.every(replyOk) && readbacks.every((rb, i) => rb === `${SENTINEL}-conc-${i}`);
      row(
        "concurrent-writes",
        ok ? "pass" : "fail",
        `${targets.length} targets, readbacks ${readbacks.filter((rb, i) => rb === `${SENTINEL}-conc-${i}`).length}/${targets.length} exact`,
        { readbacks },
        Date.now() - t,
      );
    } else
      row(
        "concurrent-writes",
        "skipped",
        `only ${targets.length}/3 targets resolved`,
        { targets: targets.length },
        Date.now() - t,
      );
  }

  // ── operator-typing (CGEvent into the standing front doc while agent writes hidden) ──
  if (wanted("operator-typing")) {
    const t = Date.now();
    const pidAgent = await launchTextEdit(["-j"]);
    const agentWin = pidAgent ? await windowOfPid(pidAgent) : undefined;
    const agentTok = agentWin ? await textAreaToken(agentWin.pid, agentWin.window_id) : undefined;
    if (opWin && agentWin && agentTok) {
      const humanText = "HUMAN-OPERATOR-TYPING";
      const agentText = `${SENTINEL}-bgagent`;
      const typeSim = spawn("osascript", [
        "-e",
        `tell application "System Events" to repeat with c in characters of "${humanText}"
  keystroke c
  delay 0.05
end repeat`,
      ]);
      await new Promise((r) => setTimeout(r, 250));
      const res = await callReply("set_value", {
        pid: agentWin.pid,
        window_id: agentWin.window_id,
        element_token: agentTok.token,
        value: agentText,
      });
      await new Promise((r) => typeSim.once("exit", r));
      await new Promise((r) => setTimeout(r, 500));
      const opValue = await textAreaValue(opWin.pid, opWin.window_id);
      const agentValue = await textAreaValue(agentWin.pid, agentWin.window_id);
      const ok =
        replyOk(res) &&
        agentValue === agentText &&
        typeof opValue === "string" &&
        opValue.includes(humanText) &&
        !opValue.includes("bgagent");
      row(
        "operator-typing",
        ok ? "pass" : "fail",
        `front doc got human-only=${opValue?.includes(humanText) && !opValue.includes("bgagent")}; hidden doc exact=${agentValue === agentText}`,
        { opValue: opValue?.slice(0, 120), agentValue },
        Date.now() - t,
      );
    } else
      row(
        "operator-typing",
        "skipped",
        "targets unresolved",
        {
          opWin: opWin?.window_id,
          agentWin: agentWin?.window_id,
          tok: !!agentTok,
        },
        Date.now() - t,
      );
  }

  // ── hidden-launch-default (manager seam: absent hidden → invisible) ──
  // Drives the real product path — ComputerManager.launchApp with no
  // options → CuaComputerBackend → driver launch_app — and asserts the
  // produced window is off-screen with the operator front unchanged.
  if (wanted("hidden-launch-default")) {
    const t = Date.now();
    let backend: CuaComputerBackend | undefined;
    let manager: ComputerManager | undefined;
    try {
      backend = new CuaComputerBackend({ endpoint, capability });
      manager = new ComputerManager({ backend });
      const frontBefore = frontmostPid();
      // A running instance gets reused by `open` semantics — no new window.
      // Calculator launches are guaranteed-fresh here because the harness
      // only spawns them through this row; quit any strays first.
      for (const stray of (
        spawnSync("pgrep", ["-x", "Calculator"], { encoding: "utf8" }).stdout ?? ""
      )
        .split("\n")
        .map(Number)
        .filter(Boolean))
        spawnSync("kill", [String(stray)]);
      await new Promise((r) => setTimeout(r, 600));
      const launch = await manager.launchApp("live-cert-hidden-default", "Calculator");
      let launchPid = launch.window?.pid;
      let winNum = Number(/^cua:\d+:(\d+)$/.exec(launch.window?.id ?? "")?.[1]);
      let listed: WinInfo | undefined;
      for (let i = 0; i < 20 && launchPid === undefined; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const calcWins = (await listWindows()).filter((w) => w.app_name?.includes("Calculator"));
        const fresh = calcWins.sort((a, b) => (a.z_index ?? 999) - (b.z_index ?? 999));
        if (fresh[0]) {
          launchPid = fresh[0].pid;
          winNum = fresh[0].window_id;
          listed = fresh[0];
          break;
        }
      }
      if (launchPid) spawnedPids.push(launchPid);
      if (launchPid !== undefined && listed === undefined) {
        const candidates = (await listWindows(launchPid)).sort(
          (a, b) => (a.z_index ?? 999) - (b.z_index ?? 999),
        );
        listed =
          (Number.isInteger(winNum)
            ? candidates.find((w) => w.window_id === winNum)
            : candidates[0]) ?? candidates[0];
        winNum = listed?.window_id ?? winNum;
      }
      const winPid = launchPid;
      const frontAfter = frontmostPid();
      const offScreen = listed?.is_on_screen === false;
      const ok = winPid !== undefined && offScreen === true && frontAfter === frontBefore;
      row(
        "hidden-launch-default",
        ok ? "pass" : "fail",
        `manager.launchApp(no opts) → pid ${winPid} on_screen=${listed?.is_on_screen} front ${frontBefore}→${frontAfter}`,
        {
          launch: JSON.stringify(launch).slice(0, 300),
          launchPid,
          winNum,
          listed,
          frontBefore,
          frontAfter,
        },
        Date.now() - t,
      );
    } catch (e) {
      row(
        "hidden-launch-default",
        "fail",
        String(e).slice(0, 200),
        { error: String(e) },
        Date.now() - t,
      );
    } finally {
      await manager?.dispose().catch(() => undefined);
      backend?.dispose?.();
    }
  }

  // ── chromium-semantic (Electron-class real app) ──
  // Real Google Chrome: hidden launch → Chromium self-unhides on startup →
  // set_app_visibility re-asserts hidden → get_window_state must return a
  // populated AX tree with NO external enablement (the driver flips
  // AXManualAccessibility/AXEnhancedUserInterface itself, once per process
  // lifetime) → set_value on the omnibox with value readback → operator
  // front unchanged throughout.
  if (wanted("chromium-semantic")) {
    const t = Date.now();
    try {
      const frontBefore = frontmostPid();
      for (const stray of (
        spawnSync("pgrep", ["-x", "Google Chrome"], { encoding: "utf8" }).stdout ?? ""
      )
        .split("\n")
        .map(Number)
        .filter(Boolean))
        spawnSync("kill", [String(stray)]);
      await new Promise((r) => setTimeout(r, 800));
      // Chromium claims AX-focus on its default-focused element (the
      // omnibox on a new tab) as soon as the driver materializes the AX
      // tree — which can begin inside launch_app's window-readiness wait —
      // and again on the written element during set_value. These are
      // deliberate focusedPid excursions inside the background app while
      // frontmost/keyWin stay the operator's. Exempt the whole row's
      // interaction span; the row asserts the real invariants (front
      // unchanged + exact readback) and records the span as evidence.
      const span = exemptStart();
      const launch = await callReply("launch_app", {
        name: "Google Chrome",
        hidden: true,
      });
      const chromePid = (launch.result?.structuredContent as { pid?: number })?.pid;
      if (chromePid) spawnedPids.push(chromePid);
      // Chrome needs real startup time before its window + AX tree exist.
      let win: WinInfo | undefined;
      for (let i = 0; i < 24 && !win; i++) {
        await new Promise((r) => setTimeout(r, 500));
        win = (await listWindows(chromePid)).find((w) => (w.title ?? "").length > 0);
      }
      if (!chromePid || !win) {
        row(
          "chromium-semantic",
          "fail",
          `launch ok=${replyOk(launch)} pid=${chromePid} win=${win?.window_id}`,
          { launch: JSON.stringify(launch).slice(0, 300) },
          Date.now() - t,
        );
      } else {
        // Chromium posts unhide when startup completes — re-assert hidden.
        // A single shot is racy: Chrome can unhide again after it (delayed
        // session restore, second startup beat), which is exactly what the
        // 2026-09-18 flake showed — the window stayed on screen and the
        // omnibox write opened a real frontmost window. Re-assert until the
        // window reports off-screen, bounded so a genuine hide failure
        // still surfaces.
        let rehidden: WinInfo | undefined;
        for (let i = 0; i < 8; i++) {
          await callReply("set_app_visibility", {
            pid: chromePid,
            hidden: true,
          }).catch(() => undefined);
          await new Promise((r) => setTimeout(r, 1000));
          rehidden = (await listWindows(chromePid)).find((w) => w.window_id === win.window_id);
          if (rehidden && !rehidden.is_on_screen) break;
        }
        // Elements must appear via the driver's own enablement — nothing
        // outside the driver touches AXManualAccessibility here.
        let elements: Array<{
          role?: string;
          element_token?: string;
          label?: string;
          value?: string;
        }> = [];
        for (let i = 0; i < 8 && elements.length === 0; i++) {
          const st = await callReply("get_window_state", {
            pid: chromePid,
            window_id: win.window_id,
            max_elements: 400,
          });
          elements =
            (st.result?.structuredContent as { elements?: typeof elements })?.elements ?? [];
          if (elements.length === 0) await new Promise((r) => setTimeout(r, 1500));
        }
        const field = elements.find(
          (e) => /AXTextField|AXTextArea|AXComboBox/.test(String(e.role)) && e.element_token,
        );
        const value = `${SENTINEL}-chromium`;
        const write = field?.element_token
          ? await callReply("set_value", {
              pid: chromePid,
              window_id: win.window_id,
              element_token: field.element_token,
              value,
            })
          : undefined;
        await new Promise((r) => setTimeout(r, 1200));
        const readState = await callReply("get_window_state", {
          pid: chromePid,
          window_id: win.window_id,
          max_elements: 400,
        }).catch(() => undefined);
        exemptEnd(span);
        const readEls =
          (
            readState?.result?.structuredContent as {
              elements?: typeof elements;
            }
          )?.elements ?? [];
        const readback = readEls.find(
          (e) =>
            /AXTextField|AXTextArea|AXComboBox/.test(String(e.role)) &&
            typeof e.value === "string" &&
            e.value.length > 0,
        )?.value;
        const frontAfter = frontmostPid();
        const ok = replyOk(write) === true && readback === value && frontAfter === frontBefore;
        row(
          "chromium-semantic",
          ok ? "pass" : "fail",
          `pid=${chromePid} on_screen=${rehidden?.is_on_screen} elements=${elements.length} field=${field?.label ?? "none"} readback=${readback === value ? "exact" : JSON.stringify(readback)?.slice(0, 40)} front ${frontBefore}→${frontAfter}`,
          {
            chromePid,
            win: win.window_id,
            rehiddenOnScreen: rehidden?.is_on_screen,
            elements: elements.length,
            field: field?.label,
            readback,
            axFocusExcursionExempted: true,
            exemptSpan: { start: span, end: Date.now() - probeStartWall },
            frontBefore,
            frontAfter,
            write: write ? JSON.stringify(write).slice(0, 300) : undefined,
          },
          Date.now() - t,
        );
      }
    } catch (e) {
      row(
        "chromium-semantic",
        "fail",
        String(e).slice(0, 200),
        { error: String(e) },
        Date.now() - t,
      );
    }
  }

  // ── grant-lifecycle (durable per-app always-allow) ──
  // The real product seam: manager.admitDrivenApp — the same call
  // computerTools.ts:1881 makes — hits the second-app boundary. First app
  // records free; the second fires the wired approval handler, which mints
  // a durable grant via grantIdentityForAppKey → computerGrantOfferFor →
  // createComputerGrants (the same path the approval card's respond uses).
  // A fresh thread then drives the granted app silently; revoke re-arms
  // the prompt. Grant store is isolated in a temp dir — never the user's.
  if (wanted("grant-lifecycle")) {
    const t = Date.now();
    let backend: CuaComputerBackend | undefined;
    let manager: ComputerManager | undefined;
    let calcPid: number | undefined;
    try {
      const stateDir = join(
        process.env.TMPDIR ?? "/tmp",
        `live-cert-grants-${SENTINEL.toLowerCase()}`,
      );
      await mkdir(stateDir, { recursive: true });
      for (const stray of (
        spawnSync("pgrep", ["-x", "Calculator"], { encoding: "utf8" }).stdout ?? ""
      )
        .split("\n")
        .map(Number)
        .filter(Boolean))
        spawnSync("kill", [String(stray)]);
      await new Promise((r) => setTimeout(r, 600));
      spawnSync("open", ["-j", "-a", "Calculator"]);
      for (let i = 0; i < 20 && calcPid === undefined; i++) {
        await new Promise((r) => setTimeout(r, 400));
        calcPid =
          Number(
            (spawnSync("pgrep", ["-nx", "Calculator"], { encoding: "utf8" }).stdout ?? "").trim(),
          ) || undefined;
      }
      if (calcPid) spawnedPids.push(calcPid);

      backend = new CuaComputerBackend({ endpoint, capability });
      manager = new ComputerManager({
        backend,
        controlStatePath: join(stateDir, "control-state.json"),
      });
      const prompts: string[] = [];
      const grantFor: string[] = [];
      manager.setSecondAppApprovalHandler(async (input) => {
        prompts.push(`${input.threadId}:${input.app}`);
        // Mint inside the answer — the same grant.create path the approval
        // card's respond() runs when the user picks always-allow.
        const identity = await manager!.grantIdentityForAppKey(input.app);
        const classes = ["lifecycle"] as const;
        if (identity) {
          const offer = manager!.computerGrantOfferFor({
            apps: [identity],
            classes: [...classes],
            includesUnattributedTarget: false,
          });
          if (offer) {
            manager!.createComputerGrants({
              offer: {
                apps: offer.apps,
                classes: offer.classes,
                scopes: offer.scopes,
              },
              choice: { classes: [...classes], scope: "app" },
              threadId: input.threadId,
              ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
            });
            grantFor.push(input.app);
          }
        }
        return true;
      });

      const admit = (thread: string, app: string) =>
        manager!.admitDrivenApp(thread, app, {
          grantClasses: ["lifecycle"],
          toolName: "computer_launch_app",
          signal: AbortSignal.timeout(10_000),
        });
      // Thread A: first app free, second app prompts.
      await admit("live-cert-grants-a", "TextEdit");
      await admit("live-cert-grants-a", "Calculator");
      // Thread B: durable grant covers the same app — silent.
      await admit("live-cert-grants-b", "Calculator");
      const listed = manager.listComputerGrants().grants;
      const calcGrant = listed.find((g) =>
        `${g.app?.name ?? ""}${g.app?.bundleId ?? ""}`.toLowerCase().includes("calculator"),
      );
      // Revoke → a fresh thread prompts again. Thread C drives a first app
      // first (the first app per thread always records free) so Calculator
      // is its second-app boundary.
      if (calcGrant) manager.revokeComputerGrant(calcGrant.id);
      await admit("live-cert-grants-c", "TextEdit");
      await admit("live-cert-grants-c", "Calculator");

      const ok =
        prompts.length === 2 &&
        prompts[0] === "live-cert-grants-a:Calculator" &&
        prompts[1] === "live-cert-grants-c:Calculator" &&
        grantFor.length === 2 &&
        calcGrant !== undefined;
      row(
        "grant-lifecycle",
        ok ? "pass" : "fail",
        `prompts=${JSON.stringify(prompts)} minted=${grantFor.length} listed=${listed.length} revoked=${calcGrant !== undefined}`,
        {
          prompts,
          grantFor,
          grant: calcGrant,
          listedCount: listed.length,
          identityBundleId: calcGrant?.app?.bundleId,
        },
        Date.now() - t,
      );
    } catch (e) {
      row("grant-lifecycle", "fail", String(e).slice(0, 200), { error: String(e) }, Date.now() - t);
    } finally {
      await manager?.dispose().catch(() => undefined);
      backend?.dispose?.();
      if (calcPid) spawnSync("kill", [String(calcPid)]);
    }
  }

  // ── locked-use-reauth: lock/sleep interruption revokes standing consent ──
  if (wanted("locked-use-reauth")) {
    const t = Date.now();
    let backend: CuaComputerBackend | undefined;
    let manager: ComputerManager | undefined;
    const pid = await launchTextEdit(["-j"]);
    const lockThreads = ["live-cert-lock-a", "live-cert-lock-b", "live-cert-lock-c"];
    try {
      const stateDir = join(
        process.env.TMPDIR ?? "/tmp",
        `live-cert-lock-${SENTINEL.toLowerCase()}`,
      );
      await mkdir(stateDir, { recursive: true });
      backend = new CuaComputerBackend({ endpoint, capability });
      manager = new ComputerManager({
        backend,
        controlStatePath: join(stateDir, "control-state.json"),
      });
      const win = pid ? await windowOfPid(pid) : undefined;
      const target = win ? await textAreaToken(win.pid, win.window_id) : undefined;

      // The first reply only sets the backend's interruption baseline — an
      // advance is the proof a lock/resume cycle ran, so observe pre-pause.
      // listApps hits call()→host() unconditionally; availability/listWindows
      // cache their snapshot for a second and would not observe the counter.
      await backend.listApps().catch(() => undefined);

      const prompts: string[] = [];
      const ask = (threadId: string, decision: "accept" | "decline", pendingId?: { id?: string }) =>
        computerApprovalGate.requestTask({
          threadId,
          turnId: "turn-1",
          signal: AbortSignal.timeout(15_000),
          publish: async (requestId, dismissal) => {
            // request() publishes a second time with the settled decision as
            // a best-effort dismissal — only the undefined-decision call is
            // the prompt.
            if (dismissal !== undefined) return;
            prompts.push(`${threadId}:${decision}`);
            if (pendingId) pendingId.id = requestId;
            else computerApprovalGate.respond(threadId, requestId, decision);
          },
        });

      // Thread A: accept → standing task grant; a second call in the same
      // turn rides it silently.
      const aGranted = await ask("live-cert-lock-a", "accept");
      const aCached = await ask("live-cert-lock-a", "accept");
      const aSilent = prompts.filter((p) => p.startsWith("live-cert-lock-a")).length === 1;

      // Thread B: decline — a refusal is not authority a lock must break.
      const bDeclined = (await ask("live-cert-lock-b", "decline")) === false;

      // Thread C: a prompt left pending across the interruption — the answer
      // that arrives afterward already postdates it, so it IS the re-auth.
      const pendingId: { id?: string } = {};
      const cPending = ask("live-cert-lock-c", "accept", pendingId);
      for (let i = 0; i < 40 && pendingId.id === undefined; i++)
        await new Promise((r) => setTimeout(r, 50));

      // The interruption itself: the exact entry points the desktop
      // lifecycle monitor calls on lock/sleep/session switch.
      await host.pauseDesktop("screen-lock");
      // The input half of locked-use: mutations refuse while paused.
      const pausedReply =
        win && target
          ? await callReply("set_value", {
              pid: win.pid,
              window_id: win.window_id,
              element_token: target.token,
              value: `${SENTINEL}-while-locked`,
            }).catch((e) => ({ ok: false, error: String(e) }) as CuaReply)
          : undefined;
      const pausedRefused = JSON.stringify(pausedReply).includes("desktop_input_paused");
      host.resumeDesktop("screen-lock");

      // Any reply now carries the advanced counter → the backend fires
      // desktop-interrupted → the manager revokes standing task grants.
      await backend.listApps().catch(() => undefined);

      // Post-interruption: thread A's same-turn call must re-publish (the
      // re-auth half); answering it restores operation.
      const aReauth = await ask("live-cert-lock-a", "accept");
      const aReprompted = prompts.filter((p) => p.startsWith("live-cert-lock-a")).length === 2;

      // Thread B stays declined with no new prompt — no nag on unlock.
      const bAfter = await computerApprovalGate.requestTask({
        threadId: "live-cert-lock-b",
        turnId: "turn-1",
        signal: AbortSignal.timeout(15_000),
        publish: async (requestId, dismissal) => {
          if (dismissal !== undefined) return;
          prompts.push("live-cert-lock-b:unexpected");
          computerApprovalGate.respond("live-cert-lock-b", requestId, "decline");
        },
      });
      const bNoReprompt =
        bAfter === false && prompts.filter((p) => p.startsWith("live-cert-lock-b")).length === 1;

      // Thread C's surviving prompt settles the post-interruption consent.
      if (pendingId.id !== undefined)
        computerApprovalGate.respond("live-cert-lock-c", pendingId.id, "accept");
      const cGranted = (await cPending) === true;

      // And the resume half: after a fresh model observation the desktop
      // takes input again — the full unlock path end to end.
      let resumedOk = false;
      if (win && target) {
        for (let i = 0; i < 10 && !resumedOk; i++) {
          const obs = await cuaRequest<CuaReply>(
            endpoint,
            {
              method: "call",
              name: "get_window_state",
              args: { pid: win.pid, window_id: win.window_id, max_elements: 8 },
              capability,
              modelObservation: true,
            },
            { timeoutMs: 10_000, mutation: true },
          ).catch(() => undefined);
          const sc = obs?.result?.structuredContent as { elements?: unknown[] } | undefined;
          if (!obs?.ok || !Array.isArray(sc?.elements)) {
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }
          const after = await callReply("set_value", {
            pid: win.pid,
            window_id: win.window_id,
            element_token: target.token,
            value: `${SENTINEL}-post-unlock`,
          });
          resumedOk =
            replyOk(after) &&
            (await textAreaValue(win.pid, win.window_id)) === `${SENTINEL}-post-unlock`;
          if (!resumedOk) await new Promise((r) => setTimeout(r, 400));
        }
      }

      const ok =
        aGranted === true &&
        aCached === true &&
        aSilent &&
        bDeclined &&
        pausedRefused &&
        aReauth === true &&
        aReprompted &&
        bNoReprompt &&
        cGranted &&
        resumedOk;
      row(
        "locked-use-reauth",
        ok ? "pass" : "fail",
        `grant=${aGranted && aCached && aSilent} pausedRefused=${pausedRefused} reauth=${aReprompted && aReauth} declineHeld=${bNoReprompt} pendingSurvived=${cGranted} resumed=${resumedOk}`,
        {
          prompts,
          aGranted,
          aCached,
          aSilent,
          bDeclined,
          pausedReply: JSON.stringify(pausedReply).slice(0, 240),
          aReauth,
          aReprompted,
          bAfter,
          bNoReprompt,
          cGranted,
          resumedOk,
        },
        Date.now() - t,
      );
    } catch (e) {
      row(
        "locked-use-reauth",
        "fail",
        String(e).slice(0, 200),
        { error: String(e) },
        Date.now() - t,
      );
    } finally {
      for (const thread of lockThreads) computerApprovalGate.cancelThread(thread);
      host.resumeDesktop("screen-lock");
      // Leave the observation gate clear for later rows: pauseDesktop sets
      // desktopObservationRequired, which only a modelObservation clears.
      if (pid) {
        const win = await windowOfPid(pid).catch(() => undefined);
        if (win) {
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 400));
            const obs = await cuaRequest<CuaReply>(
              endpoint,
              {
                method: "call",
                name: "get_window_state",
                args: {
                  pid: win.pid,
                  window_id: win.window_id,
                  max_elements: 8,
                },
                capability,
                modelObservation: true,
              },
              { timeoutMs: 10_000, mutation: true },
            ).catch(() => undefined);
            const sc = obs?.result?.structuredContent as { elements?: unknown[] } | undefined;
            if (obs?.ok && Array.isArray(sc?.elements)) break;
          }
        }
      }
      await manager?.dispose().catch(() => undefined);
      backend?.dispose?.();
    }
  }

  // ── space-roundtrip (needs a second managed desktop) ──
  if (wanted("space-roundtrip")) {
    const t = Date.now();
    if (!existsSync(SPACE_CTL)) {
      spawnSync("sh", [join(root, "scripts/computer-use-fixtures/build-space-ctl.sh")], {
        stdio: "pipe",
      });
    }
    if (!existsSync(SPACE_CTL)) {
      row("space-roundtrip", "skipped", "space-ctl build failed", undefined, Date.now() - t);
    } else {
      const list = spawnSync(SPACE_CTL, ["list"], { encoding: "utf8" }).stdout ?? "";
      const desktops = [...list.matchAll(/space (\d+) type=0/g)].map((m) => Number(m[1]));
      const active = Number(
        (spawnSync(SPACE_CTL, ["active-space"], { encoding: "utf8" }).stdout ?? "").match(
          /active space (\d+)/,
        )?.[1],
      );
      const other = desktops.find((d) => d !== active);
      if (other === undefined) {
        row(
          "space-roundtrip",
          "skipped",
          "skipped-single-desktop — one managed desktop space; create a second in Mission Control to enable",
          { desktops, active },
          Date.now() - t,
        );
      } else {
        // Switch to the other desktop, launch there (window lands on it), act, switch back.
        const span = exemptStart();
        const sw1 = switchSpace(other);
        let win: WinInfo | undefined;
        let writeOk = false;
        if (/verified=1/.test(sw1)) {
          const pid = await launchTextEdit(["-g"]);
          win = pid ? await windowOfPid(pid) : undefined;
          const tok = win ? await textAreaToken(win.pid, win.window_id) : undefined;
          if (tok) {
            const res = await callReply("set_value", {
              pid: win!.pid,
              window_id: win!.window_id,
              element_token: tok.token,
              value: `${SENTINEL}-space`,
            });
            writeOk =
              replyOk(res) &&
              (await textAreaValue(win!.pid, win!.window_id)) === `${SENTINEL}-space`;
          }
        }
        const sw2 = switchSpace(active);
        exemptEnd(span);
        const back = /verified=1/.test(sw2);
        const ok = /verified=1/.test(sw1) && writeOk && back;
        row(
          "space-roundtrip",
          ok ? "pass" : "fail",
          `switch ${active}→${other}: ${/verified=1/.test(sw1)}; write: ${writeOk}; back: ${back}`,
          { sw1: sw1.trim(), writeOk, sw2: sw2.trim(), win: win?.window_id },
          Date.now() - t,
        );
      }
    }
  }

  // ── off-space-refusal (only meaningful with ≥2 desktops) ──
  if (wanted("off-space-refusal")) {
    const t = Date.now();
    if (!existsSync(SPACE_CTL)) {
      row("off-space-refusal", "skipped", "space-ctl missing", undefined, Date.now() - t);
    } else {
      const list = spawnSync(SPACE_CTL, ["list"], { encoding: "utf8" }).stdout ?? "";
      const desktops = [...list.matchAll(/space (\d+) type=0/g)].map((m) => Number(m[1]));
      const active = Number(
        (spawnSync(SPACE_CTL, ["active-space"], { encoding: "utf8" }).stdout ?? "").match(
          /active space (\d+)/,
        )?.[1],
      );
      const other = desktops.find((d) => d !== active);
      if (other === undefined) {
        row("off-space-refusal", "skipped", "skipped-single-desktop", { desktops }, Date.now() - t);
      } else {
        // Launch on the other space, return, then ops must report honestly:
        // either refused (stale/off-space) or verifiably delivered — never
        // a silent success claim that read-back contradicts.
        const span = exemptStart();
        switchSpace(other);
        const pid = await launchTextEdit(["-g"]);
        switchSpace(active);
        exemptEnd(span);
        const win = pid ? await windowOfPid(pid) : undefined;
        const res = win
          ? await callReply("get_window_state", {
              pid: win.pid,
              window_id: win.window_id,
              max_elements: 64,
            })
          : undefined;
        const sc = res?.result?.structuredContent as { elements?: unknown[] } | undefined;
        const elCount = sc?.elements?.length ?? 0;
        let outcome = "unresolved";
        let honest = false;
        if (win) {
          const tok = elCount > 0 ? await textAreaToken(win.pid, win.window_id) : undefined;
          if (tok) {
            const value = `${SENTINEL}-offspace`;
            const wr = await callReply("set_value", {
              pid: win.pid,
              window_id: win.window_id,
              element_token: tok.token,
              value,
            });
            const rb = await textAreaValue(win.pid, win.window_id);
            honest = !replyOk(wr) || rb === value || rb === undefined || rb === null;
            outcome = replyOk(wr)
              ? `verified, readback=${rb === value ? "exact" : rb == null ? "unverifiable(AX-empty)" : "CONTRADICTION"}`
              : `refused (${JSON.stringify(wr).slice(0, 120)})`;
            // Definitive leg: when the driver claims verified but my read-back
            // is inconclusive, switch to the window's Space and read there.
            if (replyOk(wr) && rb !== value) {
              const span2 = exemptStart();
              switchSpace(other);
              await new Promise((r) => setTimeout(r, 1200));
              const rbOnSpace = await textAreaValue(win.pid, win.window_id);
              switchSpace(active);
              await new Promise((r) => setTimeout(r, 800));
              exemptEnd(span2);
              honest = rbOnSpace === value;
              outcome += `; on-space readback=${rbOnSpace === value ? "exact" : JSON.stringify(rbOnSpace)?.slice(0, 60)}`;
            }
          } else outcome = `no element token; elements=${elCount}`;
        }
        const ok = !!win && honest && outcome !== "unresolved";
        row(
          "off-space-refusal",
          ok ? "pass" : win ? "fail" : "skipped",
          win ? `off-space window: elements=${elCount}, write=${outcome}` : "no window",
          { win: win?.window_id, elements: elCount, outcome },
          Date.now() - t,
        );
      }
    }
  }

  // ── screenshot-fresh ──
  if (wanted("screenshot-fresh")) {
    const t = Date.now();
    const win = pidVisible ? await windowOfPid(pidVisible) : undefined;
    if (win) {
      const res = await callReply("get_window_state", {
        pid: win.pid,
        window_id: win.window_id,
        include_screenshot: true,
      });
      const sc = res.result?.structuredContent as
        | {
            screenshot_frame_valid?: boolean;
            screenshot_frame_freshness?: string;
            window_bounds?: unknown;
          }
        | undefined;
      const image = res.result?.content?.find(
        (c) => c.type === "image" && typeof c.data === "string",
      );
      const hasPng = typeof image?.data === "string" && image.data.length > 500;
      const valid = sc?.screenshot_frame_valid !== false;
      const ok = replyOk(res) && hasPng && valid;
      row(
        "screenshot-fresh",
        ok ? "pass" : "fail",
        `png=${hasPng} valid=${valid} freshness=${sc?.screenshot_frame_freshness}`,
        {
          hasPng,
          valid,
          freshness: sc?.screenshot_frame_freshness,
          bounds: sc?.window_bounds,
          pngBytes: image?.data?.length,
        },
        Date.now() - t,
      );
    } else row("screenshot-fresh", "skipped", "no visible window", undefined, Date.now() - t);
  }

  // ── hidden-screenshot ──
  // A never-rendered (hidden) window has a live backing store: screenshots
  // must track content. Assert shot-A ≠ shot-B across a large semantic
  // write — byte-level change detection, no decoder needed — plus
  // frame_valid and dims matching the reported bounds.
  if (wanted("hidden-screenshot")) {
    const t = Date.now();
    const pid = await launchTextEdit(["-j"]);
    const win = pid ? await windowOfPid(pid) : undefined;
    const shot = async () => {
      const res = await callReply("get_window_state", {
        pid: win!.pid,
        window_id: win!.window_id,
        max_elements: 60,
        include_screenshot: true,
      });
      const image = res.result?.content?.find(
        (c) => c.type === "image" && typeof c.data === "string",
      );
      return {
        img: image?.data ?? "",
        sc: res.result?.structuredContent as
          | {
              screenshot_frame_valid?: boolean;
              screenshot_width?: number;
              screenshot_height?: number;
              window_bounds?: { width?: number; height?: number };
              elements?: Array<{ role?: string; element_token?: string }>;
            }
          | undefined,
      };
    };
    if (win) {
      const a = await shot();
      const tok = a.sc?.elements?.find(
        (e) => e.role === "AXTextArea" && e.element_token,
      )?.element_token;
      if (tok) {
        await callReply("set_value", {
          pid: win.pid,
          window_id: win.window_id,
          element_token: tok,
          value: `${SENTINEL}-shot `.repeat(40),
        });
        await new Promise((r) => setTimeout(r, 800));
        const b = await shot();
        const dimsMatch =
          !!b.sc?.window_bounds?.width &&
          b.sc.screenshot_width === b.sc.window_bounds.width &&
          b.sc.screenshot_height === b.sc.window_bounds.height;
        const ok =
          a.img.length > 500 &&
          b.img.length > 500 &&
          a.img !== b.img &&
          b.sc?.screenshot_frame_valid !== false &&
          dimsMatch;
        row(
          "hidden-screenshot",
          ok ? "pass" : "fail",
          `on_screen=${win.is_on_screen} A=${a.img.length}b B=${b.img.length}b changed=${a.img !== b.img} valid=${b.sc?.screenshot_frame_valid} dimsMatch=${dimsMatch}`,
          {
            onScreen: win.is_on_screen,
            aBytes: a.img.length,
            bBytes: b.img.length,
            changed: a.img !== b.img,
            frameValid: b.sc?.screenshot_frame_valid,
            dims: [b.sc?.screenshot_width, b.sc?.screenshot_height],
            bounds: b.sc?.window_bounds,
          },
          Date.now() - t,
        );
      } else
        row(
          "hidden-screenshot",
          "fail",
          "hidden window has no AXTextArea token",
          { win: win.window_id },
          Date.now() - t,
        );
    } else
      row(
        "hidden-screenshot",
        "skipped",
        "open -j produced no listable window",
        { pid },
        Date.now() - t,
      );
  }

  // ── stale-token ──
  if (wanted("stale-token")) {
    const t = Date.now();
    const win = pidVisible ? await windowOfPid(pidVisible) : undefined;
    const res = await callReply("set_value", {
      ...(win ? { pid: win.pid, window_id: win.window_id } : {}),
      element_token: "s99999999:99",
      value: "forged",
    }).catch((e) => ({ ok: false, error: String(e) }) as CuaReply);
    const refusal = JSON.stringify(res);
    const refused = res.ok === false || /stale_element_token|stale|refus/i.test(refusal);
    row(
      "stale-token",
      refused ? "pass" : "fail",
      `forged token → ${refusal.slice(0, 160)}`,
      { reply: res },
      Date.now() - t,
    );
  }

  // ── verify-state ──
  if (wanted("verify-state")) {
    const t = Date.now();
    const win = pidVisible ? await windowOfPid(pidVisible) : undefined;
    if (win) {
      const res = await callReply("verify_state", {
        pid: win.pid,
        window_id: win.window_id,
        expect: [{ element: { selector: { role: "AXTextArea" }, exists: true } }],
      });
      const sc2 = res.result?.structuredContent as
        | { status?: string; stable?: boolean }
        | undefined;
      const verdictOk = replyOk(res) && (sc2?.status === "satisfied" || sc2?.status === "unknown");
      row(
        "verify-state",
        verdictOk ? "pass" : "fail",
        JSON.stringify(sc2 ?? res.result ?? res).slice(0, 200),
        { reply: res },
        Date.now() - t,
      );
    } else row("verify-state", "skipped", "no visible window", undefined, Date.now() - t);
  }

  // ── masked-activation (own-window shield over a real activation excursion) ──
  if (wanted("masked-activation")) {
    const t = Date.now();
    if (!shieldHost) {
      row(
        "masked-activation",
        "skipped",
        "appsnap helper not built — shield host unavailable",
        undefined,
        Date.now() - t,
      );
    } else if (!opWin) {
      row("masked-activation", "skipped", "no operator baseline", undefined, Date.now() - t);
    } else {
      const shieldId = `lc${randomBytes(6).toString("hex")}`;
      let pid: number | undefined;
      let exemptStartMark: number | undefined;
      try {
        pid = await launchTextEdit(["-g"]);
        const win = pid ? await windowOfPid(pid) : undefined;
        if (!win) throw new Error("no masked-activation target window");

        // 1. Engage the mask over the target's frame before any activation.
        const eng = await cuaRequest<CuaReply>(
          endpoint,
          {
            method: "shield",
            args: {
              action: "engage",
              shield_id: shieldId,
              frame: win.bounds,
              window_id: win.window_id,
              pid: win.pid,
              label: "live-cert",
            },
            capability,
          },
          { timeoutMs: 15_000, mutation: true },
        );
        if (!replyOk(eng)) throw new Error(`engage refused: ${JSON.stringify(eng).slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, 500));
        const panels = (await shieldPanels()).filter((p) => boundsNear(p.bounds, win.bounds));

        // 2. Activate the real window under the mask. Deliberate excursion —
        //    exempt the probe span; the row asserts the end-state itself.
        exemptStartMark = exemptStart();
        const raise = await callReply("bring_to_front", {
          pid: win.pid,
          window_id: win.window_id,
        });
        await new Promise((r) => setTimeout(r, 800));
        const frontPid = frontmostPid();
        const panelsDuring = (await shieldPanels()).filter((p) => boundsNear(p.bounds, win.bounds));

        // 3. Semantic write while masked+frontmost.
        const token = await textAreaToken(win.pid, win.window_id);
        const write = token
          ? await callReply("set_value", {
              pid: win.pid,
              window_id: win.window_id,
              element_token: token.token,
              value: `${SENTINEL}-masked`,
            })
          : undefined;
        const value = await textAreaValue(win.pid, win.window_id);

        // 4. Release: panels must physically disappear.
        const rel = await cuaRequest<CuaReply>(
          endpoint,
          {
            method: "shield",
            args: { action: "release", shield_id: shieldId },
            capability,
          },
          { timeoutMs: 10_000, mutation: true },
        );
        await new Promise((r) => setTimeout(r, 600));
        const panelsAfter = (await shieldPanels()).filter((p) => boundsNear(p.bounds, win.bounds));
        exemptEnd(exemptStartMark);
        exemptStartMark = undefined;
        osa(
          `tell application "System Events" to tell (first process whose unix id is ${opWin.pid}) to set frontmost to true`,
        );

        const wrote = value === `${SENTINEL}-masked`;
        const ok =
          panels.length > 0 &&
          replyOk(raise) &&
          frontPid === win.pid &&
          panelsDuring.length > 0 &&
          write !== undefined &&
          replyOk(write) &&
          wrote &&
          replyOk(rel) &&
          panelsAfter.length === 0;
        row(
          "masked-activation",
          ok ? "pass" : "fail",
          `panel=${panels.length} front=${frontPid} (want ${win.pid}) masked=${panelsDuring.length} wrote=${wrote} released=${panelsAfter.length === 0}`,
          {
            engage: eng,
            panels: panels.map((p) => ({
              id: p.id,
              bounds: p.bounds,
              layer: p.layer,
            })),
            raise: JSON.stringify(raise).slice(0, 200),
            frontPid,
            targetPid: win.pid,
            write: JSON.stringify(write).slice(0, 240),
            value,
            release: rel,
            panelsAfter: panelsAfter.map((p) => p.id),
          },
          Date.now() - t,
        );
      } catch (e) {
        if (exemptStartMark !== undefined) exemptEnd(exemptStartMark);
        row(
          "masked-activation",
          "fail",
          String(e).slice(0, 200),
          { error: String(e), pid },
          Date.now() - t,
        );
      } finally {
        await cuaRequest(
          endpoint,
          { method: "shield", args: { action: "release_all" }, capability },
          { timeoutMs: 10_000 },
        ).catch(() => undefined);
        if (opWin)
          osa(
            `tell application "System Events" to tell (first process whose unix id is ${opWin.pid}) to set frontmost to true`,
          );
      }
    }
  }

  // ── escape-kill-switch (synthetic immunity + latch/refuse/rearm) ──
  // Physical hardware Escape cannot be produced from user space on this VM —
  // the monitor's pid==0 filter rejects every postable event by design. What
  // IS certifiable live: (a) synthetic Escape does NOT latch (anti-self-kill),
  // (b) the same emergencyStopInput() entry point onEscape invokes latches,
  //    refuses mutations with escape_emergency_stop, and clears on rearm.
  if (wanted("escape-kill-switch")) {
    const t = Date.now();
    if (!escMonitor) {
      row(
        "escape-kill-switch",
        "skipped",
        "appsnap helper not built — no escape monitor",
        undefined,
        Date.now() - t,
      );
    } else {
      let pid: number | undefined;
      let escWin: WinInfo | undefined;
      try {
        pid = await launchTextEdit(["-g"]);
        const win = pid ? await windowOfPid(pid) : undefined;
        escWin = win;
        if (!win) throw new Error("no escape-row target window");
        const token = await textAreaToken(win.pid, win.window_id);
        if (!token) throw new Error("no AXTextArea on escape-row target");

        // Baseline mutation works; the generation is live so the host should
        // have armed the monitor via onInputMonitorArmedChange.
        const baseline = await callReply("set_value", {
          pid: win.pid,
          window_id: win.window_id,
          element_token: token.token,
          value: `${SENTINEL}-esc-base`,
        });
        const armedByHost = escArmEvents.includes(true);

        // (a) Synthetic immunity: an osascript Escape carries the posting pid
        //     and must be ignored — the very next mutation still lands.
        osa('tell application "System Events" to key code 53');
        await new Promise((r) => setTimeout(r, 900));
        const afterSynthetic = await callReply("set_value", {
          pid: win.pid,
          window_id: win.window_id,
          element_token: token.token,
          value: `${SENTINEL}-esc-after-syn`,
        });
        const immuneOk = replyOk(afterSynthetic);

        // (b) The exact callback the monitor's onEscape wires to.
        const engaged = host.emergencyStopInput();
        const refused = await callReply("set_value", {
          pid: win.pid,
          window_id: win.window_id,
          element_token: token.token,
          value: `${SENTINEL}-esc-refused`,
        }).catch((e) => ({ ok: false, error: String(e) }) as CuaReply);
        const refusalText = JSON.stringify(refused);
        const refusedOk =
          refusalText.includes("escape_emergency_stop") || /escape|stopped/i.test(refusalText);

        const rearm = await cuaRequest<CuaReply>(
          endpoint,
          { method: "rearm", capability },
          { timeoutMs: 10_000 },
        ).catch((e) => ({ ok: false, error: String(e) }) as CuaReply);
        // Rearm requires a fresh desktop observation before the next action;
        // poll it — the generation killed by the stop needs a moment to
        // respawn, and a successful get_window_state clears the gate.
        let token2: { token: string; elements: number } | undefined;
        let afterRearm: CuaReply | undefined;
        let value: string | undefined;
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500));
          // The gate only clears on a *model* observation — the flag the
          // server sets when the agent (not the host) reads the desktop.
          const obs = await cuaRequest<CuaReply>(
            endpoint,
            {
              method: "call",
              name: "get_window_state",
              args: {
                pid: win.pid,
                window_id: win.window_id,
                max_elements: 512,
              },
              capability,
              modelObservation: true,
            },
            { timeoutMs: 15_000, mutation: true },
          ).catch((e) => ({ ok: false, error: String(e) }) as CuaReply);
          const obsSc = obs.result?.structuredContent as { elements?: unknown[] } | undefined;
          token2 = (obsSc?.elements ?? [])
            .map((e) => e as { role?: string; element_token?: string })
            .find((e) => e.role === "AXTextArea" && typeof e.element_token === "string")
            ?.element_token
            ? { token: "", elements: obsSc?.elements?.length ?? 0 }
            : undefined;
          if (!token2) continue;
          const elTok = (obsSc?.elements ?? [])
            .map((e) => e as { role?: string; element_token?: string })
            .find(
              (e) => e.role === "AXTextArea" && typeof e.element_token === "string",
            )?.element_token;
          if (!elTok) continue;
          afterRearm = await callReply("set_value", {
            pid: win.pid,
            window_id: win.window_id,
            element_token: elTok,
            value: `${SENTINEL}-esc-rearmed`,
          });
          value = await textAreaValue(win.pid, win.window_id);
          if (replyOk(afterRearm) && value === `${SENTINEL}-esc-rearmed`) break;
        }
        const rearmedOk = replyOk(afterRearm) && value === `${SENTINEL}-esc-rearmed`;

        const ok = replyOk(baseline) && immuneOk && engaged === true && refusedOk && rearmedOk;
        row(
          "escape-kill-switch",
          ok ? "pass" : "fail",
          `baseline=${replyOk(baseline)} hostArmed=${armedByHost} immune=${immuneOk} engaged=${engaged} refused=${refusedOk} rearmed=${rearmedOk} (physical key unverified — VM)`,
          {
            armedByHost,
            escArmEvents,
            baseline: JSON.stringify(baseline).slice(0, 160),
            afterSynthetic: JSON.stringify(afterSynthetic).slice(0, 200),
            engaged,
            refused: refusalText.slice(0, 240),
            rearm: JSON.stringify(rearm).slice(0, 160),
            afterRearm: JSON.stringify(afterRearm).slice(0, 200),
            value,
          },
          Date.now() - t,
        );
      } catch (e) {
        row(
          "escape-kill-switch",
          "fail",
          String(e).slice(0, 200),
          { error: String(e), pid },
          Date.now() - t,
        );
      } finally {
        await cuaRequest(endpoint, { method: "rearm", capability }, { timeoutMs: 10_000 }).catch(
          () => undefined,
        );
        // Leave the observation gate clear for later rows: rearm sets
        // desktopObservationRequired, which only a modelObservation clears.
        if (escWin) {
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 400));
            const obs = await cuaRequest<CuaReply>(
              endpoint,
              {
                method: "call",
                name: "get_window_state",
                args: {
                  pid: escWin.pid,
                  window_id: escWin.window_id,
                  max_elements: 8,
                },
                capability,
                modelObservation: true,
              },
              { timeoutMs: 10_000, mutation: true },
            ).catch(() => undefined);
            const sc = obs?.result?.structuredContent as { elements?: unknown[] } | undefined;
            if (obs?.ok && Array.isArray(sc?.elements)) break;
          }
        }
      }
    }
  }

  // ── cancellation (force_synthetic key_events into the front doc, abort mid-flight) ──
  if (wanted("cancellation")) {
    const t = Date.now();
    if (opWin) {
      const ac = new AbortController();
      // 2578 chars at ~38ms/char ≈ 98s of real keystrokes — a 2s abort
      // lands ~50 chars in: an unambiguous mid-flight interruption.
      const longText = `${SENTINEL}-` + "cancel-me ".repeat(250);
      const promise = cuaRequest<CuaReply>(
        endpoint,
        {
          method: "call",
          name: "type_text",
          args: {
            pid: opWin.pid,
            window_id: opWin.window_id,
            text: longText,
            force_synthetic: true,
          },
          capability,
        },
        { mutation: true, signal: ac.signal, timeoutMs: 120_000 },
      ).catch((e) => ({ ok: false, error: String(e) }) as CuaReply);
      setTimeout(() => ac.abort(), 2000);
      const res = await promise;
      const after = await textAreaValue(opWin.pid, opWin.window_id);
      const sc = res.result?.structuredContent as
        | { effect?: string; delivered_chars?: number }
        | undefined;
      const effect = sc?.effect ?? (res as { effect?: string }).effect;
      const typedChars =
        typeof sc?.delivered_chars === "number"
          ? sc.delivered_chars
          : typeof after === "string"
            ? (after.match(/cancel-me/g)?.length ?? 0) * 10 +
              (after.includes(SENTINEL) ? SENTINEL.length + 1 : 0)
            : undefined;
      const cancelled =
        res.ok === false ||
        !replyOk(res) ||
        effect === "dispatched-unknown" ||
        /cancel|abort|partial|interrupt|stop|refused/i.test(JSON.stringify(res));
      // Honest outcomes: mid-flight stop with strictly-partial delivery, or a
      // clean not-dispatched cancel (0 chars). Fail = full delivery after
      // abort, or cancellation that couldn't stop the transport.
      const ok = cancelled && typeof typedChars === "number" && typedChars < longText.length;
      row(
        "cancellation",
        ok ? "pass" : "fail",
        `cancelled=${cancelled} effect=${effect} delivered=${typedChars ?? "?"}/${longText.length} chars`,
        {
          effect,
          delivered: typedChars,
          afterLen: after?.length,
          reply: JSON.stringify(res).slice(0, 400),
        },
        Date.now() - t,
      );
    } else row("cancellation", "skipped", "no operator doc", undefined, Date.now() - t);
  }
} catch (e) {
  console.error("HARNESS ERROR", e);
  failures++;
} finally {
  // ── focus-invariant ──
  const report = await stopProbe();
  if (wanted("focus-invariant")) {
    if (!report) {
      row("focus-invariant", "skipped", "probe unavailable — no theft coverage", undefined, 0);
    } else if (!report.ok) {
      row(
        "focus-invariant",
        "skipped",
        `insufficient coverage: ${report.issues.join("; ") || "samples too few"}`,
        { sampleCount: report.sampleCount, issues: report.issues },
        0,
      );
    } else {
      // `topWin`-only blips under 2s are transient OS overlays (banners,
      // tooltips) — recorded as warnings, not agent theft. Hard theft =
      // frontmost pid, key window, active space, or focused pid changed.
      const HARD = new Set(["pid", "keyWin", "space", "focusedPid"]);
      const theft = report.offBaseline.filter((v) => v.changedFields.some((f) => HARD.has(f)));
      const warnings = report.offBaseline.filter(
        (v) => !v.changedFields.some((f) => HARD.has(f)) && v.durationMs < 2000,
      );
      const persistent = report.offBaseline.filter(
        (v) => !v.changedFields.some((f) => HARD.has(f)) && v.durationMs >= 2000,
      );
      const ok = theft.length === 0 && persistent.length === 0;
      const detail = ok
        ? `theft-free across ${report.sampleCount} samples (${warnings.length} topWin blips tolerated)`
        : `${theft.length} hard + ${persistent.length} persistent violations (${warnings.length} blips)`;
      row(
        "focus-invariant",
        ok ? "pass" : "fail",
        detail,
        {
          theft: theft.slice(0, 8),
          persistent: persistent.slice(0, 4),
          warnings: warnings.slice(0, 4),
          drift: report.drift.slice(0, 4),
          sampleCount: report.sampleCount,
          issues: report.issues,
        },
        0,
      );
    }
  }

  // cleanup targets
  if (!keepTargets) {
    for (const pid of spawnedPids) {
      spawnSync("kill", [String(pid)]);
    }
  }
  try {
    await cuaRequest(endpoint, { method: "stop", capability }, { timeoutMs: 10_000 }).catch(
      () => undefined,
    );
  } catch {
    /* host already down */
  }
  await shieldHost?.dispose().catch(() => undefined);
  escMonitor?.dispose();

  const failed = rows.filter((r) => r.verdict === "fail");
  const skipped = rows.filter((r) => r.verdict === "skipped");
  failures += failed.length;
  skips += skipped.length;

  const summary = {
    run: SENTINEL,
    date: new Date().toISOString(),
    driver: DRIVER,
    endpoint,
    elapsedMs: Date.now() - t0,
    rows,
    speed: speedTable(),
    summary: {
      total: rows.length,
      pass: rows.filter((r) => r.verdict === "pass").length,
      fail: failed.length,
      skipped: skipped.length,
      verdict: failed.length === 0 ? "pass" : "fail",
    },
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(summary, null, 2), {
    mode: 0o600,
  });
  const speed = summary.speed;
  const md = [
    `# live-cert ${SENTINEL}`,
    ``,
    `- date: ${summary.date}`,
    `- elapsed: ${summary.elapsedMs}ms`,
    `- verdict: **${summary.summary.verdict.toUpperCase()}** — ${summary.summary.pass} pass / ${summary.summary.fail} fail / ${summary.summary.skipped} skipped`,
    ``,
    `| Row | Verdict | Detail |`,
    `|---|---|---|`,
    ...rows.map((r) => `| ${r.name} | ${r.verdict} | ${(r.detail ?? "").replaceAll("|", "\\|")} |`),
    ``,
    `## Speed budget (driver-call wall clock, ms)`,
    ``,
    `| Tool | n | p50 | p95 | max |`,
    `|---|---|---|---|---|`,
    ...speed.map((s) => `| ${s.tool} | ${s.n} | ${s.p50} | ${s.p95} | ${s.max} |`),
    ``,
    `Skipped rows are honest gaps, not passes. Re-run with a second desktop`,
    `Space for the space-* rows.`,
  ].join("\n");
  await writeFile(notesPath, md, { mode: 0o600 });
  log(`\nreport: ${reportPath}`);
  log(`notes:  ${notesPath}`);
  log(
    `${summary.summary.pass} pass / ${summary.summary.fail} fail / ${summary.summary.skipped} skipped in ${Math.round(summary.elapsedMs / 1000)}s`,
  );
  process.exit(failed.length > 0 ? 2 : 0);
}
