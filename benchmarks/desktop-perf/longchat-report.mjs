#!/usr/bin/env node
// Tables for longchat.mjs results: median (min–max) [raw samples] per build, and the
// change of the last build's median against the first. A change marked "≈ spread" puts
// the last median inside the first build's min–max range: no difference shown. Several files are merged, so builds measured in separate
// sessions can be compared (prefer one session with two --build flags: it alternates).
//   node benchmarks/desktop-perf/longchat-report.mjs <results.json> [...]
import { readFileSync } from "node:fs";

import { median } from "./lib/stats.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: longchat-report.mjs <results.json> [...]");
  process.exit(1);
}
const samples = files.flatMap((file) => {
  const data = JSON.parse(readFileSync(file, "utf8"));
  // Also reads the pre-suite scratch format ({ runs: [...] }, one build per file).
  return data.samples ?? data.runs.map((run) => ({ ...run, build: data.label }));
});
const valid = samples.filter((sample) => !sample.failed);
const builds = [...new Set(valid.map((sample) => sample.build))];
const sum = (...numbers) =>
  numbers.some((n) => typeof n !== "number")
    ? undefined
    : Math.round(numbers.reduce((a, b) => a + b, 0) * 10) / 10;

const METRICS = [
  ["cold: first row ms", (t) => t.cold.firstRowMs],
  ["cold: at bottom ms", (t) => t.cold.bottomMs],
  ["cold: long tasks ms", (t) => t.cold.longTaskMs],
  ["cold: script ms", (t) => t.cold.main.scriptMs],
  ["cold: style+layout ms", (t) => sum(t.cold.main.styleMs, t.cold.main.layoutMs)],
  ["cold: snapshot KB", (t) => t.cold.wsLargestFrameKb],
  [
    "cold: snapshot arrival ms",
    (t) => t.cold.wsLargestFrameAfterPressMs ?? t.cold.wsLargestFrameAfterClickMs,
  ],
  ["retained heap MB", (t) => t.retainedHeapMb],
  ["warm: at bottom ms", (t) => t.warm.bottomMs],
  ["warm: long tasks ms", (t) => t.warm.longTaskMs],
  ["warm: script ms", (t) => t.warm.main.scriptMs],
  ["wheel: main busy ms", (t) => t.scrollWheel?.main.taskMs],
  ["wheel: script ms", (t) => t.scrollWheel?.main.scriptMs],
  ["fling: main busy ms", (t) => t.scrollFling?.main.taskMs],
  ["fling: script ms", (t) => t.scrollFling?.main.scriptMs],
  [
    "fling: style+layout ms",
    (t) => t.scrollFling && sum(t.scrollFling.main.styleMs, t.scrollFling.main.layoutMs),
  ],
  ["fling: long tasks", (t) => t.scrollFling?.longTasks],
  ["fling revisit: script ms", (t) => t.scrollFlingRevisit?.main.scriptMs],
  ["fling: blank >25% frames", (t) => t.blankFling?.framesBlankOver25pct],
  ["rows mounted", (t) => t.scrollWheel?.dom.rowsMounted],
  ["transcript DOM nodes", (t) => t.scrollWheel?.dom.scrollerNodes],
];

const threadNames = [...new Set(valid.flatMap((sample) => Object.keys(sample.threads)))];
console.log(`samples: ${valid.length} valid of ${samples.length}; builds: ${builds.join(", ")}`);
console.log(
  'cells: median (min–max) [samples]; "≈ spread": the last median lies inside the first build\'s range',
);
for (const name of threadNames) {
  console.log(`\n## ${name}\n`);
  console.log(`| metric | ${builds.join(" | ")} |${builds.length > 1 ? " change |" : ""}`);
  console.log(
    `| --- | ${builds.map(() => "---").join(" | ")} |${builds.length > 1 ? " --- |" : ""}`,
  );
  for (const [label, pick] of METRICS) {
    const perBuild = builds.map((build) =>
      valid
        .filter((sample) => sample.build === build && sample.threads[name])
        .map((sample) => pick(sample.threads[name]))
        .filter((number) => typeof number === "number"),
    );
    if (perBuild.every((numbers) => numbers.length === 0)) continue;
    const medians = perBuild.map((numbers) => {
      const value = median(numbers);
      return value === null ? null : Math.round(value * 10) / 10;
    });
    const cells = perBuild.map((numbers, index) =>
      numbers.length === 0
        ? "-"
        : `${medians[index]} (${Math.min(...numbers)}–${Math.max(...numbers)}) [${numbers.join(", ")}]`,
    );
    const first = medians[0];
    const last = medians.at(-1);
    const withinFirstSpread =
      typeof last === "number" &&
      perBuild[0].length > 0 &&
      last >= Math.min(...perBuild[0]) &&
      last <= Math.max(...perBuild[0]);
    const change =
      builds.length > 1 && typeof first === "number" && typeof last === "number" && first !== 0
        ? ` ${last - first > 0 ? "+" : ""}${Math.round(((last - first) / first) * 1000) / 10}%${withinFirstSpread ? " ≈ spread" : ""} |`
        : builds.length > 1
          ? " - |"
          : "";
    console.log(`| ${label} | ${cells.join(" | ")} |${change}`);
  }
}
