// One Markdown table per measurement run, in the order of the targets in RESULTS.md:
// median (min–max) per variant, with sample counts.
//
//   node benchmarks/web-boot/report.mjs --paint1 <json> --paint4 <json> --net <json> \
//     [--slow <json>] [--dist name=<dist> ...]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { quantile } from "./lib.mjs";

const { values } = parseArgs({
  options: {
    paint1: { type: "string" },
    paint4: { type: "string" },
    net: { type: "string" },
    slow: { type: "string" },
    dist: { type: "string", multiple: true, default: [] },
  },
});
const load = (file) => (file ? JSON.parse(readFileSync(file, "utf8")) : []);
const runs = {
  paint1: load(values.paint1),
  paint4: load(values.paint4),
  net: load(values.net),
  slow: load(values.slow),
};
const variants = [
  ...new Set(
    Object.values(runs)
      .flat()
      .map((s) => s.variant),
  ),
];
const cell = (run, variant, key, scale = 1) => {
  const list = runs[run].filter((s) => s.variant === variant).map((s) => s[key]);
  const v = list.filter((x) => typeof x === "number");
  if (v.length === 0) return "–";
  const [mid, lo, hi] = [0.5, 0, 1].map((p) => (quantile(v, p) / scale).toFixed(0));
  return lo === hi ? `${mid}` : `${mid} (${lo}–${hi})`;
};
const count = (run, variant) => runs[run].filter((s) => s.variant === variant).length;
const rpc = (variant) => {
  const list = runs.net.filter((s) => s.variant === variant && s.rpcOut);
  if (list.length === 0) return "–";
  const per = list.map(
    (s) => (s.rpcOut["server.getConfig"] ?? 0) + (s.rpcOut["server.getSettings"] ?? 0),
  );
  return `${Math.min(...per)}–${Math.max(...per)}`;
};
const closures = Object.fromEntries(
  values.dist.map((spec) => {
    const [name, dist] = spec.split("=");
    const out = JSON.parse(
      execFileSync("node", [path.join(import.meta.dirname, "closure.mjs"), dist], {
        encoding: "utf8",
      }),
    );
    return [name, out];
  }),
);
const closureCell = (v) => {
  const c = closures[v];
  return c
    ? `${c.entryStaticClosure.rawKB} / ${c.entryStaticClosure.brKB} KB (${c.entryStaticClosure.files} files)`
    : "–";
};
const rows = [
  ["Static entry closure, raw / brotli", (v) => closureCell(v)],
  [
    "Chunk-import cycles",
    (v) => (closures[v] ? String(closures[v].chunkImportCycles.length) : "–"),
  ],
  ["JS chunks emitted", (v) => (closures[v] ? String(closures[v].totalJs.files) : "–")],
  ["DOMContentLoaded, ms", (v) => cell("paint1", v, "dcl")],
  ["DOMContentLoaded 4x CPU, ms", (v) => cell("paint4", v, "dcl")],
  ["Long-task time, ms", (v) => cell("paint1", v, "longTaskTotal")],
  ["Long-task time 4x CPU, ms", (v) => cell("paint4", v, "longTaskTotal")],
  ["Total Blocking Time, ms", (v) => cell("paint1", v, "tbt")],
  ["Total Blocking Time 4x CPU, ms", (v) => cell("paint4", v, "tbt")],
  ["First Contentful Paint, ms", (v) => cell("paint1", v, "fcp")],
  ["First Contentful Paint 4x CPU, ms", (v) => cell("paint4", v, "fcp")],
  ["Splash dismissed, ms", (v) => cell("paint1", v, "splashGoneMs")],
  ["Splash dismissed 4x CPU, ms", (v) => cell("paint4", v, "splashGoneMs")],
  ["HTTP requests (total)", (v) => cell("net", v, "requests")],
  ["HTTP requests (JS)", (v) => cell("net", v, "jsRequests")],
  ["HTTP wire bytes, KB", (v) => cell("net", v, "wireBytes", 1024)],
  ["Boot getConfig + getSettings calls", (v) => rpc(v)],
  ["Slow link: DOMContentLoaded, ms", (v) => cell("slow", v, "dcl")],
  ["Slow link: splash dismissed, ms", (v) => cell("slow", v, "splashGoneMs")],
  ["Slow link: First Contentful Paint, ms", (v) => cell("slow", v, "fcp")],
];
console.log(`| Metric | ${variants.join(" | ")} |`);
console.log(`|---|${variants.map(() => "---:").join("|")}|`);
for (const [label, fn] of rows) console.log(`| ${label} | ${variants.map(fn).join(" | ")} |`);
console.log(
  `\nSamples per variant: paint 1x ${count("paint1", variants[0])}, paint 4x ${count("paint4", variants[0])}, network ${count("net", variants[0])}, slow link ${count("slow", variants[0])}.`,
);
