// Summarizes a V8 CPU profile (DevTools `Profiler.stop`) by function, package and forced
// layout reader. Frames of the production web bundle are resolved through its hidden
// sourcemaps when the build was made with SYNARA_WEB_SOURCEMAP=hidden.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

const LAYOUT_READERS = new Set([
  "getBoundingClientRect",
  "get scrollTop",
  "get scrollHeight",
  "get offsetHeight",
  "get offsetWidth",
  "get clientHeight",
  "getComputedStyle",
  "get clientWidth",
  "get offsetTop",
]);

const keyOf = (frame) => `${frame.name} @ ${frame.source}${frame.line ? `:${frame.line}` : ""}`;

const bucketOf = (source) => {
  const nm = source.lastIndexOf("node_modules/");
  if (nm === -1) return source;
  const rest = source
    .slice(nm + "node_modules/".length)
    .replace(/^\.bun\/[^/]+\/node_modules\//, "");
  const parts = rest.split("/");
  return `pkg:${parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]}`;
};

const sorted = (map, limit) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, ms]) => [key, Math.round(ms * 10) / 10]);

function loadTraceMapping(buildDir) {
  const bunModules = join(buildDir, "node_modules/.bun");
  const pkg = existsSync(bunModules)
    ? readdirSync(bunModules).find((name) => name.startsWith("@jridgewell+trace-mapping@"))
    : undefined;
  if (!pkg) return null;
  return createRequire(import.meta.url)(
    join(bunModules, pkg, "node_modules/@jridgewell/trace-mapping"),
  );
}

export function createProfileSummarizer(buildDir) {
  const traceMapping = loadTraceMapping(buildDir);
  const mapCache = new Map();
  const traceMapFor = (url) => {
    const file = basename(new URL(url).pathname);
    if (mapCache.has(file)) return mapCache.get(file);
    const path = join(buildDir, "apps/server/dist/client/assets", `${file}.map`);
    const map =
      traceMapping && existsSync(path)
        ? new traceMapping.TraceMap(readFileSync(path, "utf8"))
        : null;
    mapCache.set(file, map);
    return map;
  };
  const resolveFrame = (callFrame) => {
    const { url, lineNumber, columnNumber, functionName } = callFrame;
    if (!url || !url.startsWith("http")) {
      return { name: functionName || "(native)", source: url || "(native)" };
    }
    const map = traceMapFor(url);
    if (!map) return { name: functionName || "(anonymous)", source: basename(url) };
    const pos = traceMapping.originalPositionFor(map, {
      line: lineNumber + 1,
      column: columnNumber,
    });
    const source = (pos.source ?? basename(url)).replace(/^(\.\.\/)+/, "");
    return { name: pos.name || functionName || "(anonymous)", source, line: pos.line };
  };

  return function summarizeProfile(profile, { top = 45 } = {}) {
    const selfByNode = new Map();
    const deltas = profile.timeDeltas ?? [];
    for (let index = 0; index < profile.samples.length; index += 1) {
      const id = profile.samples[index];
      selfByNode.set(id, (selfByNode.get(id) ?? 0) + (deltas[index] ?? 0));
    }
    const frameOf = (node) => {
      const fn = node.callFrame.functionName;
      return fn === "(garbage collector)"
        ? { name: fn, source: "(gc)" }
        : resolveFrame(node.callFrame);
    };
    const byFunction = new Map();
    const byBucket = new Map();
    let total = 0;
    let idle = 0;
    for (const node of profile.nodes) {
      const self = (selfByNode.get(node.id) ?? 0) / 1000;
      if (self === 0) continue;
      const fn = node.callFrame.functionName;
      if (fn === "(idle)" || fn === "(program)") {
        idle += self;
        continue;
      }
      total += self;
      const frame = frameOf(node);
      byFunction.set(keyOf(frame), (byFunction.get(keyOf(frame)) ?? 0) + self);
      const bucket = bucketOf(frame.source);
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + self);
    }

    // Inclusive time per function, outermost occurrence only (recursion is not double counted).
    const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
    const totalByNode = new Map();
    const totalOf = (node) => {
      let sum = (selfByNode.get(node.id) ?? 0) / 1000;
      for (const childId of node.children ?? []) sum += totalOf(nodeById.get(childId));
      totalByNode.set(node.id, sum);
      return sum;
    };
    totalOf(profile.nodes[0]);
    const inclusive = new Map();
    const walk = (node, active) => {
      const fn = node.callFrame.functionName;
      const key = ["(root)", "(idle)", "(program)"].includes(fn) ? null : keyOf(frameOf(node));
      const added = key !== null && !active.has(key);
      if (added) {
        inclusive.set(key, (inclusive.get(key) ?? 0) + totalByNode.get(node.id));
        active.add(key);
      }
      for (const childId of node.children ?? []) walk(nodeById.get(childId), active);
      if (added) active.delete(key);
    };
    walk(profile.nodes[0], new Set());

    // Who forces layout: self time of layout-reading natives by their nearest callers.
    const parentOf = new Map();
    for (const node of profile.nodes) {
      for (const childId of node.children ?? []) parentOf.set(childId, node);
    }
    const layoutReaders = new Map();
    for (const node of profile.nodes) {
      const fn = node.callFrame.functionName;
      const self = (selfByNode.get(node.id) ?? 0) / 1000;
      if (!LAYOUT_READERS.has(fn) || self === 0) continue;
      const chain = [];
      let cursor = parentOf.get(node.id);
      while (cursor && chain.length < 3) {
        if (cursor.callFrame.functionName !== "(root)") {
          const frame = resolveFrame(cursor.callFrame);
          chain.push(
            `${frame.name}@${frame.source.replace(/.*node_modules\//, "")}${frame.line ? `:${frame.line}` : ""}`,
          );
        }
        cursor = parentOf.get(cursor.id);
      }
      const key = `${fn} <- ${chain.join(" <- ")}`;
      layoutReaders.set(key, (layoutReaders.get(key) ?? 0) + self);
    }
    const filtered = (predicate) =>
      new Map([...inclusive.entries()].filter(([key]) => predicate(key)));
    return {
      activeMs: Math.round(total),
      idleMs: Math.round(idle),
      byBucket: sorted(byBucket, top),
      byFunction: sorted(byFunction, top),
      inclusiveApp: sorted(
        filtered((key) => !key.includes("node_modules/") && !key.includes("(native)")),
        70,
      ),
      inclusiveLib: sorted(
        filtered((key) => key.includes("node_modules/")),
        40,
      ),
      layoutReaders: sorted(layoutReaders, 25),
    };
  };
}
