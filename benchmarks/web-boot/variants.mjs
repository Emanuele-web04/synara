// Chunking variants measured in RESULTS.md. Each value replaces
// `build.rolldownOptions.output.codeSplitting` of apps/web/vite.config.ts at build time
// (build-variant.mjs); `undefined` removes the block. Copies, not imports, so a variant
// stays reproducible after the real config changes. apps/web/vite.config.ts implements
// V8 through apps/web/scripts/boot-chunk-groups.ts (byte-identical build output).

import path from "node:path";

const WEB_SRC = path.resolve(import.meta.dirname, "../../apps/web/src");
const nodeModule = (pattern) => new RegExp(`node_modules[\\\\/](?:${pattern})[\\\\/]`);

// V1: the chunk groups of PR #2266 at 976558c0c / a9f6be036, verbatim.
const V1 = {
  minSize: 20_000,
  groups: [
    {
      name: "vendor-react",
      test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
      priority: 40,
    },
    { name: "vendor-tanstack", test: /node_modules[\\/]@tanstack[\\/]/, priority: 35 },
    { name: "vendor-base-ui", test: /node_modules[\\/]@base-ui[\\/]/, priority: 35 },
    { name: "vendor-effect", test: /node_modules[\\/]effect[\\/]/, priority: 30 },
    {
      name: "vendor-icons",
      test: /node_modules[\\/](?:@tabler[\\/]icons-react|react-icons|lucide-react)[\\/]/,
      priority: 30,
    },
    {
      name: "vendor-lexical",
      test: /node_modules[\\/](?:lexical|@lexical)[\\/]/,
      minShareCount: 2,
      priority: 30,
    },
    {
      name: "vendor-markdown",
      test: /node_modules[\\/](?:react-markdown|remark-gfm|mdast-|micromark|unist-|hast-|vfile|property-information|comma-separated-tokens|space-separated-tokens|trim-lines|ccount|devlop|decode-named-character-reference|character-entities|bail|trough|unified|is-plain-obj|extend|html-url-attributes)/,
      minShareCount: 2,
      priority: 28,
    },
    { name: "vendor-i18n", test: /node_modules[\\/](?:i18next|react-i18next)[\\/]/, priority: 25 },
    {
      name: "app-shared-contracts",
      test: (id) => id.includes("/packages/contracts/") || id.includes("/packages/shared/"),
      minShareCount: 2,
      priority: 22,
    },
    {
      name: "app-ui-primitives",
      test: /apps[\\/]web[\\/]src[\\/]components[\\/]ui[\\/]/,
      minShareCount: 2,
      priority: 20,
    },
    {
      name: "app-lib-core",
      test: (id) =>
        id.includes("/apps/web/src/lib/") &&
        !id.includes("diffRendering") &&
        !id.includes("syntaxHighlighting") &&
        !id.includes("editorGutterDiff") &&
        !id.includes("fileDiffTree"),
      minShareCount: 2,
      priority: 18,
    },
    {
      name: "vendor-core",
      test: (id) =>
        id.includes("/node_modules/") &&
        !/node_modules[\\/](?:monaco-editor|@xterm|katex|pdfjs-dist|@pierre[\\/]diffs|shiki|@shikijs|mermaid|recharts|d3-|cytoscape|elkjs|html-to-image|rehype-katex|remark-math|rehype-raw|rehype-sanitize|@tanstack[\\/]react-virtual)/.test(
          id,
        ),
      minShareCount: 2,
      priority: 10,
    },
  ],
};

// Every module of the entry's static closure (rolldown's built-in `$initial` tag) goes to
// this group first, so no later group can capture one through its dependencies and make
// the entry import that group.
const initialGroup = { name: "boot", tags: ["$initial"], priority: 100 };

