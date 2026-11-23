// The merge proof on a bot's task, against a scripted `gh` (fake-gh/): the proof reads the pull
// request, its checks and its patch through `gh`, and Merge runs `gh pr merge`. No GitHub call
// leaves the machine: the fake `gh` answers, and the proof project's GitHub remote is only a name
// (anything git fetches from github.com goes to a dead local port).
import { execFileSync } from "node:child_process";
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

import type { Browser } from "@e2e-dev/web";

import type { GhScript } from "../fake-gh/fake-gh.ts";
import { DEMO_REPO, STATE_DIR } from "../paths.ts";
import { ENGINE, expect, test, type Bot, type Synbot } from "./synbot.ts";

const REPOSITORY = "scenario-owner/proof-app";
const PROOF_REPO = nodePath.join(nodePath.dirname(DEMO_REPO), "proof-app");
const PROOF_PROJECT = nodePath.join(STATE_DIR, "proof-project.json");
const GH_SCRIPT = nodePath.join(STATE_DIR, "gh.json");
const GH_LOG = nodePath.join(STATE_DIR, "gh-log.ndjson");
const HEAD_SHA = "5ca1ab1e0000000000000000000000000000c0de";

/**
 * A project of its own whose `origin` is a GitHub repository, made once per run, so the demo
 * repository the other scenarios use never gets a GitHub remote.
 */
async function proofProject(synbot: Synbot): Promise<string> {
  try {
    return (JSON.parse(nodeFs.readFileSync(PROOF_PROJECT, "utf8")) as { projectId: string })
      .projectId;
  } catch {
    // First use in this run.
  }
  nodeFs.mkdirSync(nodePath.join(PROOF_REPO, "src"), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(PROOF_REPO, "README.md"), "line\n");
  nodeFs.writeFileSync(nodePath.join(PROOF_REPO, "src/index.ts"), "line\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: PROOF_REPO, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Scenario");
  git("config", "user.email", "scenario@example.invalid");
  git("config", "http.https://github.com/.proxy", "http://127.0.0.1:9");
  git("remote", "add", "origin", `https://github.com/${REPOSITORY}.git`);
  git("add", ".");
  git("commit", "-q", "-m", "Initial commit");
  const projectId = nodeCrypto.randomUUID();
  await synbot.rpc("orchestration.dispatchCommand", {
    type: "project.create",
    commandId: nodeCrypto.randomUUID(),
    projectId,
    kind: "project",
    title: "proof-app",
    workspaceRoot: PROOF_REPO,
    createdAt: new Date().toISOString(),
  });
  nodeFs.writeFileSync(PROOF_PROJECT, JSON.stringify({ projectId }));
  return projectId;
}

const patch = (files: readonly string[]) =>
  files
    .map(
      (file) =>
        `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n line\n+changed by the task\n`,
    )
    .join("");

function pullRequest(input: {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED";
  readonly files: readonly string[];
}): GhScript["prs"][string] {
  const now = new Date().toISOString();
  return {
    detail: {
      number: input.number,
      title: `Proof PR ${input.number}`,
      url: `https://github.com/${REPOSITORY}/pull/${input.number}`,
      author: { login: "scenario-bot" },
      headRefName: `synbot/proof-${input.number}`,
      baseRefName: "main",
      state: input.state,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      additions: input.files.length,
      deletions: 0,
      changedFiles: input.files.length,
      createdAt: now,
      updatedAt: now,
      mergedAt: null,
      closedAt: input.state === "CLOSED" ? now : null,
      body: "",
      reviewDecision: null,
      reviewRequests: [],
      reviews: [],
      comments: [],
      labels: [],
      statusCheckRollup: [
        { name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null },
      ],
      commits: [{ oid: HEAD_SHA, messageHeadline: "Task change", committedDate: now, authors: [] }],
      maintainerCanModify: false,
    },
    patch: patch(input.files),
  };
}

interface Task {
  readonly title: string;
  readonly workerThreadId: string | null;
}

