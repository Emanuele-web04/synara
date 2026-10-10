/**
 * Supplementary latency probe (native rev 17) — fills two gaps in
 * `latency-rev17-probe.ts`:
 *
 *  1. Cold start: 20 fresh CuaDriverHost instances (spec asks for >=20 runs
 *     per budget row). Each sample = listen() -> first `get_screen_size`
 *     call, which pays spawn + metadata handshake + start_session + cursor
 *     setup before the call itself.
 *  2. Interleaved get_window_state: AX-only and +screenshot reads alternate
 *     A/B so a transient contention burst cannot be attributed to one arm.
 *     Also records elements count + image presence per reply to detect any
 *     payload-shape difference between the two request shapes.
 *
 * Output: `latency-rev17-<date>-supplement.json` next to this file.
 */
import { Socket } from "node:net";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { CuaDriverHost } from "../../../apps/desktop/src/cuaDriverHost";

const BINARY = "/Users/devin/repos/synara/apps/desktop/resources/cua-driver/cua-driver";
const CAP = "latency-probe-capability-0123456789abcdef";
const N_COLD = 20;
const N_WARM = 30;
const GAP_MS = 50;
const OUT = new URL(
  `./latency-rev17-${new Date().toISOString().slice(0, 10)}-supplement.json`,
  import.meta.url,
).pathname;

interface TimedReply {
  reply: any;
  ms: number;
  bytes: number;
}

