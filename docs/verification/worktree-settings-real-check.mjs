// Real production settings persistence, all providers disabled, local only.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = await import(
  new URL("./apps/web/node_modules/playwright/index.mjs", "file://" + process.cwd() + "/")
);
const root = process.cwd(),
  home = await fs.mkdtemp("/tmp/synara-settings-acceptance-");
await fs.mkdir(home + "/userdata");
await fs.writeFile(
  home + "/userdata/settings.json",
  JSON.stringify({
    onboardingCompletedAt: new Date().toISOString(),
    providers: Object.fromEntries(
      [
        "codex",
        "claudeAgent",
        "cursor",
        "devin",
        "antigravity",
        "grok",
        "droid",
        "pi",
        "omp",
        "opencode",
      ].map((p) => [p, { enabled: false }]),
    ),
  }),
);
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);
const url = `http://127.0.0.1:${port}`;
const output = await fs.open("/tmp/settings-acceptance-server.log", "w");
const server = spawn(
  process.execPath,
  [
    "apps/server/dist/index.mjs",
    "--home-dir",
    home,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--no-browser",
  ],
  { cwd: root, stdio: ["ignore", output.fd, output.fd] },
);
const exited = once(server, "exit");
let browser;
try {
  let ready = false;
  const assertRunning = () =>
    assert.ok(server.exitCode === null && server.signalCode === null, "isolated server exited");
  for (let i = 0; i < 150; i++) {
    assertRunning();
    try {
      if ((await fetch(url)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, "isolated server did not become ready");
  assertRunning();
  browser = await chromium.launch({
    ...(process.env.SYNARA_CHROMIUM_PATH
      ? { executablePath: process.env.SYNARA_CHROMIUM_PATH }
      : {}),
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(url);
  await page.getByRole("button", { name: "Not now", exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await page.getByRole("button", { name: "Skip tour", exact: true }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Skip tour", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.goto(`${url}/settings?section=worktrees`);
  const toggle = page.getByRole("switch", { name: "Remove archived worktrees after merge" });
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), false);
  await page.mouse.move(1400, 900);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: root + "/docs/verification/worktree-settings-real-default.png" });
  const waitForStoredSetting = async (expected) => {
    let stored;
    for (let attempt = 0; attempt < 50; attempt++) {
      stored = JSON.parse(await fs.readFile(home + "/userdata/settings.json", "utf8")).settings
        .worktrees.pruneAfterMerge;
      if (stored === expected) return;
      await page.waitForTimeout(100);
    }
    assert.equal(stored, expected);
  };
  assertRunning();
  await toggle.click();
  await waitForStoredSetting(true);
  await page.reload();
  await toggle.waitFor();
  for (let i = 0; i < 50 && !(await toggle.isChecked()); i++) await page.waitForTimeout(100);
  assert.equal(await toggle.isChecked(), true);
  await page.screenshot({ path: root + "/docs/verification/worktree-settings-real-enabled.png" });
  assertRunning();
  await toggle.click();
  await waitForStoredSetting(false);
  console.log(
    "PASS",
    JSON.stringify({
      home,
      defaultOff: true,
      persistedEnabled: true,
      reloadRetained: true,
      revertedOff: true,
    }),
  );
} finally {
  await browser?.close();
  server.kill("SIGKILL");
  await exited.catch(() => {});
  await output.close();
}