// V3: vendor groups only, for the packages a cold boot fetches, behind the initial guard.
const V3 = {
  groups: [
    initialGroup,
    { name: "vendor-react", test: nodeModule("react|react-dom|scheduler"), priority: 40 },
    { name: "vendor-base-ui", test: nodeModule("@base-ui"), priority: 35 },
    {
      name: "vendor-tanstack",
      test: nodeModule(
        "@tanstack[\\\\/](?:react-router|router-core|history|query-core|react-query|store|react-store)",
      ),
      priority: 35,
    },
    { name: "vendor-effect", test: nodeModule("effect"), priority: 30 },
    { name: "vendor-i18n", test: nodeModule("i18next|react-i18next"), priority: 25 },
  ],
};

// Static import closure of each boot root, minus the roots before it. A cold boot loads
// all of them in this order: bootstrap.ts imports main.tsx, every route renders inside
// the _chat layout, and usePreloadRouteChunks warms the thread route.
const BOOT_ROOTS = [
  ["boot-main", path.join(WEB_SRC, "main.tsx")],
  ["boot-chat", `${path.join(WEB_SRC, "routes/_chat.tsx")}?tsr-split=component`],
  ["boot-thread", `${path.join(WEB_SRC, "routes/_chat.$threadId.tsx")}?tsr-split=component`],
];
// One group per root, highest priority first: a group pulls its modules' dependencies in
// with it (includeDependenciesRecursively), so a later root's group must not run before
// an earlier one or it takes modules the earlier chunk then has to import.
function bootClosureGroups({
  roots = BOOT_ROOTS,
  priority = 60,
  maxSize,
  splitVendor = false,
} = {}) {
  let owner = null;
  const ownerOf = (id, ctx) => {
    if (owner === null) {
      owner = new Map();
      // The entry's own closure belongs to the initial group.
      const queue = [[null, path.join(WEB_SRC, "bootstrap.ts")], ...roots];
      for (const [name, root] of queue) {
        const stack = [root];
        while (stack.length > 0) {
          const moduleId = stack.pop();
          if (owner.has(moduleId)) continue;
          const info = ctx.getModuleInfo(moduleId);
          if (!info) continue;
          owner.set(moduleId, name);
          stack.push(...info.importedIds);
        }
      }
    }
    return owner.get(id) ?? null;
  };
  if (splitVendor) {
    // npm modules of a step first (they never import app code, so no cycle), then the rest.
    return roots.flatMap(([name], index) => [
      {
        name: (id, ctx) => (ownerOf(id, ctx) === name ? `${name}-vendor` : null),
        test: /[\\/]node_modules[\\/]/,
        priority: priority - 2 * index,
      },
      {
        name: (id, ctx) => (ownerOf(id, ctx) === name ? name : null),
        priority: priority - 2 * index - 1,
      },
    ]);
  }
  return roots.map(([name], index) => ({
    name: (id, ctx) => (ownerOf(id, ctx) === name ? name : null),
    priority: priority - index,
    ...(maxSize ? { maxSize } : {}),
  }));
}

// V4: entry-aware groups. The initial closure is one chunk; each later boot root's new
// modules are one chunk; everything else keeps rolldown's automatic chunking.
const V4 = { groups: [initialGroup, ...bootClosureGroups()] };

// V5: V4 with a size cap on the boot-root groups (not the initial group: capping it splits
// the entry closure into many small chunks).
const V5 = { groups: [initialGroup, ...bootClosureGroups({ maxSize: 1_000_000 })] };

// V4b: V4 with the initial closure in three chunks (npm packages, packages/*, apps/web)
// instead of one, so it downloads and compiles in parallel. Three groups, dependencies
// first: one group with a name function puts the entry module in "boot", and the entry's
// dependencies follow it there (includeDependenciesRecursively) before any other name.
const V4b = {
  groups: [
    { name: "boot-vendor", tags: ["$initial"], test: /node_modules[\\/]/, priority: 102 },
    { name: "boot-shared", tags: ["$initial"], test: /[\\/]packages[\\/]/, priority: 101 },
    initialGroup,
    ...bootClosureGroups(),
  ],
};

// V7: V4b with every boot step split into its npm part and its app part, so no single
// script's main-thread compile finalization and instantiation is one 2 MB task.
const V7 = {
  groups: [...V4b.groups.slice(0, 3), ...bootClosureGroups({ splitVendor: true })],
};