const results: Record<string, unknown> = {
  meta: {},
  coldStarts: [] as unknown[],
  interleaved: [] as unknown[],
  stats: {} as Record<string, unknown>,
  anomalies: [] as string[],
};
const anomalies = results.anomalies as string[];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function statsOf(vals: number[]) {
  const s = vals.filter((v) => Number.isFinite(v)).toSorted((a, b) => a - b);
  if (!s.length) return { n: 0 };
  return {
    n: s.length,
    min: +s[0].toFixed(2),
    p50: +percentile(s, 50).toFixed(2),
    p95: +percentile(s, 95).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
  };
}
const frontmost = (): string => {
  try {
    return execSync(
      `osascript -e 'tell application "System Events" to name of first application process whose frontmost is true'`,
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "error";
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

async function makeHost() {
  const host = new CuaDriverHost({
    binaryPath: BINARY,
    bundleId: "com.synara.latency-probe",
    capability: CAP,
    setup: async () => {},
  });
  const t0 = performance.now();
  const endpoint = await host.listen();
  return { host, endpoint, listenMs: performance.now() - t0 };
}

function request(endpoint: string, payload: Record<string, unknown>, timeoutMs = 120_000) {
  return new Promise<TimedReply>((resolve, reject) => {
    const sock = new Socket();
    const chunks: Buffer[] = [];
    const t0 = performance.now();
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timeout ${String(payload.name ?? payload.method)}`));
    }, timeoutMs);
    sock.connect(endpoint);
    sock.on("connect", () => sock.write(JSON.stringify({ capability: CAP, ...payload }) + "\n"));
    sock.on("data", (d) => chunks.push(d));
    sock.on("end", () => {
      clearTimeout(timer);
      const ms = performance.now() - t0;
      const buf = Buffer.concat(chunks);
      try {
        resolve({ reply: JSON.parse(buf.toString("utf8")), ms, bytes: buf.length });
      } catch {
        reject(new Error(`bad reply ${String(payload.name)}`));
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
const call = (endpoint: string, name: string, args: Record<string, unknown> = {}) =>
  request(endpoint, { method: "call", name, args });

async function main() {
  const meta = results.meta as Record<string, unknown>;
  meta.date = new Date().toISOString();
  meta.frontmostBefore = frontmost();

  // ---- 20 cold starts.
  for (let i = 0; i < N_COLD; i++) {
    const h = await makeHost();
    const t0 = performance.now();
    let ok = false;
    try {
      const r = await call(h.endpoint, "get_screen_size");
      ok = r.reply.ok === true;
    } catch (e) {
      anomalies.push(`cold ${i}: ${String(e).slice(0, 120)}`);
    }
    const firstCallMs = performance.now() - t0;
    let second: TimedReply | undefined;
    try {
      second = await call(h.endpoint, "get_screen_size");
    } catch {}
    (results.coldStarts as unknown[]).push({
      i,
      listenMs: +h.listenMs.toFixed(2),
      firstCallMs: +firstCallMs.toFixed(2),
      secondCallMs: second ? +second.ms.toFixed(2) : null,
      ok,
    });
    await h.host.dispose();
    await sleep(200);
    if (i % 5 === 4) console.log(`cold ${i + 1}/${N_COLD} done`);
  }

  // ---- Interleaved get_window_state on a fresh TextEdit.
  const warm = await makeHost();
  try {
    await call(warm.endpoint, "get_screen_size");
    const teBefore = new Set(pgrep("TextEdit"));
    execSync("open -g -n -a TextEdit");
    await sleep(3000);
    let teWin: Record<string, any> | undefined;
    for (let a = 0; a < 5 && !teWin; a++) {
      const wins = (await call(warm.endpoint, "list_windows")).reply.result?.structuredContent
        ?.windows as Array<Record<string, any>> | undefined;
      const cands = (wins ?? []).filter(
        (w) => /textedit/i.test(String(w.app_name ?? "")) && w.bounds?.height > 100,
      );
      teWin =
        cands.find((w) => String(w.title ?? "").startsWith("Untitled") && !teBefore.has(w.pid)) ??
        cands.find((w) => String(w.title ?? "").startsWith("Untitled")) ??
        cands[0];
      if (!teWin) await sleep(1200);
    }
    if (!teWin) throw new Error("no TextEdit window");
    const pid = teWin.pid;
    const treeArgs = {
      pid,
      window_id: teWin.window_id,
      include_accessibility_tree: true,
      max_elements: 1024,
      max_depth: 25,
    };
    const shotArgs = { ...treeArgs, include_screenshot: true, max_dimension: 1536 };
    // seed modest text so the tree is non-trivial
    const st = await call(warm.endpoint, "get_window_state", treeArgs);
    const ta = (st.reply.result?.structuredContent?.elements ?? []).find(
      (e: any) => e.role === "AXTextArea",
    );
    if (ta) {
      await call(warm.endpoint, "set_value", {
        pid,
        window_id: teWin.window_id,
        element_token: ta.element_token,
        element_index: ta.element_index,
        value: Array.from({ length: 80 }, (_, i) => `seed ${i}`).join("\n"),
      });
    }
    for (let i = 0; i < N_WARM; i++) {
      const ax = await call(warm.endpoint, "get_window_state", treeArgs);
      const axEls = Array.isArray(ax.reply.result?.structuredContent?.elements)
        ? ax.reply.result.structuredContent.elements.length
        : null;
      await sleep(GAP_MS);
      const img = await call(warm.endpoint, "get_window_state", shotArgs);
      const imgEls = Array.isArray(img.reply.result?.structuredContent?.elements)
        ? img.reply.result.structuredContent.elements.length
        : null;
      const imgHasImage = (img.reply.result?.content ?? []).some(
        (p: any) => p.type === "image" && !!p.data,
      );
      (results.interleaved as unknown[]).push({
        i,
        axMs: +ax.ms.toFixed(2),
        axElements: axEls,
        axBytes: ax.bytes,
        imgMs: +img.ms.toFixed(2),
        imgElements: imgEls,
        imgImage: imgHasImage,
        imgBytes: img.bytes,
      });
      await sleep(GAP_MS);
    }
    meta.frontmostAfter = frontmost();
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  } finally {
    await warm.host.dispose();
  }

  const cold = results.coldStarts as Array<Record<string, any>>;
  const inter = results.interleaved as Array<Record<string, any>>;
  (results.stats as Record<string, unknown>).cold_first_call = statsOf(
    cold.map((e) => e.firstCallMs),
  );
  (results.stats as Record<string, unknown>).cold_listen = statsOf(cold.map((e) => e.listenMs));
  (results.stats as Record<string, unknown>).cold_second_call = statsOf(
    cold.map((e) => e.secondCallMs).filter((v): v is number => typeof v === "number"),
  );
  (results.stats as Record<string, unknown>).ax = statsOf(inter.map((e) => e.axMs));
  (results.stats as Record<string, unknown>).img = statsOf(inter.map((e) => e.imgMs));
  writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(`\nwrote ${OUT}`);
  for (const [k, s] of Object.entries(results.stats as Record<string, ReturnType<typeof statsOf>>))
    console.log(
      `${k.padEnd(20)} n=${s.n} min=${s.min} p50=${s.p50} p95=${s.p95} max=${s.max} mean=${s.mean}`,
    );
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
