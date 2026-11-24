// Boots one production build on a copy of the seeded home and drives the boot path plus
// lazy surfaces, to prove a chunking change still evaluates and resolves at runtime (a
// chunk-import cycle or a missing chunk can build cleanly and fail here). No provider
// session is started; the composer text is typed, never sent.
//
//   node benchmarks/web-boot/smoke-ui.mjs --data <dir> --variant name=<checkout>[@<dist>] \
//     [--port 3932] [--screenshots <dir>]
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { assertPortFree, launchWarmBrowser, parseVariant, startServer } from "./lib.mjs";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    variant: { type: "string" },
    port: { type: "string", default: "3932" },
    screenshots: { type: "string" },
  },
});
if (!values.data || !values.variant) {
  console.error(
    "usage: --data <dir> --variant name=<checkout>[@<dist>] [--port] [--screenshots <dir>]",
  );
  process.exit(2);
}
const variant = parseVariant(values.variant);
const port = Number(values.port);
assertPortFree(port);
if (values.screenshots) mkdirSync(values.screenshots, { recursive: true });

const checks = [];
const errors = [];
const browser = await launchWarmBrowser();
const server = await startServer({ variant, data: values.data, port });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
const jsRequests = [];
const failedRequests = [];
page.on("request", (request) => {
  if (request.url().includes("/assets/") && request.url().endsWith(".js"))
    jsRequests.push(request.url());
});
page.on("requestfailed", (request) =>
  failedRequests.push(`${request.url()} ${request.failure()?.errorText}`),
);
page.on("response", (response) => {
  if (response.status() >= 400) failedRequests.push(`${response.url()} ${response.status()}`);
});

async function step(name, run) {
  const before = jsRequests.length;
  try {
    if (checks.length > 0) await dismissDialogs();
    const detail = await run();
    checks.push({ name, ok: true, detail, chunksLoaded: jsRequests.length - before });
  } catch (error) {
    checks.push({ name, ok: false, detail: String(error?.message ?? error).split("\n")[0] });
  }
  if (values.screenshots) {
    await page.screenshot({
      path: path.join(values.screenshots, `${checks.length}-${name.replace(/\W+/g, "-")}.png`),
    });
  }
}

// First-run surfaces on a fresh data home block clicks until dismissed: the "Import
// projects" prompt ("Not now"), the app tour (its close button or Escape) and any dialog.
async function dismissDialogs() {
  for (let i = 0; i < 6; i += 1) {
    const notNow = page.getByRole("button", { name: "Not now" }).first();
    const closeTour = page.getByRole("button", { name: "Close tour" }).first();
    if (await notNow.isVisible().catch(() => false)) await notNow.click();
    else if (await closeTour.isVisible().catch(() => false)) await closeTour.click();
    else if (
      await page
        .getByRole("dialog")
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await page.keyboard.press("Escape");
    } else break;
    await page.waitForTimeout(300);
  }
}

try {
  await step("boot: splash removed and app rendered", async () => {
    await page.goto(server.url, { waitUntil: "load" });
    await page.waitForSelector(".app-boot-splash", { state: "detached", timeout: 15_000 });
    await page.waitForTimeout(1500);
    // bootstrap.ts replaces the page with this screen when importing main.tsx throws.
    const failure = await page.evaluate(() => {
      const heading = document.querySelector("body > main > h1");
      return heading
        ? `${heading.textContent} | ${document.querySelector("body > main > p")?.textContent}`
        : null;
    });
    if (failure) throw new Error(`boot failed: ${failure.replace(/^.*·/, "")}`);
    // The tour opens a few seconds after boot; keep dismissing until the UI is quiet.
    for (let i = 0; i < 12; i += 1) {
      await dismissDialogs();
      await page.waitForTimeout(500);
    }
    return page.url().replace(server.url, "/");
  });
  await step("sidebar lists seeded threads", async () => {
    const row = page.getByText("Bench small 004", { exact: true }).first();
    await row.waitFor({ state: "visible", timeout: 10_000 });
    return "Bench small 004 visible";
  });
  await step("seeded thread opens with highlighted code", async () => {
    await page.getByText("Bench small 004", { exact: true }).first().click();
    await page.waitForURL(/seed-thread-small-004/, { timeout: 10_000 });
    await dismissDialogs();
    const highlighted = page.locator("pre.shiki span[style*='color']").first();
    await highlighted.waitFor({ state: "attached", timeout: 15_000 });
    return `${await page.locator("pre.shiki").count()} highlighted code blocks`;
  });
  await step("composer accepts text", async () => {
    const editor = page.locator('[data-testid="composer-editor"]').first();
    await editor.click();
    await page.keyboard.type("smoke text, not sent");
    const text = await editor.innerText();
    if (!text.includes("smoke text, not sent")) throw new Error(`composer text: ${text}`);
    const layout = await page
      .locator("[data-composer-layout]")
      .first()
      .getAttribute("data-composer-layout")
      .catch(() => null);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    return `typed; composer layout ${layout ?? "multi-row"}`;
  });
  await step("terminal drawer opens (lazy xterm)", async () => {
    await page
      .locator("body")
      .click({ position: { x: 700, y: 120 } })
      .catch(() => {});
    await page.keyboard.press("ControlOrMeta+j");
    await page.locator(".xterm").first().waitFor({ state: "attached", timeout: 15_000 });
    return `${await page.locator(".xterm").count()} xterm instance(s)`;
  });
  await step("settings opens (Help menu > keybindings)", async () => {
    await page.getByRole("button", { name: "Help", exact: true }).first().click();
    await page
      .getByRole("menuitem", { name: /keybindings|shortcuts/i })
      .first()
      .click();
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await nav.waitFor({ state: "visible", timeout: 15_000 });
    return page.url().replace(server.url, "/");
  });
} finally {
  await context.close();
  await browser.close();
  await server.stop();
}

for (const c of checks) {
  console.log(
    `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail ?? ""}${c.ok ? ` (+${c.chunksLoaded} JS)` : ""}`,
  );
}
console.log(`JS chunks fetched: ${jsRequests.length}`);
console.log(`failed requests: ${failedRequests.length ? failedRequests.join("\n  ") : "none"}`);
console.log(`page and console errors: ${errors.length ? `\n  ${errors.join("\n  ")}` : "none"}`);
process.exitCode = checks.every((c) => c.ok) && errors.length === 0 ? 0 : 1;
