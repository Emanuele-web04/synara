#!/usr/bin/env node
// FILE: hugeicon-snippet.mjs
// Purpose: Print the `createHugeicon(...)` entry for src/lib/hugeicons.tsx from a Hugeicons
//          name, so adding an icon never means installing the icon package or copying
//          paths by hand. Fetches only the named icons' own modules from unpkg.
// Usage: node apps/web/scripts/hugeicon-snippet.mjs plus-sign layout-left [...]
//        (names as on hugeicons.com, stroke · rounded style)

const PACKAGE = "@hugeicons/core-free-icons";
// Keep in step with the version named in src/lib/hugeicons.tsx.
const VERSION = "4.3.5";
const BASE_URL = `https://unpkg.com/${PACKAGE}@${VERSION}`;

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("Usage: node apps/web/scripts/hugeicon-snippet.mjs <icon-name> [...]");
  process.exit(1);
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.text();
}

function toExportName(name) {
  const pascal = name
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  return pascal.endsWith("Icon") ? pascal : `${pascal}Icon`;
}

// A few modules keep a different casing than their export name (ArrowDownAZIcon for
// ArrowDownAzIcon); the package's exports map lists exactly those.
const packageJson = JSON.parse(await fetchText(`${BASE_URL}/package.json`));

async function loadIconNodes(exportName) {
  const modulePath =
    packageJson.exports?.[`./${exportName}`]?.import ?? `./dist/esm/${exportName}.js`;
  const source = await fetchText(`${BASE_URL}/${modulePath.replace(/^\.\//, "")}`);
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  return module.default;
}

// A <circle> is drawn as the two-arc path it is equivalent to, since createHugeicon draws paths only.
function circleToPath({ cx, cy, r, ...rest }) {
  const [x, y, radius] = [Number(cx), Number(cy), Number(r)];
  const d = `M${x - radius} ${y}A${radius} ${radius} 0 1 0 ${x + radius} ${y}A${radius} ${radius} 0 1 0 ${x - radius} ${y}Z`;
  return { ...rest, d };
}

function toPathEntry(exportName, [tag, nodeAttributes]) {
  if (tag !== "path" && tag !== "circle") {
    throw new Error(`${exportName}: <${tag}> is not supported; createHugeicon draws paths only.`);
  }
  const attributes = tag === "circle" ? circleToPath(nodeAttributes) : nodeAttributes;
  const { d, key: _key, stroke, strokeWidth, strokeLinecap, strokeLinejoin, ...rest } = attributes;
  const unsupported = Object.keys(rest);
  if (stroke !== "currentColor" || strokeWidth !== "1.5" || unsupported.length > 0) {
    throw new Error(
      `${exportName}: not a plain 1.5 stroke path (${JSON.stringify(attributes)}); pick the stroke · rounded style.`,
    );
  }
  const roundCap = strokeLinecap === "round";
  const roundJoin = strokeLinejoin === "round";
  const flag = roundCap && roundJoin ? "round" : roundCap ? "roundCap" : "roundJoin";
  return roundCap || roundJoin
    ? `  { d: ${JSON.stringify(d)}, ${flag}: true },`
    : `  { d: ${JSON.stringify(d)} },`;
}

for (const name of names) {
  const exportName = toExportName(name);
  const nodes = await loadIconNodes(exportName);
  const entries = nodes.map((node) => toPathEntry(exportName, node));
  console.log(
    [
      `/** TODO: what it marks in the app (\`${name}\`). */`,
      `export const ${exportName} = createHugeicon(${JSON.stringify(exportName)}, [`,
      ...entries,
      "]);",
      "",
    ].join("\n"),
  );
}
