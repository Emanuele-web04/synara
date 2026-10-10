/**
 * Warm-path latency probe for the macOS computer-use stack (native rev 17).
 *
 * Spawns a real CuaDriverHost under this shell (inheriting the terminal's TCC
 * trust), opens a scratch TextEdit instance, and times the operations in the
 * workstream-C speed-spec budget table through the host's unix-socket
 * transport — the same path the server takes.
 *
 * Method: one fresh socket connection per request (the host handles exactly
 * one request per connection and replies `{...result, desktopEpoch}` then
 * closes). `performance.now()` brackets the whole round trip. A host-only
 * `probe` request and a trivial `get_screen_size` driver call provide the
 * transport-vs-driver-work split, since driver replies carry no internal
 * timing fields.
 *
 * Safety: input goes only to the TextEdit instance this script launched
 * (matched by pid + window_id). Calculator launches are killed between
 * samples; only pids this script observed spawning are killed. The host is
 * disposed (driver retired, socket dir removed) in `finally`.
 *
 * Run: `bun docs/computer-use-cua/evidence/latency-rev17-probe.ts`
 * Output: `latency-rev17-<date>.json` next to this file.
 */
import { Socket } from "node:net";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { CuaDriverHost } from "../../../apps/desktop/src/cuaDriverHost";

const BINARY = "/Users/devin/repos/synara/apps/desktop/resources/cua-driver/cua-driver";
const CAP = "latency-probe-capability-0123456789abcdef";
const N_WARM = 30;
const N_COLD = 3;
const GAP_MS = 50;
const OUT = new URL(
  `./latency-rev17-${new Date().toISOString().slice(0, 10)}.json`,
  import.meta.url,
).pathname;

