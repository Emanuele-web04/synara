// Checks the code-splitting group semantics RESULTS.md (R1) relies on, against the
// rolldown that Vite uses here, on a nine-module fixture written to a temporary directory.
//
//   node benchmarks/web-boot/rolldown-semantics.mjs
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HARNESS_REPO } from "./lib.mjs";

// Vite's own rolldown, next to Vite in bun's isolated store.
const viteDir = realpathSync(path.join(HARNESS_REPO, "apps/web/node_modules/vite"));
const rolldownDir = path.join(viteDir, "../rolldown");
const { rolldown, VERSION } = await import(
  pathToFileURL(path.join(rolldownDir, "dist/index.mjs")).href
);
const pad = (tag) => `${tag}-${"x".repeat(60)}`;
const files = {
  "entry.js": `import { a } from "./a.js";\nimport { e1 } from "./entryOnly.js";\nconsole.log(a, e1);\nexport const lazy1 = () => import("./lazy1.js");\nexport const lazy2 = () => import("./lazy2.js");\nexport const lazy3 = () => import("./lazy3.js");\n`,
  "a.js": `import { d } from "./dep.js";\nexport const a = "${pad("a")}" + d;\n`,
  "dep.js": `export const d = "${pad("dep")}";\n`,
  "entryOnly.js": `export const e1 = "${pad("entryOnly")}";\n`,
  "lazy1.js": `import { s } from "./shared.js";\nimport { a } from "./a.js";\nimport { o } from "./onlyLazy1.js";\nexport const l1 = s + a + o;\n`,
  "lazy2.js": `import { s } from "./shared.js";\nimport { s2 } from "./shared2.js";\nexport const l2 = s + s2;\n`,
  "lazy3.js": `import { s2 } from "./shared2.js";\nexport const l3 = s2;\n`,
  "shared.js": `import { sd } from "./sharedDep.js";\nexport const s = "${pad("shared")}" + sd;\n`,
  "sharedDep.js": `export const sd = "${pad("sharedDep")}";\n`,
  "shared2.js": `export const s2 = "${pad("shared2")}";\n`,
  "onlyLazy1.js": `export const o = "${pad("onlyLazy1")}";\n`,
};
const dir = mkdtempSync(path.join(tmpdir(), "rolldown-semantics-"));
for (const [name, code] of Object.entries(files)) writeFileSync(path.join(dir, name), code);
const base = (id) => path.basename(id);
const notEntry = (id) => !id.endsWith("entry.js");
const notLazyEntry = (id) => notEntry(id) && !/lazy\d\.js$/.test(id);

async function run(label, codeSplitting) {
  const bundle = await rolldown({ input: path.join(dir, "entry.js"), logLevel: "silent" });
  const out = await bundle.generate({ format: "es", codeSplitting });
  console.log(`\n## ${label}`);
  for (const c of out.output) {
    if (c.type !== "chunk") continue;
    const kind = c.isEntry ? "entry  " : c.isDynamicEntry ? "dynamic" : "shared ";
    console.log(
      `${kind} ${c.name.padEnd(14)} [${c.moduleIds.map(base).join(", ")}] imports [${c.imports.join(", ")}]`,
    );
  }
  await bundle.close();
}

try {
  console.log(`rolldown ${VERSION}`);
  await run("automatic chunking", true);
  await run("minShareCount 2 counts dynamic entries", {
    groups: [{ name: "G", test: /shared2?\.js$/, minShareCount: 2 }],
  });
  await run("minShareCount 3", {
    groups: [{ name: "G", test: /shared2?\.js$/, minShareCount: 3 }],
  });
  await run("includeDependenciesRecursively (default true) pulls dep.js in", {
    groups: [{ name: "G", test: /[\\/]a\.js$/ }],
  });
  await run("includeDependenciesRecursively false: group imports the entry back", {
    groups: [{ name: "G", test: /[\\/]a\.js$/, includeDependenciesRecursively: false }],
  });
  await run("tags $initial keeps lazy-only modules out", {
    groups: [{ name: "G", test: notEntry, tags: ["$initial"] }],
  });
  await run("catch-all without tags swallows lazy entries", {
    groups: [{ name: "G", test: notEntry }],
  });
  await run("entriesAware", { groups: [{ name: "G", test: notLazyEntry, entriesAware: true }] });
  await run("overlapping groups: higher priority wins", {
    groups: [
      { name: "Low", test: /shared/, priority: 1 },
      { name: "High", test: /shared2/, priority: 5 },
    ],
  });
  await run("name(id, ctx) sees the module graph", {
    groups: [
      {
        name: (id, ctx) => {
          if (!id.includes("shared")) return null;
          const info = ctx.getModuleInfo(id);
          console.log(
            `  name(${base(id)}): importers [${info.importers.map(base)}], isEntry ${info.isEntry}`,
          );
          return `N-${base(id).replace(".js", "")}`;
        },
      },
    ],
  });
  await run("maxSize 120 bytes", { groups: [{ name: "G", test: notLazyEntry, maxSize: 120 }] });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