// V8: V4b with every boot step cut into bands of about `bandBytes` of module code, so
// no script's main-thread compile finalization is one long task. Bands follow a
// topological order of the step's import graph with each strongly connected component
// kept whole, dependencies first, so a band only imports earlier bands: no chunk cycle.
function bootBandGroups({ roots = BOOT_ROOTS, priority = 99, bandBytes = 1_000_000 } = {}) {
  let bandOf = null;
  const assign = (ctx) => {
    const owner = new Map();
    const queue = [[null, path.join(WEB_SRC, "bootstrap.ts")], ...roots];
    for (const [name, root] of queue) {
      const stack = [root];
      while (stack.length > 0) {
        const id = stack.pop();
        if (owner.has(id)) continue;
        const info = ctx.getModuleInfo(id);
        if (!info) continue;
        owner.set(id, name);
        stack.push(...info.importedIds);
      }
    }
    bandOf = new Map();
    const report = [];
    for (const [step] of roots) {
      const members = [...owner].filter(([, name]) => name === step).map(([id]) => id);
      const inStep = new Set(members);
      // Tarjan: components come out dependencies first.
      let index = 0;
      const order = new Map();
      const low = new Map();
      const onStack = new Set();
      const stack = [];
      const components = [];
      const visit = (v) => {
        order.set(v, index);
        low.set(v, index);
        index += 1;
        stack.push(v);
        onStack.add(v);
        for (const w of ctx.getModuleInfo(v)?.importedIds ?? []) {
          if (!inStep.has(w)) continue;
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
          components.push(component);
        }
      };
      for (const id of members) if (!order.has(id)) visit(id);
      let band = 0;
      let bytes = 0;
      const sizes = [];
      for (const component of components) {
        // Source length, capped: a huge module is mostly tree-shaken data (icon sets), and
        // counting it whole would give it a near-empty band of its own.
        const size = component.reduce(
          (sum, id) => sum + Math.min(ctx.getModuleInfo(id)?.code?.length ?? 0, 150_000),
          0,
        );
        if (bytes > 0 && bytes + size > bandBytes) {
          sizes.push(bytes);
          band += 1;
          bytes = 0;
        }
        bytes += size;
        for (const id of component) bandOf.set(id, `${step}-${band}`);
      }
      sizes.push(bytes);
      const largest = Math.max(...components.map((c) => c.length));
      report.push(
        `${step}: ${sizes.length} bands [${sizes.map((b) => Math.round(b / 1024)).join(", ")}] KB, largest SCC ${largest} modules`,
      );
    }
    console.info(`[web-boot] ${report.join("; ")}`);
  };
  const groups = [];
  // Enough groups for the largest step; unused names capture nothing.
  for (const [step] of roots) {
    for (let band = 0; band < 40; band += 1) {
      groups.push({
        name: (id, ctx) => {
          if (bandOf === null) assign(ctx);
          return bandOf.get(id) === `${step}-${band}` ? `${step}-${band}` : null;
        },
        priority: (priority -= 1),
      });
    }
  }
  return groups;
}
const V8 = { groups: [...V4b.groups.slice(0, 3), ...bootBandGroups()] };

// V6: V4 plus a modulepreload of the boot-main chunk in index.html, so it downloads and
// compiles while the entry evaluates and connects, instead of after. Modulepreload does
// not evaluate: DOMContentLoaded still waits only for the entry's own closure.
const V6 = { groups: [initialGroup, ...bootClosureGroups()] };
function preloadChunks(names) {
  return {
    name: "web-boot-preload-chunks",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        return Object.values(ctx.bundle ?? {})
          .filter((item) => item.type === "chunk" && names.includes(item.name))
          .map((chunk) => ({
            tag: "link",
            attrs: { rel: "modulepreload", crossorigin: true, href: `/${chunk.fileName}` },
            injectTo: "head",
          }));
      },
    },
  };
}

export const variants = { V1, V2: undefined, V3, V4, V4b, V5, V6, V7, V8 };
// Extra build plugins per variant (build-variant.mjs adds them).
export const variantPlugins = { V6: [preloadChunks(["boot-main"])] };