interface Reply {
  ok?: boolean;
  result?: {
    content?: Array<{ type: string; data?: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    [k: string]: unknown;
  };
  error?: string;
  effect?: string;
  desktopEpoch?: number;
}

interface TimedReply {
  reply: Reply;
  ms: number;
  bytes: number;
}

interface HostHandle {
  host: CuaDriverHost;
  endpoint: string;
  dir: string;
  listenMs: number;
}

const results: Record<string, unknown> = {
  meta: {},
  coldStarts: [] as unknown[],
  warmHostStartup: null as unknown,
  samples: {} as Record<string, unknown[]>,
  typeCompose: [] as unknown[],
  stats: {} as Record<string, unknown>,
  anomalies: [] as string[],
};
const samples = results.samples as Record<string, unknown[]>;
const anomalies = results.anomalies as string[];

function sample(op: string, entry: Record<string, unknown>) {
  (samples[op] ??= []).push(entry);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function statsOf(entries: Array<Record<string, unknown>>, key = "ms") {
  const vals = entries
    .map((e) => e[key])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .toSorted((a, b) => a - b);
  const n = vals.length;
  if (n === 0) return { n: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  return {
    n,
    min: +vals[0].toFixed(2),
    p50: +percentile(vals, 50).toFixed(2),
    p95: +percentile(vals, 95).toFixed(2),
    max: +vals[n - 1].toFixed(2),
    mean: +mean.toFixed(2),
  };
}

const frontmost = (): string => {
  try {
    return execSync(
      `osascript -e 'tell application "System Events" to name of first application process whose frontmost is true'`,
      { encoding: "utf8" },
    ).trim();
  } catch (e) {
    return `error:${String(e).slice(0, 80)}`;
  }
};

const pgrep = (name: string): number[] => {
  try {
    return execSync(`pgrep -x ${name}`, { encoding: "utf8" })
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
  } catch {
    return [];
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeHost(): Promise<HostHandle> {
  const host = new CuaDriverHost({
    binaryPath: BINARY,
    bundleId: "com.synara.latency-probe",
    capability: CAP,
    setup: async () => {},
  });
  const t0 = performance.now();
  const endpoint = await host.listen();
  return {
    host,
    endpoint,
    dir: endpoint.replace(/\/host\.sock$/, ""),
    listenMs: performance.now() - t0,
  };
}

/** One request per connection; resolves on socket end with parsed reply. */
function request(
  endpoint: string,
  payload: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<TimedReply> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    const chunks: Buffer[] = [];
    const t0 = performance.now();
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timeout ${String(payload.name ?? payload.method)}`));
    }, timeoutMs);
    sock.connect(endpoint);
    sock.on("connect", () => {
      sock.write(JSON.stringify({ capability: CAP, ...payload }) + "\n");
    });
    sock.on("data", (d) => chunks.push(d));
    sock.on("end", () => {
      clearTimeout(timer);
      const ms = performance.now() - t0;
      const buf = Buffer.concat(chunks);
      try {
        resolve({ reply: JSON.parse(buf.toString("utf8")) as Reply, ms, bytes: buf.length });
      } catch {
        reject(
          new Error(`bad reply for ${String(payload.name)}: ${buf.toString("utf8").slice(0, 200)}`),
        );
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const call = (
  endpoint: string,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number,
) => request(endpoint, { method: "call", name, args }, timeoutMs);

const findTextArea = (reply: Reply) =>
  (
    (reply.result?.structuredContent?.elements as Array<Record<string, any>> | undefined) ?? []
  ).find((e) => e.role === "AXTextArea");

function summarize(t: TimedReply): Record<string, unknown> {
  const sc = t.reply.result?.structuredContent ?? {};
  return {
    ms: +t.ms.toFixed(2),
    ok: t.reply.ok === true && t.reply.result?.isError !== true,
    ...(typeof sc.effect === "string" ? { effect: sc.effect } : {}),
    ...(typeof sc.route === "string" ? { route: sc.route } : {}),
    ...(typeof sc.path === "string" ? { route: sc.path } : {}),
    ...(typeof (sc.delivery as Record<string, unknown> | undefined)?.mode === "string"
      ? { delivery: (sc.delivery as Record<string, unknown>).mode }
      : {}),
    ...(typeof sc.code === "string" ? { code: sc.code } : {}),
    bytes: t.bytes,
    ...(t.reply.error ? { error: String(t.reply.error).slice(0, 160) } : {}),
    ...(typeof sc.message === "string" ? { message: sc.message.slice(0, 160) } : {}),
    ...(typeof sc.reason === "string" ? { reason: sc.reason.slice(0, 160) } : {}),
  };
}

async function main() {
  const meta = results.meta as Record<string, unknown>;
  meta.date = new Date().toISOString();
  meta.binary = BINARY;
  meta.binaryProvenance = JSON.parse(
    execSync(`cat /Users/devin/repos/synara/apps/desktop/resources/cua-driver/provenance.json`, {
      encoding: "utf8",
    }),
  );
  meta.arch = execSync("uname -m", { encoding: "utf8" }).trim();
  meta.os = execSync("sw_vers -productVersion", { encoding: "utf8" }).trim();
  try {
    meta.chip = execSync("sysctl -n machdep.cpu.brand_string", { encoding: "utf8" }).trim();
    meta.model = execSync("sysctl -n hw.model", { encoding: "utf8" }).trim();
  } catch {}
  meta.commit = execSync("git -C /Users/devin/repos/synara-wt-latency rev-parse HEAD", {
    encoding: "utf8",
  }).trim();
  meta.frontmostBefore = frontmost();
  meta.warmFlagEnv = process.env.SYNARA_CUA_WARM_ON_FIRST_TOUCH ?? null;
  meta.nWarm = N_WARM;
  console.log("meta:", JSON.stringify(meta, null, 1));

  // ---- Cold starts: fresh host per sample; first call pays spawn+handshake+session.
  for (let i = 0; i < N_COLD; i++) {
    const h = await makeHost();
    const t0 = performance.now();
    let first: TimedReply | undefined;
    try {
      first = await call(h.endpoint, "get_screen_size", {}, 120_000);
    } catch (e) {
      anomalies.push(`cold ${i}: first call failed: ${String(e).slice(0, 160)}`);
    }
    const firstCallMs = performance.now() - t0;
    let warmSecond: TimedReply | undefined;
    try {
      warmSecond = await call(h.endpoint, "get_screen_size");
    } catch (e) {
      anomalies.push(`cold ${i}: second call failed: ${String(e).slice(0, 160)}`);
    }
    (results.coldStarts as unknown[]).push({
      i,
      listenMs: +h.listenMs.toFixed(2),
      firstCallMs: +firstCallMs.toFixed(2),
      firstCallReplyMs: first ? +first.ms.toFixed(2) : null,
      secondCallMs: warmSecond ? +warmSecond.ms.toFixed(2) : null,
      firstCallOk: first?.reply.ok === true,
    });
    console.log(
      `cold ${i}: listen=${h.listenMs.toFixed(1)}ms firstCall=${firstCallMs.toFixed(1)}ms second=${warmSecond?.ms.toFixed(1)}ms`,
    );
    await h.host.dispose();
    await sleep(300);
  }

  // ---- Warm host for all remaining measurements.
  const warm = await makeHost();
  const w0 = performance.now();
  const warmFirst = await call(warm.endpoint, "get_screen_size", {}, 120_000);
  results.warmHostStartup = {
    listenMs: +warm.listenMs.toFixed(2),
    firstCallMs: +(performance.now() - w0).toFixed(2),
    firstCallReplyMs: +warmFirst.ms.toFixed(2),
    ok: warmFirst.reply.ok === true,
  };
  console.log("warm host up:", JSON.stringify(results.warmHostStartup));

  const endpoint = warm.endpoint;
  try {
    // ---- Scratch TextEdit (own instance via -n, background via -g).
    const tePidsBefore = new Set(pgrep("TextEdit"));
    execSync("open -g -n -a TextEdit");
    await sleep(3000);
    let tePid = 0;
    let teWin: Record<string, any> | undefined;
    for (let attempt = 0; attempt < 5 && !teWin; attempt++) {
      const wins = (await call(endpoint, "list_windows")).reply.result?.structuredContent as
        | { windows?: Array<Record<string, any>> }
        | undefined;
      const candidates = (wins?.windows ?? []).filter(
        (w) =>
          typeof w.pid === "number" &&
          !tePidsBefore.has(w.pid) &&
          /textedit/i.test(String(w.app_name ?? w.owner ?? "")),
      );
      if (candidates.length === 0) {
        // Fall back to any TextEdit pid if -n reused the running instance.
        const any = (wins?.windows ?? []).filter((w) =>
          /textedit/i.test(String(w.app_name ?? w.owner ?? "")),
        );
        candidates.push(...any);
      }
      teWin =
        candidates.find(
          (w) => String(w.title ?? "").startsWith("Untitled") && w.bounds?.height > 100,
        ) ??
        candidates.find((w) => w.bounds?.width > 200 && w.bounds?.height > 100 && w.title) ??
        candidates.find((w) => w.bounds?.width > 200 && w.bounds?.height > 100);
      if (!teWin) await sleep(1200);
    }
    if (!teWin) throw new Error("no usable TextEdit window found");
    tePid = teWin.pid;
    const bounds = teWin.bounds as { x: number; y: number; width: number; height: number };
    meta.targetWindow = {
      pid: tePid,
      window_id: teWin.window_id,
      title: teWin.title,
      bounds,
      is_on_screen: teWin.is_on_screen,
    };
    console.log("target:", JSON.stringify(meta.targetWindow));

    const treeArgs = {
      pid: tePid,
      window_id: teWin.window_id,
      include_accessibility_tree: true,
      max_elements: 1024,
      max_depth: 25,
    };
    const shotArgs = { ...treeArgs, include_screenshot: true, max_dimension: 1536 };
    const center = { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) };

    // ---- Seed the document (needed for scroll travel + set_value target).
    const st0 = await call(endpoint, "get_window_state", treeArgs);
    const ta0 = findTextArea(st0.reply);
    if (!ta0) throw new Error("no AXTextArea in TextEdit window");
    const seed = Array.from(
      { length: 160 },
      (_, i) => `seed line ${String(i).padStart(3, "0")}`,
    ).join("\n");
    const seedReply = await call(endpoint, "set_value", {
      pid: tePid,
      window_id: teWin.window_id,
      element_token: ta0.element_token,
      element_index: ta0.element_index,
      value: seed,
    });
    console.log("seed:", JSON.stringify(summarize(seedReply)));
    if (seedReply.reply.ok !== true) throw new Error("seed set_value failed");

    const phases: Array<[string, string]> = [];
    meta.frontmostAfterSetup = frontmost();

    // ---- Baselines: host-only probe + trivial driver call.
    for (let i = 0; i < N_WARM; i++) {
      const t = await request(endpoint, { method: "probe" });
      sample("probe", { i, ...summarize(t) });
      await sleep(GAP_MS);
    }
    for (let i = 0; i < N_WARM; i++) {
      const t = await call(endpoint, "get_screen_size");
      sample("get_screen_size", { i, ...summarize(t) });
      await sleep(GAP_MS);
    }
    phases.push(["baselines", frontmost()]);

    // ---- get_state AX-only.
    for (let i = 0; i < N_WARM; i++) {
      const t = await call(endpoint, "get_window_state", treeArgs);
      const el = Array.isArray(t.reply.result?.structuredContent?.elements)
        ? (t.reply.result!.structuredContent!.elements as unknown[]).length
        : null;
      sample("get_state_ax", { i, ...summarize(t), elements: el });
      await sleep(GAP_MS);
    }
    phases.push(["get_state_ax", frontmost()]);

    // ---- get_state with screenshot.
    for (let i = 0; i < N_WARM; i++) {
      const t = await call(endpoint, "get_window_state", shotArgs);
      const hasImage = (t.reply.result?.content ?? []).some((p) => p.type === "image" && !!p.data);
      sample("get_state_img", { i, ...summarize(t), image: hasImage });
      await sleep(GAP_MS);
    }
    phases.push(["get_state_img", frontmost()]);

    // ---- click, background, point at text-area centre.
    for (let i = 0; i < N_WARM; i++) {
      const t = await call(endpoint, "click", {
        pid: tePid,
        window_id: teWin.window_id,
        delivery_mode: "background",
        force_synthetic: true,
        count: 1,
        x: center.x,
        y: center.y,
        coordinate_space: "window_points",
        expected_window_bounds: bounds,
      });
      sample("click", { i, ...summarize(t) });
      await sleep(GAP_MS);
    }
    phases.push(["click", frontmost()]);

    // ---- type: focus-neutral AX insert = resolve + set_value + reread.
    for (let i = 0; i < N_WARM; i++) {
      const tResolve = await call(endpoint, "get_window_state", treeArgs);
      const el = findTextArea(tResolve.reply);
      if (!el) {
        (results.typeCompose as unknown[]).push({ i, error: "textarea lost" });
        anomalies.push(`type ${i}: AXTextArea not found in resolve leg`);
        continue;
      }
      const existing = typeof el.value === "string" ? el.value : "";
      const composed = `${existing}\nprobe append ${i}`;
      const tWrite = await call(endpoint, "set_value", {
        pid: tePid,
        window_id: teWin.window_id,
        element_token: el.element_token,
        element_index: el.element_index,
        value: composed,
      });
      const tReread = await call(endpoint, "get_window_state", treeArgs);
      const elAfter = findTextArea(tReread.reply);
      const confirmed =
        typeof elAfter?.value === "string" &&
        (elAfter.value as string).endsWith(`probe append ${i}`);
      const total = tResolve.ms + tWrite.ms + tReread.ms;
      (results.typeCompose as unknown[]).push({
        i,
        ms: +total.toFixed(2),
        resolveMs: +tResolve.ms.toFixed(2),
        writeMs: +tWrite.ms.toFixed(2),
        rereadMs: +tReread.ms.toFixed(2),
        writeEffect: tWrite.reply.result?.structuredContent?.effect ?? null,
        confirmed,
        bytes: tResolve.bytes + tWrite.bytes + tReread.bytes,
      });
      await sleep(GAP_MS);
    }
    phases.push(["type", frontmost()]);

    // ---- scroll, single leg, delta_y -3.
    for (let i = 0; i < N_WARM; i++) {
      const t = await call(endpoint, "scroll", {
        pid: tePid,
        window_id: teWin.window_id,
        delivery_mode: "background",
        direction: "up",
        delta_x: 0,
        delta_y: -3,
        x: center.x,
        y: center.y,
        coordinate_space: "window_points",
        expected_window_bounds: bounds,
      });
      sample("scroll", { i, ...summarize(t) });
      await sleep(GAP_MS);
    }
    phases.push(["scroll", frontmost()]);

    // ---- launch_app: Calculator; kill spawned instances between samples.
    const myCalcPids = new Set<number>();
    for (let i = 0; i < N_WARM; i++) {
      const before = new Set(pgrep("Calculator"));
      const t = await call(endpoint, "launch_app", { bundle_id: "com.apple.calculator" });
      await sleep(150); // let LaunchServices publish the process
      const after = pgrep("Calculator");
      const spawned = after.filter((p) => !before.has(p));
      for (const p of spawned) myCalcPids.add(p);
      sample("launch_app", {
        i,
        ...summarize(t),
        alreadyRunning: before.size > 0 && spawned.length === 0,
        spawnedPid: spawned[0] ?? null,
      });
      for (const p of spawned) {
        try {
          process.kill(p, "SIGTERM");
        } catch {}
      }
      if (spawned.length) await sleep(400);
      else await sleep(GAP_MS);
    }
    phases.push(["launch_app", frontmost()]);

    meta.frontmostAfter = frontmost();
    meta.frontmostByPhase = Object.fromEntries(phases);

    // ---- Cleanup scratch apps (only what this script spawned).
    for (const p of myCalcPids) {
      try {
        process.kill(p, 0);
        process.kill(p, "SIGKILL");
      } catch {}
    }
    try {
      process.kill(tePid, "SIGTERM");
    } catch {}
    await sleep(800);
    try {
      process.kill(tePid, 0);
      process.kill(tePid, "SIGKILL");
    } catch {}
  } finally {
    await warm.host.dispose();
  }

  // ---- Stats.
  for (const [op, list] of Object.entries(samples)) {
    (results.stats as Record<string, unknown>)[op] = statsOf(
      list as Array<Record<string, unknown>>,
    );
  }
  (results.stats as Record<string, unknown>).type_compose = statsOf(
    results.typeCompose as Array<Record<string, unknown>>,
  );
  (results.stats as Record<string, unknown>).type_compose_resolve_leg = statsOf(
    (results.typeCompose as Array<Record<string, unknown>>).map((e) => ({ ms: e.resolveMs })),
  );
  (results.stats as Record<string, unknown>).type_compose_write_leg = statsOf(
    (results.typeCompose as Array<Record<string, unknown>>).map((e) => ({ ms: e.writeMs })),
  );
  (results.stats as Record<string, unknown>).type_compose_reread_leg = statsOf(
    (results.typeCompose as Array<Record<string, unknown>>).map((e) => ({ ms: e.rereadMs })),
  );
  const cold = results.coldStarts as Array<Record<string, unknown>>;
  (results.stats as Record<string, unknown>).cold_start_first_call = statsOf(
    cold.map((e) => ({ ms: e.firstCallMs })),
  );
  (results.stats as Record<string, unknown>).cold_start_listen = statsOf(
    cold.map((e) => ({ ms: e.listenMs })),
  );

  writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(`\nwrote ${OUT}`);
  for (const [op, s] of Object.entries(
    results.stats as Record<string, ReturnType<typeof statsOf>>,
  )) {
    console.log(
      `${op.padEnd(26)} n=${s.n} min=${s.min} p50=${s.p50} p95=${s.p95} max=${s.max} mean=${s.mean}`,
    );
  }
  console.log("frontmost:", meta.frontmostBefore, "->", meta.frontmostAfter);
  if (anomalies.length) console.log("anomalies:", anomalies);
}

main().catch((e) => {
  console.error("FATAL", e);
  try {
    writeFileSync(OUT, JSON.stringify(results, null, 1));
  } catch {}
  process.exit(1);
});
