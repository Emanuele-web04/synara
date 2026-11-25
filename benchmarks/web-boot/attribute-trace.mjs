// Attributes renderer main-thread time of a profile.mjs trace: long tasks (RunTask >= 50 ms)
// and the whole boot window, split into JS self time per chunk (and per source module when
// the build has source maps, e.g. SYNARA_WEB_SOURCEMAP=hidden), module compile, GC, style,
// layout and paint.
//
//   node benchmarks/web-boot/attribute-trace.mjs <trace.json> [...] [--dist <dist>] [--top 12]
//
// Several traces of one variant are summed and divided by their count (mean per boot).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { HARNESS_REPO } from "./lib.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dist: { type: "string" },
    top: { type: "string", default: "12" },
    json: { type: "boolean" },
  },
});
const top = Number(values.top);
const require = createRequire(path.join(HARNESS_REPO, "apps/web/package.json"));
const { SourceMapConsumer } = require(
  path.join(HARNESS_REPO, "node_modules/.bun/source-map-js@1.2.1/node_modules/source-map-js"),
);
const maps = new Map();
function sourceOf(url, line, column) {
  if (!values.dist || !url.includes("/assets/")) return null;
  const file = url.slice(url.indexOf("/assets/") + 1);
  if (!maps.has(file)) {
    const mapFile = path.join(values.dist, `${file}.map`);
    maps.set(
      file,
      existsSync(mapFile) ? new SourceMapConsumer(JSON.parse(readFileSync(mapFile, "utf8"))) : null,
    );
  }
  const consumer = maps.get(file);
  if (!consumer) return null;
  const pos = consumer.originalPositionFor({ line: line + 1, column });
  return pos.source ? normalizeSource(pos.source) : null;
}
// node_modules paths collapse to the package; app paths keep their repository path.
function normalizeSource(source) {
  const nm = source.lastIndexOf("node_modules/");
  if (nm >= 0) {
    const rest = source.slice(nm + "node_modules/".length).split("/");
    return `npm:${rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]}`;
  }
  const m = /(apps\/[^/]+\/src\/.*|packages\/[^/]+\/src\/.*)$/.exec(source);
  return m ? m[1] : source.replace(/^(\.\.\/)+/, "");
}
const chunkOf = (url) =>
  url ? url.replace(/^https?:\/\/[^/]+\//, "").replace(/-[\w-]{8}\.js$/, ".js") : "";

function analyse(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const events = raw.traceEvents ?? raw;
  const navStart = events
    .filter(
      (e) => e.name === "navigationStart" && e.args?.data?.documentLoaderURL?.startsWith("http"),
    )
    .map((e) => e.ts)
    .sort((a, b) => a - b)[0];
  const mainThread = events.find((e) => e.name === "navigationStart" && e.ts === navStart);
  const { pid, tid } = mainThread;
  const onMain = events.filter((e) => e.pid === pid && e.tid === tid && e.ph === "X");
  const fcp = events.find((e) => e.name === "firstContentfulPaint" && e.pid === pid)?.ts ?? null;
  // Top-level tasks only.
  const tasks = onMain.filter((e) => e.name === "RunTask").sort((a, b) => a.ts - b.ts);
  const topTasks = [];
  let end = -Infinity;
  for (const t of tasks) {
    if (t.ts >= end) {
      topTasks.push(t);
      end = t.ts + t.dur;
    }
  }
  const longTasks = topTasks.filter((t) => t.dur >= 50_000 && t.ts >= navStart);

  // CPU samples of the main thread's profile.
  const profile = events.find((e) => e.name === "Profile" && e.pid === pid && e.tid === tid);
  const nodes = new Map();
  const samples = [];
  if (profile) {
    let t = profile.args.data.startTime;
    for (const chunk of events.filter(
      (e) => e.name === "ProfileChunk" && e.id === profile.id && e.pid === pid,
    )) {
      const cpuProfile = chunk.args.data.cpuProfile ?? {};
      for (const node of cpuProfile.nodes ?? []) nodes.set(node.id, node);
      const deltas = chunk.args.data.timeDeltas ?? [];
      (cpuProfile.samples ?? []).forEach((id, i) => {
        t += deltas[i] ?? 0;
        samples.push({ t, id });
      });
    }
    samples.sort((a, b) => a.t - b.t);
  }
  // Source of a profile node, cached: the module its function was defined in.
  const sourceCache = new Map();
  const nodeSource = (id) => {
    if (!sourceCache.has(id)) {
      const frame = nodes.get(id)?.callFrame ?? {};
      sourceCache.set(
        id,
        frame.url ? sourceOf(frame.url, frame.lineNumber, frame.columnNumber) : null,
      );
    }
    return sourceCache.get(id);
  };
  const selfIn = (from, to) => {
    const byChunk = new Map();
    const bySource = new Map();
    // Inclusive: each source on the sample's stack counted once (callers included).
    const inclusive = new Map();
    for (let i = 0; i < samples.length - 1; i += 1) {
      const s = samples[i];
      if (s.t < from || s.t >= to) continue;
      const dt = Math.min(samples[i + 1].t, to) - s.t;
      const frame = nodes.get(s.id)?.callFrame ?? {};
      const key = frame.url ? chunkOf(frame.url) : frame.functionName || "(unknown)";
      if (key === "(idle)") continue;
      byChunk.set(key, (byChunk.get(key) ?? 0) + dt);
      if (frame.url) {
        const src = sourceOf(frame.url, frame.lineNumber, frame.columnNumber) ?? `${key} (no map)`;
        bySource.set(src, (bySource.get(src) ?? 0) + dt);
      }
      const onStack = new Set();
      for (let n = s.id; n !== undefined; n = nodes.get(n)?.parent) {
        const src = nodeSource(n);
        if (src) onStack.add(src);
      }
      for (const src of onStack) inclusive.set(src, (inclusive.get(src) ?? 0) + dt);
    }
    return { byChunk, bySource, inclusive };
  };
  const kindsIn = (from, to) => {
    const kinds = new Map();
    const compileByChunk = new Map();
    const add = (k, d) => kinds.set(k, (kinds.get(k) ?? 0) + d);
    for (const e of onMain) {
      if (e.ts < from || e.ts >= to) continue;
      if (e.name === "v8.compileModule" || e.name === "v8.compile") {
        add("compile (main thread)", e.dur);
        const c = chunkOf(e.args?.data?.url ?? e.args?.fileName);
        compileByChunk.set(c, (compileByChunk.get(c) ?? 0) + e.dur);
      } else if (e.name === "MinorGC" || e.name === "MajorGC") add("GC", e.dur);
      else if (e.name === "UpdateLayoutTree") add("style", e.dur);
      else if (e.name === "Layout") add("layout", e.dur);
      else if (e.name === "Paint" || e.name === "PrePaint" || e.name === "Layerize")
        add("paint", e.dur);
      else if (e.name === "ParseHTML") add("parse HTML", e.dur);
      else if (e.name === "v8.evaluateModule") add("module evaluation (incl. JS)", e.dur);
    }
    return { kinds, compileByChunk };
  };
  const settleEnd = Math.max(...onMain.map((e) => e.ts + e.dur));
  const window = { from: navStart, to: settleEnd };
  const inLong = longTasks.map((t) => ({
    startMs: (t.ts - navStart) / 1000,
    durMs: t.dur / 1000,
    ...selfIn(t.ts, t.ts + t.dur),
    ...kindsIn(t.ts, t.ts + t.dur),
  }));
  return {
    file,
    fcpMs: fcp ? (fcp - navStart) / 1000 : null,
    longTasks: inLong,
    whole: { ...selfIn(window.from, window.to), ...kindsIn(window.from, window.to) },
  };
}

const runs = positionals.map(analyse);
const merge = (maps) => {
  const out = new Map();
  for (const m of maps) for (const [k, v] of m) out.set(k, (out.get(k) ?? 0) + v);
  for (const [k, v] of out) out.set(k, v / runs.length / 1000);
  return [...out].sort((a, b) => b[1] - a[1]);
};
const fmt = (list) =>
  list
    .slice(0, top)
    .map(([k, v]) => `${v.toFixed(1).padStart(7)} ms  ${k}`)
    .join("\n");
const longTaskTotal =
  runs.reduce((s, r) => s + r.longTasks.reduce((a, t) => a + t.durMs, 0), 0) / runs.length;
console.log(`traces: ${runs.length}; FCP ${runs.map((r) => r.fcpMs?.toFixed(0)).join(", ")} ms`);
console.log(
  `long tasks per boot: ${runs.map((r) => r.longTasks.map((t) => `${t.startMs.toFixed(0)}+${t.durMs.toFixed(0)}`).join(" ")).join(" | ")}`,
);
console.log(`mean long-task time per boot: ${longTaskTotal.toFixed(0)} ms`);
const all = runs.flatMap((r) => r.longTasks);
console.log(
  "\n# Inside long tasks, mean per boot\n## kinds\n" + fmt(merge(all.map((t) => t.kinds))),
);
console.log("## JS self time by chunk\n" + fmt(merge(all.map((t) => t.byChunk))));
console.log("## JS self time by source\n" + fmt(merge(all.map((t) => t.bySource))));
console.log(
  "## JS inclusive time by source (callers included)\n" + fmt(merge(all.map((t) => t.inclusive))),
);
console.log("## main-thread compile by chunk\n" + fmt(merge(all.map((t) => t.compileByChunk))));
console.log(
  "\n# Whole boot window, mean per boot\n## kinds\n" + fmt(merge(runs.map((r) => r.whole.kinds))),
);
console.log("## JS self time by chunk\n" + fmt(merge(runs.map((r) => r.whole.byChunk))));
console.log("## JS self time by source\n" + fmt(merge(runs.map((r) => r.whole.bySource))));
