// Maps a build's boot set from the chunk report of build-variant.mjs --report:
// the entry chunk's static closure (what must load and evaluate before
// DOMContentLoaded) and, given network samples of measure.mjs, the chunks the app
// actually fetched during boot, with their modules grouped by package or folder.
//
//   node benchmarks/web-boot/bootset.mjs <chunks.json> [--samples <network.json> --variant V2]
//     [--modules] [--top 25]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    samples: { type: "string" },
    variant: { type: "string" },
    modules: { type: "boolean", default: false },
    top: { type: "string", default: "25" },
  },
});
const chunks = JSON.parse(readFileSync(positionals[0], "utf8"));
const byFile = new Map(chunks.map((c) => [c.fileName, c]));
const top = Number(values.top);
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

function area(id) {
  const clean = id.replace(/\?.*$/, "").replace(/^\0/, "");
  const nm = clean.lastIndexOf("node_modules/");
  if (nm >= 0) {
    const rest = clean.slice(nm + "node_modules/".length).split("/");
    return `npm:${rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]}`;
  }
  const app = /(apps\/web\/src\/(?:[^/]+\/)?|packages\/[^/]+\/)/.exec(clean);
  return app ? app[1] : clean.slice(-60);
}

function closureOf(roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !byFile.has(file)) continue;
    seen.add(file);
    stack.push(...byFile.get(file).imports);
  }
  return [...seen];
}

function describe(label, files) {
  const modules = files.flatMap((f) => Object.entries(byFile.get(f)?.modules ?? {}));
  const total = modules.reduce((s, [, n]) => s + n, 0);
  const areas = new Map();
  for (const [id, n] of modules) areas.set(area(id), (areas.get(area(id)) ?? 0) + n);
  console.log(
    `\n## ${label}: ${files.length} chunks, ${modules.length} modules, ${kb(total)} rendered`,
  );
  for (const [name, n] of [...areas].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`${kb(n).padStart(8)}  ${name}`);
  }
  if (values.modules) {
    console.log("### largest modules");
    for (const [id, n] of modules.sort((a, b) => b[1] - a[1]).slice(0, top)) {
      console.log(
        `${kb(n).padStart(8)}  ${id.replace(/^.*?(apps\/|packages\/|node_modules\/)/, "$1")}`,
      );
    }
  }
  return { files, modules: new Map(modules), total };
}

const entry = chunks.find((c) => c.isEntry);
describe(`entry ${entry.fileName} static closure`, closureOf([entry.fileName]));

if (values.samples) {
  const samples = JSON.parse(readFileSync(values.samples, "utf8")).filter(
    (s) => !values.variant || s.variant === values.variant,
  );
  const sample = samples[0];
  const js = sample.resourceList.filter((r) => /\/assets\/.+\.js$/.test(r.url));
  const loaded = js
    .map((r) => r.url.replace(/^\/assets\//, "assets/"))
    .filter((f) => byFile.has(f));
  const beforeSplash = js
    .filter((r) => r.start < sample.splashGoneMs)
    .map((r) => r.url.replace(/^\/assets\//, "assets/"))
    .filter((f) => byFile.has(f));
  console.log(
    `\n# runtime boot set of ${sample.variant} (round ${sample.round}): ${js.length} JS fetched`,
  );
  describe("fetched before the splash was removed", beforeSplash);
  describe("fetched in the whole settle window", loaded);
}
