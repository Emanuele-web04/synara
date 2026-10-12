// Actual production app and native OpenCode. Run using the isolated Python runner.
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
assert.ok(nativeBinary, "Set OPENCODE_LIVE_BINARY to the installed native OpenCode CLI");
const home = await fs.mkdtemp(
  path.join(process.env.TMPDIR ?? "/tmp", "native-parallel-acceptance-"),
);
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
          ? { enabled: true, binaryPath: nativeBinary, serverUrl: "http://127.0.0.1:46164" }
          : { enabled: false },
      ]),
    ),
    providerInstances: {
      opencode: {
        driver: "opencode",
        enabled: true,
        config: { binaryPath: nativeBinary, serverUrl: "http://127.0.0.1:46164" },
      },
    },
  }),
);
const log = await fs.open("/tmp/synara-native-parallel-acceptance-server.log", "w");
const server = spawn(
  process.execPath,
  [
    "apps/server/dist/index.mjs",
    "--home-dir",
    home,
    "--host",
    "127.0.0.1",
    "--port",
    "44548",
    "--no-browser",
    "--log-provider-events",
  ],
  { cwd: root, stdio: ["ignore", log.fd, log.fd] },
);
const exited = once(server, "exit");
let browser;
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch("http://127.0.0.1:44548")).ok) break;
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
  await page.goto("http://127.0.0.1:44548");
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
  await page.waitForTimeout(10000);
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
  await page.getByText("MiMo-V2.6-Flash Free", { exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Parallel run", exact: true }).click();
  await page.getByRole("button", { name: "Add third attempt", exact: true }).click();
  await page.waitForTimeout(1000);
  console.log("LAUNCH_DIALOG", await page.getByRole("dialog").innerText());
  console.log("PICKERS", await page.getByRole("dialog").getByRole("button").allTextContents());
  assert.equal(
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "MiMo-V2.6-Flash Free", exact: true })
      .count(),
    3,
  );
  console.log("CURRENT_MODEL_DEFAULTS_COPIED", 3);
  await page
    .getByPlaceholder("Describe the task for every model…")
    .fill(
      "Reply with exactly NATIVE_PARALLEL_OK. Do not use tools. This is an empty synthetic acceptance repository.",
    );
  await page.mouse.move(1400, 900);
  await page.screenshot({ path: root + "/docs/verification/parallel-run-native-three-launch.png" });
  await page.getByRole("button", { name: "Start 3 attempts", exact: true }).click();
  await page
    .getByRole("button", { name: "Compare attempts", exact: true })
    .waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Compare attempts", exact: true }).click();
  await page.getByRole("dialog", { name: "Parallel attempts", exact: true }).waitFor();
  for (let i = 0; i < 180; i++) {
    const text = await page
      .getByRole("dialog", { name: "Parallel attempts", exact: true })
      .innerText();
    if (
      (text.match(/NATIVE_PARALLEL_OK/g) || []).length >= 3 &&
      (text.match(/\ncompleted\n/g) || []).length === 3
    ) {
      console.log("NATIVE_COMPARISON", text);
      break;
    }
    if (i === 179) throw Error("native attempts did not all settle with real answers: " + text);
    await page.waitForTimeout(1000);
  }
  assert.deepEqual(
    await page
      .getByRole("dialog", { name: "Parallel attempts", exact: true })
      .locator("section > pre")
      .allTextContents(),
    Array(3).fill("NATIVE_PARALLEL_OK"),
  );
  await page.screenshot({
    path: root + "/docs/verification/parallel-run-native-three-comparison.png",
  });
  const attemptUrl = page.url();
  await page.getByRole("button", { name: "Compare in new thread", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Parallel attempts", exact: true })
    .waitFor({ state: "hidden", timeout: 30000 });
  assert.notEqual(page.url(), attemptUrl);
  await page.waitForTimeout(20000);
  console.log("NEW_COMPARISON_STATE", await page.locator("body").innerText());
  await page.screenshot({ path: "/tmp/native-new-comparison-progress.png" });
  const branchPrefix = git("branch", "--format=%(refname:short)")
    .split("\n")
    .find((branch) => branch.startsWith("synara/parallel/"))
    .replace(/\/[123]$/, "");
  const approvedCommands = new Set();
  const pendingCommands = new Set();
  const reviewedApprovalPath = path.join(home, "verified-read-only-approvals.json");
  let comparisonCompleted = false;
  for (let i = 0; i < 180; i++) {
    const approve = page.getByRole("button", { name: /Approve once/ }).first();
    if (await approve.count()) {
      const previews = await page
        .locator("pre[title]")
        .evaluateAll((nodes) => nodes.map((node) => node.title));
      const command = previews.at(-1);
      // Permit combinations of these bounded read-only commands in the empty
      // fixture. No arbitrary arguments, shell operators, or other programs.
      const fixtureRepoPattern = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const readOnlyGitCommand = String.raw`git(?: -C ${fixtureRepoPattern})? (?:log --oneline -(?:3|5)(?: --all)?(?: 2>/dev/null)?|status --(?:short|porcelain)|branch -a(?: --format='%\(refname:short\) %\(objectname:short\)')?)`;
      const readOnlyGitBatch = new RegExp(`^${readOnlyGitCommand}(?: ${readOnlyGitCommand})*$`);
      const allowed = [
        `git -C ${repo} status --porcelain git -C ${repo} worktree list echo "== $d" git -C "$d" status --porcelain git -C "$d" log --oneline -1`,
        "git status --porcelain git log --oneline -5 git branch -a --format='%(refname:short) %(objectname:short)'",
        `git log --oneline -3 git branch -a git branch --list 'synara/parallel/*' --format='%(refname:short)' echo "== $b" git diff --stat ${base} "$b"`,
        `git -C ${repo} log --oneline -5 --all 2>/dev/null git -C ${repo} status --short ls ${home}/worktrees/fixture-repo 2>/dev/null`,
        `git log --oneline -3 git status --short git branch -a --contains ${base} head -20`,
        "git log --oneline -3 --all git branch -a git status --short",
        "git log --oneline -3 git status --short git branch -a",
        `git log --oneline -3 git status --short echo "--- branch $b ---" git diff --stat ${base} "${branchPrefix}/$b" 2>&1 git log --oneline ${base}.."${branchPrefix}/$b" 2>&1`,
        `echo \"== $b ==\" git diff --stat ${base} \"$br\" git rev-parse \"$br\"`,
      ];
      let reviewed = [];
      try {
        reviewed = JSON.parse(await fs.readFile(reviewedApprovalPath, "utf8"));
        assert.ok(Array.isArray(reviewed) && reviewed.every((value) => typeof value === "string"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (
        !allowed.includes(command) &&
        !readOnlyGitBatch.test(command ?? "") &&
        !reviewed.includes(command)
      ) {
        if (!pendingCommands.has(command)) {
          pendingCommands.add(command);
          console.log(
            "PENDING_NATIVE_TOOL_REVIEW",
            JSON.stringify({ command, reviewedApprovalPath }),
          );
        }
        // An operator may review an exact fixture-only read request. Nothing
        // is approved by default; the finite completion deadline still fails.
        await page.waitForTimeout(1000);
        continue;
      }
      if (!approvedCommands.has(command)) {
        await page.screenshot({
          path: root + "/docs/verification/parallel-run-native-three-approval.png",
        });
        approvedCommands.add(command);
        console.log("APPROVED_READ_ONLY_SYNTHETIC_GIT", command);
        await approve.click();
      }
    }
    // Fork is offered only for a settled, persisted assistant answer. Work
    // headers are optional, and production SQLite owns an exclusive live lock.
    // All four durable completed rows are checked after graceful shutdown below.
    if (
      !(await approve.count()) &&
      !(await page.getByRole("button", { name: "Stop generation", exact: true }).count()) &&
      (await page
        .getByRole("button", { name: "Fork thread from this turn", exact: true })
        .count()) === 1
    ) {
      comparisonCompleted = true;
      break;
    }
    await page.waitForTimeout(1000);
  }
  assert.ok(comparisonCompleted, "Native comparison must complete before keeping an attempt");
  await page.screenshot({
    path: root + "/docs/verification/parallel-run-native-three-new-comparison.png",
  });
  console.log("REAL_NEW_COMPARISON", await page.locator("body").innerText());
  await page.goto(attemptUrl);
  await page.getByRole("button", { name: "Compare attempts", exact: true }).click();
  await page.getByRole("dialog", { name: "Parallel attempts", exact: true }).waitFor();
  const keep = page.getByRole("button", { name: "Keep this attempt", exact: true }).first();
  assert.equal(await keep.isEnabled(), true);
  await keep.click();
  await page
    .getByRole("dialog", { name: "Parallel attempts", exact: true })
    .waitFor({ state: "hidden" });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: root + "/docs/verification/parallel-run-native-three-kept.png" });
  await browser.close();
  browser = null;
  server.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("server shutdown exceeded 15s")), 15000),
    ),
  ]);
  const db = new DatabaseSync(path.join(home, "userdata/state.sqlite"), { readOnly: true });
  const rows = db
    .prepare(
      "select thread_id,title,worktree_path,parallel_run_json,archived_at,deleted_at from projection_threads",
    )
    .all();
  assert.equal(rows.length, 5);
  const attempts = rows.filter((r) => r.parallel_run_json);
  assert.equal(attempts.length, 3);
  const meta = attempts.map((r) => JSON.parse(r.parallel_run_json));
  assert.equal(meta[0].requestHash, meta[1].requestHash);
  assert.equal(meta[0].baseCommit, base);
  const source = rows.find((r) => r.thread_id === meta[0].request.sourceThreadId);
  assert.ok(source);
  assert.equal(source.deleted_at, null);
  assert.equal(source.archived_at, null);
  assert.equal(attempts.filter((r) => r.archived_at).length, 2);
  for (const attempt of attempts)
    assert.equal(
      execFileSync("git", ["-C", attempt.worktree_path, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      base,
    );
  const sessions = db
    .prepare("select thread_id,resume_cursor_json from provider_session_runtime")
    .all()
    .filter((r) => attempts.some((a) => a.thread_id === r.thread_id));
  assert.equal(sessions.length, 3);
  assert.equal(
    new Set(sessions.map((r) => JSON.parse(r.resume_cursor_json).openCodeSessionId)).size,
    3,
  );
  const turns = db.prepare("select thread_id,state from projection_turns").all();
  assert.equal(turns.length, 4);
  assert.ok(turns.every((t) => t.state === "completed"));
  const nativeDB = new DatabaseSync(path.join(process.env.XDG_DATA_HOME, "opencode/opencode.db"), {
    readOnly: true,
  });
  const answers = [];
  for (const session of sessions) {
    const id = JSON.parse(session.resume_cursor_json).openCodeSessionId;
    const text = nativeDB
      .prepare(
        "select p.data from part p join message m on m.id=p.message_id where p.session_id=? and json_extract(m.data,'$.role')='assistant' and json_extract(p.data,'$.type')='text' order by p.time_created",
      )
      .all(id)
      .map((r) => JSON.parse(r.data).text)
      .join("");
    const actual = db
      .prepare("select text from projection_thread_messages where thread_id=? and role='assistant'")
      .all(session.thread_id)
      .map((r) => r.text)
      .join("");
    assert.equal(actual, text);
    assert.equal(actual, "NATIVE_PARALLEL_OK");
    answers.push({
      threadId: session.thread_id,
      nativeSessionId: id,
      nativeText: text,
      synaraText: actual,
    });
  }
  nativeDB.close();
  console.log("EXACT_NATIVE_TRANSCRIPTS", answers);
  console.log("NATIVE_SESSIONS", sessions);
  console.log("ACTUAL_COMPLETED_TURNS", turns);
  await fs.writeFile(
    root + "/docs/verification/parallel-run-native-three-report.json",
    JSON.stringify(
      {
        home,
        base,
        threads: rows,
        sourceComponent: execFileSync(
          "git",
          ["hash-object", "apps/web/src/components/chat/ParallelRunsControl.tsx"],
          { cwd: root, encoding: "utf8" },
        ).trim(),
        sessions,
        turns,
        answers,
        actualModel: "opencode/mimo-v2.6-flash-free",
        approvedReadOnlyCommands: [...approvedCommands],
        realAnswers: true,
        sourcePreserved: true,
        siblingArchived: true,
        gracefulServerExit: true,
      },
      null,
      2,
    ) + "\n",
  );
  db.close();
  console.log("PASS_NATIVE_PARALLEL", { home, base });
} finally {
  await browser?.close();
  server.kill("SIGKILL");
  await exited.catch(() => {});
  await log.close();
}
