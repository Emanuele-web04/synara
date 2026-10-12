// Actual production app, Chromium, native OpenCode, SQLite, and synthetic empty Git repo.
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const { chromium } = await import(
  path.join(process.cwd(), "apps/web/node_modules/playwright/index.mjs")
);
const root = process.cwd();
const nativeBinary = process.env.OPENCODE_LIVE_BINARY;
assert.ok(nativeBinary);
const home = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "shutdown-native-"));
const repo = path.join(home, "fixture-repo");
await fs.mkdir(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
git("init", "-b", "main");
git(
  "-c",
  "user.name=Acceptance",
  "-c",
  "user.email=acceptance@example.invalid",
  "commit",
  "--allow-empty",
  "-m",
  "Synthetic empty acceptance repository",
);
const base = git("rev-parse", "HEAD");
await fs.mkdir(path.join(home, "userdata"));
await fs.writeFile(
  path.join(home, "userdata/settings.json"),
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
      ].map((p) => [
        p,
        p === "opencode"
          ? { enabled: true, binaryPath: nativeBinary, serverUrl: "http://127.0.0.1:46165" }
          : { enabled: false },
      ]),
    ),
    providerInstances: {
      opencode: {
        driver: "opencode",
        enabled: true,
        config: { binaryPath: nativeBinary, serverUrl: "http://127.0.0.1:46165" },
      },
    },
  }),
);
const log = await fs.open("/tmp/synara-shutdown-native-server.log", "w");
let server = spawn(
  process.execPath,
  [
    "apps/server/dist/index.mjs",
    "--home-dir",
    home,
    "--host",
    "127.0.0.1",
    "--port",
    "44549",
    "--no-browser",
  ],
  { cwd: root, stdio: ["ignore", log.fd, log.fd] },
);
let exited = once(server, "exit");
let browser;
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch("http://127.0.0.1:44549")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? "/tmp/synara-chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => console.log("PAGE_ERROR", e.message));
  await page.goto("http://127.0.0.1:44549");
  await page.getByRole("button", { name: "Not now", exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await page.getByRole("button", { name: "Skip tour", exact: true }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Skip tour", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Add project", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByPlaceholder("/path/to/project").fill(repo);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.waitForTimeout(12000);
  console.log("READY_APP", await page.locator("body").innerText());
  console.log(
    "BUTTON_INVENTORY",
    await page
      .getByRole("button")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({ text: n.textContent, aria: n.getAttribute("aria-label") })),
      ),
  );
  await page.getByRole("button", { name: "Change model and reasoning", exact: true }).click();
  console.log("COMPOSER_MODELS", await page.locator("body").innerText());
  await page.getByRole("tab", { name: /OpenCode/ }).click();
  await page.getByText("MiMo-V2.6-Flash Free", { exact: true }).click();
  await page
    .getByTestId("composer-editor")
    .fill("Reply with exactly NATIVE_SHUTDOWN_READY. Do not use tools.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByRole("button", { name: "Stop generation", exact: true })
    .waitFor({ timeout: 60000 });
  await page
    .getByText("NATIVE_SHUTDOWN_READY", { exact: true })
    .first()
    .waitFor({ timeout: 120000 });
  await page
    .getByRole("button", { name: "Stop generation", exact: true })
    .waitFor({ state: "hidden", timeout: 30000 });
  await page
    .getByTestId("composer-editor")
    .fill("Without tools, output every integer from 1 to 20000, one per line, without commentary.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByRole("button", { name: "Stop generation", exact: true })
    .waitFor({ timeout: 60000 });
  let active = false;
  for (let i = 0; i < 600; i++) {
    if (/\b1\s+2\s+3\b/.test(await page.locator("body").innerText())) {
      active = true;
      break;
    }
    await page.waitForTimeout(200);
  }
  assert.ok(active, "Native second turn must actually stream before shutdown");
  assert.equal(await page.getByRole("button", { name: "Stop generation", exact: true }).count(), 1);
  await page.screenshot({ path: root + "/docs/verification/shutdown-native-active.png" });
  console.log(
    "LIVE_ACTIVE",
    await page.getByRole("button", { name: "Stop generation", exact: true }).count(),
  );
  const threadUrl = page.url();
  await browser.close();
  browser = null;
  server.kill("SIGTERM");
  const result = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("production shutdown exceeded 30s")), 30000),
    ),
  ]);
  console.log("PRODUCTION_SHUTDOWN", result);
  assert.ok([0, 130].includes(result[0]));
  const db = new DatabaseSync(path.join(home, "userdata/state.sqlite"), { readOnly: true });
  const turns = db.prepare("select thread_id,state from projection_turns").all();
  assert.equal(turns.length, 2);
  assert.ok(turns.some((t) => t.state === "completed"));
  const firstAnswer = db
    .prepare(
      "select text from projection_thread_messages where role='assistant' order by created_at limit 1",
    )
    .get();
  assert.equal(firstAnswer.text, "NATIVE_SHUTDOWN_READY");
  console.log("ACTUAL_TURNS_AFTER_SHUTDOWN", turns);
  console.log(
    "DELIVERY_STATES",
    db
      .prepare("select state,count(*) as count from orchestration_event_deliveries group by state")
      .all(),
  );
  db.close();
  console.log("SHUTDOWN_HOME", home);
  server = spawn(
    process.execPath,
    [
      "apps/server/dist/index.mjs",
      "--home-dir",
      home,
      "--host",
      "127.0.0.1",
      "--port",
      "44549",
      "--no-browser",
    ],
    { cwd: root, stdio: ["ignore", log.fd, log.fd] },
  );
  exited = once(server, "exit");
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch("http://127.0.0.1:44549")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? "/tmp/synara-chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const reloaded = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await reloaded.goto(threadUrl);
  await reloaded.getByRole("button", { name: "Not now", exact: true }).waitFor({ timeout: 30000 });
  await reloaded.getByRole("button", { name: "Not now", exact: true }).click();
  await reloaded
    .getByRole("button", { name: "Skip tour", exact: true })
    .waitFor({ timeout: 10000 });
  await reloaded.getByRole("button", { name: "Skip tour", exact: true }).click();
  await reloaded.getByRole("dialog").waitFor({ state: "hidden" });
  await reloaded
    .getByText("NATIVE_SHUTDOWN_READY", { exact: true })
    .first()
    .waitFor({ timeout: 30000 });
  await reloaded.waitForTimeout(3000);
  assert.equal(
    await reloaded.getByRole("button", { name: "Stop generation", exact: true }).count(),
    0,
  );
  console.log("AFTER_REAL_RESTART", await reloaded.locator("body").innerText());
  await reloaded.screenshot({ path: root + "/docs/verification/shutdown-native-restarted.png" });
  await browser.close();
  browser = null;
  server.kill("SIGTERM");
  const restartExit = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("restarted shutdown exceeded 30s")), 30000),
    ),
  ]);
  assert.ok([0, 130].includes(restartExit[0]));
  const after = new DatabaseSync(path.join(home, "userdata/state.sqlite"), { readOnly: true });
  const recovered = after.prepare("select thread_id,state from projection_turns").all();
  assert.equal(recovered.length, 2);
  assert.ok(recovered.every((t) => t.state !== "running"));
  const abortActivity = after
    .prepare(
      "select payload_json from orchestration_events where event_type='thread.activity-appended'",
    )
    .all();
  assert.ok(recovered.some((t) => t.state === "interrupted" || t.state === "error"));
  assert.ok(
    abortActivity.some((a) => JSON.parse(a.payload_json).activity?.payload?.message === "Aborted"),
  );
  const finalDeliveries = after.prepare("select state from orchestration_event_deliveries").all();
  assert.ok(finalDeliveries.every((d) => d.state === "succeeded"));
  console.log("RECOVERED_NATIVE_TURNS", recovered);
  console.log("FINAL_DELIVERIES", finalDeliveries);
  after.close();
  await fs.writeFile(
    root + "/docs/verification/shutdown-native-report.json",
    JSON.stringify(
      {
        home,
        turnsBeforeRestart: turns,
        turnsAfterRestart: recovered,
        productionShutdownExit: result[0],
        restartShutdownExit: restartExit[0],
        realAnswer: firstAnswer.text,
        noDuplicateTurns: true,
        nativeServerOwnership: "external",
        finalDeliveries,
        sourceProviderService: execFileSync(
          "git",
          ["hash-object", "apps/server/src/provider/Layers/ProviderService.ts"],
          { cwd: root, encoding: "utf8" },
        ).trim(),
        sourceAdmission: execFileSync(
          "git",
          ["hash-object", "apps/server/src/orchestration/orchestrationAdmission.ts"],
          { cwd: root, encoding: "utf8" },
        ).trim(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("PASS_NATIVE_SHUTDOWN_RESTART");
} finally {
  await browser?.close();
  server.kill("SIGKILL");
  await exited.catch(() => {});
  await log.close();
}