/** A bot whose folders are `src` hands a task to its worker; resolves to the worker thread. */
async function botTask(synbot: Synbot, tag: string): Promise<{ bot: Bot; worker: string }> {
  const projectId = await proofProject(synbot);
  const bot = await synbot.rpc<Bot>("bots.create", {
    requestId: `scenario-${tag}-${nodeCrypto.randomUUID()}`,
    name: `Scoped ${tag} ${Date.now() % 100000}`,
    role: "Works in src only",
    mascot: { shape: "circle", color: "#1a80fa" },
    scope: { projects: "all", paths: ["src"] },
    modelSelection: ENGINE,
    taskModelSelection: ENGINE,
    autonomy: "auto",
  });
  synbot.script({
    rules: [
      { match: "SynBot report for work you delegated", steps: [{ say: "SILENT" }] },
      {
        match: `Synara Hub delegation.*${tag} worker brief`,
        steps: [{ say: `Worker: ${tag} pull request opened.` }],
      },
      { match: `You are ${bot.name}, a SynBot bot.*Watch this hub`, steps: [{ say: "SILENT" }] },
      {
        match: `You are ${bot.name}, a SynBot bot.*SynBot delegation`,
        steps: [
          {
            tool: "synara_create_threads",
            args: {
              requestId: tag,
              threads: [
                {
                  prompt: `${tag} worker brief: open a pull request.`,
                  target: ENGINE,
                  title: `${tag} task`,
                  projectId,
                },
              ],
            },
          },
          { say: `Started ${tag}.` },
        ],
      },
      {
        match: `You are SynBot, the main SynBot bot.*${tag}-GO`,
        steps: [
          {
            tool: "synara_bot_delegate",
            args: { botId: bot.id, brief: `Ship ${tag}.`, requestId: `${tag}-deleg` },
          },
          { say: `Handed ${tag} over.` },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });
  await synbot.open();
  await synbot.send(`${tag}-GO please`);
  await synbot.waitForLog(
    (e) =>
      e.event === "step" && (e as { say?: string }).say === `Worker: ${tag} pull request opened.`,
    { timeoutMs: 120_000 },
  );
  const tasks = (await synbot.bots()).tasks as Array<{ botId: string; task: Task }>;
  const worker = tasks.find((entry) => entry.botId === bot.id)?.task.workerThreadId;
  expect(worker).toBeTruthy();
  return { bot, worker: worker! };
}

async function linkPullRequest(synbot: Synbot, worker: string, number: number, state: "open") {
  await synbot.rpc("orchestration.dispatchCommand", {
    type: "thread.pull-request.link",
    commandId: nodeCrypto.randomUUID(),
    threadId: worker,
    source: "user",
    pullRequest: {
      number,
      title: `Proof PR ${number}`,
      url: `https://github.com/${REPOSITORY}/pull/${number}`,
      baseBranch: "main",
      headBranch: `synbot/proof-${number}`,
      state,
    },
  });
}

const ghCalls = () => {
  try {
    return nodeFs
      .readFileSync(GH_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { args: string[] }).args.join(" "));
  } catch {
    return [];
  }
};

async function withMergeProof(synbot: Synbot, script: GhScript, run: () => Promise<void>) {
  const before = ((await synbot.bots()).settings as { mergeProofEnabled: boolean })
    .mergeProofEnabled;
  nodeFs.rmSync(GH_LOG, { force: true });
  nodeFs.writeFileSync(GH_SCRIPT, JSON.stringify(script, null, 2));
  try {
    await synbot.rpc("bots.updateSettings", { mergeProofEnabled: true });
    await run();
  } finally {
    await synbot.rpc("bots.updateSettings", { mergeProofEnabled: before }).catch(() => undefined);
    await synbot.rpc("bots.stopAll", {}).catch(() => undefined);
    nodeFs.rmSync(GH_SCRIPT, { force: true });
  }
}

interface Proof {
  readonly state: string;
  readonly checks: string;
  readonly ready: boolean;
  readonly redFlags: ReadonlyArray<{ kind: string; file: string }>;
}

/** The server's proof for `worker`, or why it has none (`bots.mergeProof`). */
const proofOf = (browser: Browser, worker: string) =>
  browser.evaluate(async (threadId: string) => {
    const api = (await import("/src/nativeApi.ts")).readNativeApi();
    if (!api) throw new Error("native API is not ready");
    try {
      return {
        ok: true,
        proof: JSON.parse(JSON.stringify(await api.bots.mergeProof({ threadId }))),
      };
    } catch (cause) {
      return { ok: false, message: (cause as Error)?.message ?? String(cause) };
    }
  }, worker as never) as Promise<{ ok: boolean; proof?: Proof; message?: string }>;

/** Opens the task's pane next to its bot, in-app, as the task card does. */
const openTask = (browser: Browser, bot: Bot, worker: string) =>
  browser.evaluate(
    async (path: string) => {
      (await import("/src/appNavigation.ts")).appHistory.push(path);
    },
    `/synbot?bot=${bot.id}&task=${worker}` as never,
  );

test("Merge proof warns about files outside the bot's folders and still merges when CI is green", async ({
  synbot,
  browser,
  screen,
  app,
}) => {
  const { bot, worker } = await botTask(synbot, "PROOF-SCOPE");
  await withMergeProof(
    synbot,
    {
      repository: REPOSITORY,
      prs: {
        "41": pullRequest({ number: 41, state: "OPEN", files: ["src/index.ts", "README.md"] }),
      },
    },
    async () => {
      await linkPullRequest(synbot, worker, 41, "open");
      const proof = await proofOf(browser, worker);
      expect(proof, JSON.stringify(proof)).toMatchObject({
        ok: true,
        proof: {
          state: "open",
          checks: "passing",
          ready: true,
          redFlags: [{ kind: "outside-scope", file: "README.md" }],
        },
      });
      await openTask(browser, bot, worker);

      const card = browser.locator(".proof-card");
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card).toContainText("Merge it?");
      await expect(card).toContainText("Ready to merge");
      await expect(card).toContainText("Checks green on the latest commit");
      // The file outside `src` is flagged as a warning, never as a failure, and only that file.
      const outside = browser
        .locator(".proof-card .checklist__item")
        .filter({ hasText: "Changes outside this bot's folders" });
      await expect(outside).toHaveCount(1);
      await expect(outside).toContainText("README.md");
      await expect(outside).toHaveAttribute("class", /checklist__item--attention/);
      await expect(browser.locator(".proof-card .checklist__item--bad")).toHaveCount(0);
      await app.screenshot("proof-outside-scope");

      const merge = card.getByRole("button", "Merge");
      await expect(merge).toBeEnabled();
      await merge.tap();
      // Merging cannot be taken back: the card asks once more before it merges.
      const confirm = screen.getByRole("dialog", "Merge PR #41?");
      await expect(confirm).toBeVisible();
      expect(ghCalls().some((call) => call.startsWith("pr merge"))).toBe(false);
      await app.screenshot("proof-merge-confirm");
      await confirm.getByRole("button", "Merge").tap();
      await expect(card).toContainText("Merged", { timeout: 60_000 });
      await expect(card.getByRole("button", "Merge")).toHaveCount(0);
      await app.screenshot("proof-merged");
      const merges = ghCalls().filter((call) => call.startsWith("pr merge 41"));
      expect(merges).toEqual([`pr merge 41 --repo github.com/${REPOSITORY} --squash`]);
    },
  );
});

test("Merge proof on a closed, unmerged pull request says Closed, never Merged, and offers no Merge", async ({
  synbot,
  browser,
  app,
}) => {
  const { bot, worker } = await botTask(synbot, "PROOF-CLOSED");
  await withMergeProof(
    synbot,
    {
      repository: REPOSITORY,
      prs: { "42": pullRequest({ number: 42, state: "CLOSED", files: ["src/index.ts"] }) },
    },
    async () => {
      await linkPullRequest(synbot, worker, 42, "open");
      const proof = await proofOf(browser, worker);
      expect(proof, JSON.stringify(proof)).toMatchObject({
        ok: true,
        proof: { state: "closed", ready: false },
      });
      await openTask(browser, bot, worker);

      const card = browser.locator(".proof-card");
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(browser.locator(".proof-card .choice__title")).toHaveText("Closed");
      await expect(card).toHaveAttribute("class", /choice--done/);
      await expect(card).not.toContainText("Merged");
      await expect(card).not.toContainText("Ready to merge");
      await expect(card.getByRole("button", "Merge")).toHaveCount(0);
      await app.screenshot("proof-closed");
      expect(ghCalls().some((call) => call.startsWith("pr merge"))).toBe(false);
    },
  );
});
