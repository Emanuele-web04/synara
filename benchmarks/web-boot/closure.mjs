// Static-import closure of index.html's entry (script + modulepreloads) and of the route
// chunks, raw and brotli, plus static chunk-import cycles (a cycle between chunks can
// evaluate a module before its dependency and fail at runtime while the build succeeds).
//
//   node benchmarks/web-boot/closure.mjs <dist>
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { brotliCompressSync } from "node:zlib";
import { join } from "node:path";

const dist = process.argv[2];
const assets = join(dist, "assets");
const files = readdirSync(assets).filter((f) => f.endsWith(".js"));
const staticRe = /(?:from|import)\s*"\.\/([^"]+\.js)"/g;
const graph = new Map();
const size = new Map();
for (const file of files) {
  const full = join(assets, file);
  const src = readFileSync(full, "utf8");
  const deps = new Set();
  for (const m of src.matchAll(staticRe)) deps.add(m[1]);
  graph.set(file, deps);
  const br = existsSync(full + ".br")
    ? statSync(full + ".br").size
    : brotliCompressSync(readFileSync(full)).length;
  size.set(file, { raw: statSync(full).size, br });
}
const closure = (roots) => {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !graph.has(f)) continue;
    seen.add(f);
    for (const d of graph.get(f)) stack.push(d);
  }
  let raw = 0,
    br = 0;
  for (const f of seen) {
    raw += size.get(f).raw;
    br += size.get(f).br;
  }
  return { files: seen.size, rawKB: Math.round(raw / 1024), brKB: Math.round(br / 1024) };
};
const html = readFileSync(join(dist, "index.html"), "utf8");
const entryScripts = [...html.matchAll(/<script[^>]+src="\/?assets\/([^"]+\.js)"/g)].map(
  (m) => m[1],
);
const preloads = [
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?assets\/([^"]+\.js)"/g),
].map((m) => m[1]);
const find = (re) => files.filter((f) => re.test(f));
// Tarjan's strongly connected components over static chunk imports.
function importCycles() {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const order = new Map();
  const low = new Map();
  const cycles = [];
  const visit = (v) => {
    order.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!order.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), order.get(w)));
    }
    if (low.get(v) === order.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) cycles.push(component);
    }
  };
  for (const file of graph.keys()) if (!order.has(file)) visit(file);
  return cycles;
}
const out = {
  entryFile: entryScripts.map((f) => ({ f, ...size.get(f) })),
  entryStaticClosure: closure([...entryScripts, ...preloads]),
  threadRoute: find(/^_chat\.\$threadId|^_chat\._threadId|threadId/).map((f) => ({
    f,
    closure: closure([f]),
  })),
  chatLayout: find(/^_chat-|^_chat\.[A-Za-z0-9_-]{6,}\.js$/).map((f) => ({
    f,
    closure: closure([f]),
  })),
  totalJs: closure(files),
  chunkImportCycles: importCycles(),
};
console.log(JSON.stringify(out, null, 1));
