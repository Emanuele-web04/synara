// Records a Chromium performance trace (timeline + V8 sampling profiler) of a cold boot
// per variant, same isolation as measure.mjs, for attribute-trace.mjs.
//
//   node benchmarks/web-boot/profile.mjs --data <dir> --out-dir <dir> \
//     --variant V1=<checkout>@<dist> ... [--rounds 3] [--cpu 4] [--port 3931]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  assertPortFree,
  launchWarmBrowser,
  parseVariant,
  rotation,
  sleep,
  startServer,
} from "./lib.mjs";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    "out-dir": { type: "string" },
    variant: { type: "string", multiple: true },
    rounds: { type: "string", default: "3" },
    cpu: { type: "string", default: "4" },
    port: { type: "string", default: "3931" },
    "settle-ms": { type: "string" },
  },
});
if (!values.data || !values["out-dir"] || !values.variant?.length) {
  console.error("usage: --data <dir> --out-dir <dir> --variant name=<checkout>[@<dist>] ...");
  process.exit(2);
}
const variants = values.variant.map(parseVariant);
const cpu = Number(values.cpu);
const port = Number(values.port);
const settleMs = Number(values["settle-ms"] ?? 6000 * Math.max(1, cpu / 2));
const outDir = path.resolve(values["out-dir"]);
mkdirSync(outDir, { recursive: true });
assertPortFree(port);

const CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "v8.execute",
  "v8",
  "disabled-by-default-v8.cpu_profiler",
  "blink.user_timing",
  "loading",
  "toplevel",
];

const browser = await launchWarmBrowser();
for (let round = 0; round < Number(values.rounds); round += 1) {
  for (const variant of rotation(variants, round)) {
    const server = await startServer({ variant, data: values.data, port });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
      await browser.startTracing(page, { categories: CATEGORIES });
      await page.goto(server.url, { waitUntil: "load" });
      await sleep(settleMs);
      const trace = await browser.stopTracing();
      const file = path.join(outDir, `${variant.name}-cpu${cpu}-r${round}.json`);
      writeFileSync(file, trace);
      console.log(`${round} ${variant.name} -> ${file} (${Math.round(trace.length / 1024)} KB)`);
    } finally {
      await context.close();
      await server.stop();
    }
  }
}
await browser.close();
