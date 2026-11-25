// Median (min–max) per variant from one or more measure.mjs sample files.
//
//   node benchmarks/web-boot/summarize.mjs <samples.json> [...] [--keys fcp,dcl,...] [--md]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { quantile } from "./lib.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { keys: { type: "string" }, md: { type: "boolean", default: false } },
});
const samples = positionals.flatMap((file) => JSON.parse(readFileSync(file, "utf8")));
const paintKeys = ["fcp", "dcl", "splashGoneMs", "longTaskTotal", "tbt", "maxLongTask", "lcp"];
const networkKeys = ["requests", "jsRequests", "cssRequests", "wireBytes", "decodedBytes"];
const keys = values.keys
  ? values.keys.split(",")
  : samples.some((s) => "requests" in s)
    ? [...networkKeys, ...paintKeys]
    : paintKeys;
const variants = [...new Set(samples.map((s) => s.variant))];
const scale = (key, v) => (/Bytes$/.test(key) ? v / 1024 : v);
const cell = (key, list) => {
  const v = list.map((s) => s[key]).filter((x) => typeof x === "number");
  if (v.length === 0) return "–";
  const [mid, lo, hi] = [0.5, 0, 1].map((p) => scale(key, quantile(v, p)).toFixed(0));
  return `${mid} (${lo}–${hi})`;
};
const rows = keys.map((key) => [
  /Bytes$/.test(key) ? `${key} KB` : key,
  ...variants.map((v) =>
    cell(
      key,
      samples.filter((s) => s.variant === v),
    ),
  ),
]);
const n = variants.map((v) => samples.filter((s) => s.variant === v).length);
if (values.md) {
  console.log(`| metric | ${variants.map((v, i) => `${v} (n=${n[i]})`).join(" | ")} |`);
  console.log(`|---|${variants.map(() => "---:").join("|")}|`);
  for (const row of rows) console.log(`| ${row.join(" | ")} |`);
} else {
  console.table(
    Object.fromEntries(
      rows.map(([k, ...c]) => [k, Object.fromEntries(variants.map((v, i) => [v, c[i]]))]),
    ),
  );
  console.log("n per variant:", Object.fromEntries(variants.map((v, i) => [v, n[i]])));
}
const rpc = samples.filter((s) => s.rpcOut);
if (rpc.length) {
  for (const v of variants) {
    const list = rpc.filter((s) => s.variant === v);
    const count = (tag) => list.map((s) => s.rpcOut[tag] ?? 0);
    console.log(
      `${v}: boot server.getConfig ${quantile(count("server.getConfig"), 0.5)} (max ${Math.max(...count("server.getConfig"))}), server.getSettings ${quantile(count("server.getSettings"), 0.5)} (max ${Math.max(...count("server.getSettings"))}); dispatch types ${JSON.stringify(list[0]?.dispatchTypes ?? {})}`,
    );
  }
}
