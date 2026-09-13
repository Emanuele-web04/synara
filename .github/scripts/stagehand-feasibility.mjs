// Isolated deterministic API feasibility, NOT a replacement for Synara regressions.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { chromium } from "playwright";

const html = `<!doctype html><html><body><input id="prompt"><button id="send">Send</button><p id="result"></p><button class="ambiguous">A</button><button class="ambiguous">B</button><script>document.querySelector('#send').onclick=()=>document.querySelector('#result').textContent=document.querySelector('#prompt').value;</script></body></html>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const tool of ["playwright", "stagehand", "stagehand", "playwright"]) {
    let browser;
    let runtime;
    const started = performance.now();
    try {
      const options = {
        headless: true,
        executablePath: process.env.CHROME_PATH,
        args: ["--no-sandbox"],
      };
      browser =
        tool === "playwright" ? await chromium.launch(options) : await localBrowser.launch(options);
      if (tool === "stagehand") runtime = await Stagehand.create({ browser });
      const page =
        tool === "playwright" ? await browser.newPage() : await browser.context.newPage();
      await page.goto(url, { waitUntil: "load" });
      const bootstrapMs = performance.now() - started;
      const timings = [];
      for (let iteration = 0; iteration < 10; iteration++) {
        const value = `Prompt ${iteration}: reliable browser execution`;
        const start = performance.now();
        await page.locator("#prompt").fill(value);
        await page.locator("#send").click();
        assert.equal(await page.locator("#result").textContent(), value);
        timings.push(performance.now() - start);
      }
      let rejectsAmbiguousTarget = false;
      try {
        await page.locator(".ambiguous").click({ timeout: 1000 });
      } catch {
        rejectsAmbiguousTarget = true;
      }
      const result = {
        tool,
        bootstrapMs,
        iterationMs: timings,
        supportsRoleLocators: typeof page.getByRole === "function",
        rejectsAmbiguousTarget,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      await runtime?.close();
      await browser?.close();
    }
  }
} finally {
  server.close();
  writeFileSync(process.env.RESULT_FILE, JSON.stringify(results, null, 2));
}
