import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";

// Synthetic transport/semantic feasibility probe, NOT a Synara coverage replacement.
// Deliberately no act/observe/extract, model calls, cloud sessions or credentials.
const server = createServer((_, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><input id="text"><button id="send">Send</button><output id="result"></output>
    <script>
      window.events = [];
      for (const type of ['keydown','beforeinput','input','keyup','click']) {
        document.addEventListener(type, e => window.events.push({ type, trusted: e.isTrusted }));
      }
      document.querySelector('#send').onclick = () => document.querySelector('#result').textContent = document.querySelector('#text').value;
    </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const backend of [
    "playwright",
    "stagehand",
    "stagehand-batch",
    "stagehand-batch",
    "stagehand",
    "playwright",
  ]) {
    const result = { backend, milliseconds: [], status: "failed" };
    results.push(result);
    let browser;
    let stagehand;
    try {
      const start = performance.now();
      browser =
        backend === "playwright"
          ? await chromium.launch({ executablePath: chromium.executablePath(), headless: true })
          : await localBrowser.launch({
              executablePath: chromium.executablePath(),
              headless: true,
            });
      if (backend !== "playwright") stagehand = await Stagehand.create({ browser });
      const page =
        backend === "playwright" ? await browser.newPage() : await browser.context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      result.startupMs = performance.now() - start;
      for (let index = 0; index < 20; index++) {
        const started = performance.now();
        const text = `Synara benchmark ${index}`;
        const actual =
          backend === "stagehand-batch"
            ? await stagehand.experimentalBatch(
                async ({ page }, { text }) => {
                  await page.locator("#text").fill(text);
                  await page.locator("#send").click();
                  return await page.evaluate(() => document.querySelector("#result").textContent);
                },
                { text },
                { page },
              )
            : await (async () => {
                await page.locator("#text").fill(text);
                await page.locator("#send").click();
                return await page.evaluate(() => document.querySelector("#result").textContent);
              })();
        assert.equal(actual, text);
        result.milliseconds.push(performance.now() - started);
      }
      result.events = await page.evaluate(() => window.events);
      // The current test provider relies on actionability waiting. Probe parity,
      // rather than counting a click that never activates its target as success.
      await page.evaluate(() => {
        document.querySelector("#result").textContent = "";
        const button = document.querySelector("#send");
        button.disabled = true;
        setTimeout(() => {
          button.disabled = false;
        }, 200);
      });
      await page.locator("#send").click();
      assert.equal(
        await page.evaluate(() => document.querySelector("#result").textContent),
        "Synara benchmark 19",
      );
      result.status = "passed";
    } catch (error) {
      result.error = String(error.stack ?? error);
    } finally {
      if (stagehand) await stagehand.close();
      if (browser) await browser.close();
    }
  }
} finally {
  server.close();
  writeFileSync("stagehand-results.json", JSON.stringify(results, null, 2) + "\n");
}
console.log(
  JSON.stringify(
    results.map(({ events, ...result }) => result),
    null,
    2,
  ),
);
if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
