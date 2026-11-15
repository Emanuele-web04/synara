#!/usr/bin/env node
// Prints results files as Markdown tables, raw samples next to the median.
//   node benchmarks/desktop-perf/report.mjs <results.json> [<results.json> ...]
// Every (file, build) pair becomes a column; with two or more columns the last column
// also shows the change of its median against the first.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const files = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (files.length === 0) {
  console.error("usage: report.mjs <results.json> [<results.json> ...]");
  process.exit(1);
}
const columns = [];
for (const file of files) {
  const report = JSON.parse(readFileSync(file, "utf8"));
  for (const app of report.apps) {
    columns.push({
      title: `${app.id} ${app.version.split(" ")[0]} (${basename(file)
        .replace(/^desktop-perf-[0-9TZ-]+-/, "")
        .replace(/\.json$/, "")})`,
      tests: app.tests,
      report,
    });
  }
}
const keys = [];
for (const column of columns)
  for (const key of Object.keys(column.tests)) if (!keys.includes(key)) keys.push(key);

const cell = (test) => {
  if (!test) return "—";
  if (test.result) return `${test.result}: ${test.cause}`;
  const failed = test.failed ? `; ${test.failed} failed` : "";
  const samples = test.samples ? ` · [${test.samples.join(", ")}]` : "";
  return `**${test.median}** (${test.min}–${test.max}, n=${test.runs}${failed})${samples}`;
};
const change = (first, last) => {
  if (!first || !last || first.result || last.result || !first.median) return "";
  const percent = ((last.median - first.median) / first.median) * 100;
  const overlap = last.min <= first.max && first.min <= last.max;
  return ` → ${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%${overlap ? " (ranges overlap)" : ""}`;
};

console.log(`| Test | Unit | ${columns.map((column) => column.title).join(" | ")} |`);
console.log(`| --- | --- | ${columns.map(() => "---").join(" | ")} |`);
for (const key of keys) {
  const unit = columns.map((column) => column.tests[key]?.unit).find(Boolean) ?? "";
  const cells = columns.map(
    (column, index) =>
      cell(column.tests[key]) +
      (index > 0 && index === columns.length - 1
        ? change(columns[0].tests[key], column.tests[key])
        : ""),
  );
  console.log(`| ${key} | ${unit} | ${cells.join(" | ")} |`);
}
const machine = columns[0].report.machine;
console.log(
  `\nMachine: ${machine.chip}, ${machine.cores} cores, ${machine.memoryGb} GB, macOS ${machine.macos}. ${columns[0].report.rule}.`,
);
