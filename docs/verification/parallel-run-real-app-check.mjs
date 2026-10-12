// Real production app + Chromium + SQLite + Git. Every provider is disabled;
// no provider executable is launched and no prompt is sent to a model service.
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const root = process.cwd();
const { chromium } = await import(
  new URL("./apps/web/node_modules/playwright/index.mjs", "file://" + root + "/")
);

const home = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "synara-local-acceptance-"));
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
      ].map((p) => [p, { enabled: false }]),
    ),
  }),
);
const log = await fs.open("/tmp/synara-local-acceptance-server.log", "w");
const server = spawn(
  process.execPath,
  [
    "apps/server/dist/index.mjs",
    "--home-dir",
    home,
    "--host",
    "127.0.0.1",
    "--port",
    "44519",
    "--no-browser",
  ],
  { cwd: root, stdio: ["ignore", log.fd, log.fd] },
);
const exited = once(server, "exit");
let browser;
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch("http://127.0.0.1:44519")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({
    ...(process.env.SYNARA_CHROMIUM_PATH
      ? { executablePath: process.env.SYNARA_CHROMIUM_PATH }
      : {}),
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => console.log("PAGE_ERROR", e.message));
  await page.goto("http://127.0.0.1:44519");
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
  await page.getByRole("button", { name: "Parallel run", exact: true }).click();
  await page
    .getByPlaceholder("Describe the task for every model…")
    .fill("Synthetic local acceptance: return LOCAL_ONLY_CHECK.");
  await page.mouse.move(1400, 900);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: root + "/docs/verification/parallel-run-real-app-launch.png" });
  await page.getByRole("button", { name: "Start 2 attempts", exact: true }).click();
  await page
    .getByRole("button", { name: "Compare attempts", exact: true })
    .waitFor({ timeout: 30000 });
  await page.getByText("Provider turn start failed", { exact: false }).first().waitFor();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: root + "/docs/verification/parallel-run-real-app-staging.png" });
  await page.getByRole("button", { name: "Compare attempts", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(2500);
  console.log("COMPARISON", await page.getByRole("dialog").innerText());
  await page.screenshot({ path: root + "/docs/verification/parallel-run-real-app-comparison.png" });
  const keep = page.getByRole("button", { name: "Keep this attempt", exact: true }).first();
  assert.equal(await keep.isEnabled(), true);
  assert.equal(await page.getByText("Failed to start", { exact: true }).count(), 2);
  await keep.click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: root + "/docs/verification/parallel-run-real-app-kept.png" });
  await browser.close();
  browser = null;
  server.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("real server shutdown exceeded 15s")), 15000),
    ),
  ]);
  const db = new DatabaseSync(path.join(home, "userdata/state.sqlite"), { readOnly: true });
  const rows = db
    .prepare(
      "select thread_id,title,worktree_path,parallel_run_json,archived_at,deleted_at from projection_threads",
    )
    .all();
  assert.equal(rows.length, 3);
  const attempts = rows.filter((r) => r.parallel_run_json);
  assert.equal(attempts.length, 2);
  const meta = attempts.map((r) => JSON.parse(r.parallel_run_json));
  assert.equal(meta[0].requestHash, meta[1].requestHash);
  assert.equal(meta[0].baseCommit, base);
  const source = rows.find((r) => r.thread_id === meta[0].request.sourceThreadId);
  assert.ok(source);
  assert.equal(source.deleted_at, null);
  assert.equal(source.archived_at, null);
  assert.equal(attempts.filter((r) => r.archived_at).length, 1);
  for (const a of attempts) {
    assert.equal(
      execFileSync("git", ["-C", a.worktree_path, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      base,
    );
  }
  const report = {
    home,
    sourceTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sourceComponent: execFileSync(
      "git",
      ["hash-object", "apps/web/src/components/chat/ParallelRunsControl.tsx"],
      { cwd: root, encoding: "utf8" },
    ).trim(),
    base,
    threads: rows,
    providersDisabled: true,
    realGitHeadsEqual: true,
    sourcePreserved: true,
    keepEnabled: true,
    siblingArchived: true,
    gracefulServerExit: true,
    limitations:
      "Actual disabled-provider failure path; no live model output or successful provider completion claimed.",
  };
  db.close();
  await fs.writeFile(
    root + "/docs/verification/parallel-run-real-app-report.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log("PASS", JSON.stringify({ home, base, attempts: 2, sourcePreserved: true }));
} finally {
  await browser?.close();
  server.kill("SIGKILL");
  await exited.catch(() => {});
  await log.close();
}
