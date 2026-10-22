import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { taskFixture } from "./notion-tasks-fixture.mjs";

const root = process.cwd();
const web = path.join(root, "apps/web");
const require = createRequire(path.join(web, "package.json"));
const { build } = await import(require.resolve("vite"));
const { default: react } = await import(require.resolve("@vitejs/plugin-react"));
const { default: tailwind } = await import(require.resolve("@tailwindcss/vite"));
const { chromium } = require("playwright");
const temp = await fs.mkdtemp(path.join(web, ".notion-evidence-"));
const out = process.env.NOTION_EVIDENCE_DIR || path.join(temp, "evidence");
await fs.mkdir(out, { recursive: true });
const beforeRef = "9fc733ad9b7a96859922abb18820134981f966b5";
const before = path.join(temp, "before");
await fs.mkdir(before);
execFileSync("tar", ["-x", "-C", before], {
  input: execFileSync("git", ["archive", beforeRef, "apps/web/src"], {
    maxBuffer: 80 * 1024 * 1024,
  }),
});
const native = path.join(temp, "native.ts");
await fs.writeFile(
  native,
  `
export const ensureNativeApi = () => globalThis.__notionApi;
export const getNativeApi = ensureNativeApi;
export const readNativeApi = ensureNativeApi;
export const readNativeApiServerCapability = () => true;
export const onNativeApiServerCapabilitiesChange = () => () => {};
`,
);
const entry = path.join(temp, "entry.tsx");
await fs.writeFile(entry, taskFixture);
let html = "";
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const evidence = {
  beforeRef,
  afterRef: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  kind: "Actual Synara components with fixture transport; not live OAuth or a full application E2E",
  browser: browser.version(),
  screenshots: [],
  checks: [],
};
try {
  for (const version of ["before", "after"]) {
    const source = version === "before" ? path.join(before, "apps/web/src") : path.join(web, "src");
    const bundle = await build({
      configFile: false,
      root: web,
      logLevel: "warn",
      plugins: [
        {
          name: "notion-fixture-transport",
          enforce: "pre",
          resolveId(id) {
            if (/(?:^|\/)nativeApi(?:\.ts)?$/.test(id)) return native;
          },
        },
        react(),
        tailwind(),
      ],
      resolve: { alias: [{ find: "~", replacement: source }] },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        write: false,
        minify: false,
        assetsInlineLimit: 10_000_000,
        rollupOptions: { input: entry, output: { format: "iife", inlineDynamicImports: true } },
      },
    });
    const output = Array.isArray(bundle) ? bundle.flatMap((item) => item.output) : bundle.output;
    const script = output
      .filter((item) => item.type === "chunk")
      .map((item) => item.code)
      .join("\n");
    const css = output
      .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
      .map((item) => String(item.source))
      .join("\n");
    html =
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
      css +
      '</style></head><body><div id="root"></div><script>' +
      script.replaceAll("</script", "<\\/script") +
      "</script></body></html>";
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const url = "http://127.0.0.1:" + server.address().port;
    const ready = async () => {
      await page.goto(url);
      await page.getByText("Review OAuth permissions", { exact: true }).first().waitFor();
      await page.evaluate(() => globalThis.__setTheme("dark"));
    };
    const shot = async (name) => {
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const file = version + "-" + name + ".png";
      await page.screenshot({ path: path.join(out, file), fullPage: true });
      evidence.screenshots.push(file);
    };
    await ready();
    await shot("tasks-dark");
    if (version === "after") {
      await page.getByRole("button", { name: "Filter tasks", exact: true }).click();
      await shot("task-filters");
      await page.getByText("Review OAuth permissions", { exact: true }).first().click();
      await page.getByRole("button", { name: "Edit task properties", exact: true }).waitFor();
      await page.getByLabel("Task source", { exact: true }).click();
      await page.getByRole("option", { name: "Local Synara tasks", exact: true }).click();
      await page.getByText("1 of 2 tasks match these filters.", { exact: true }).waitFor();
      assert(
        await page.getByRole("button", { name: "Edit task properties", exact: true }).isVisible(),
      );
      evidence.checks.push("Source filtering retains the selected imported task card.");
      await shot("filtered-open-task");
      await page.getByRole("button", { name: "Clear filters", exact: true }).click();
      await page.evaluate(() => globalThis.__incoming());
      await page.getByText("New colleague-assigned task", { exact: true }).first().waitFor();
      evidence.checks.push("An incoming todo-upserted event appears in the existing Tasks list.");
      assert.equal(await page.evaluate(() => globalThis.__writes.length), 0);
      await ready();
      await page.getByRole("button", { name: "Notion workspace", exact: true }).click();
      await page.getByRole("heading", { name: "Connected Notion work", exact: true }).waitFor();
      await shot("connected-workspace");
      await page.getByRole("button", { name: /Engineering tasks/ }).click();
      await page.getByRole("heading", { name: "Engineering tasks", exact: true }).waitFor();
      await shot("mapped-database");
      evidence.checks.push(
        "The Tasks launcher opens the existing mapped database workspace without Settings.",
      );
    }
    await ready();
    await page.setViewportSize({ width: 390, height: 844 });
    await shot("tasks-narrow");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => globalThis.__setTheme("light"));
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    await shot("tasks-light");
    assert.equal(await page.evaluate(() => globalThis.__renderError || null), null);
    assert.deepEqual(errors, []);
    evidence.checks.push(version + ": light/dark, narrow layout and no JavaScript page errors.");
    await page.close();
  }
} finally {
  await fs.writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
