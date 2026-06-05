export const meta = {
  name: "build-codex-daytona-repo-clone",
  description:
    "Clone the project repo into the Daytona sandbox during provision (S6) so a remote codex thread runs in the repo instead of an empty /root, with the host GitHub token and codex cwd pointed at the clone",
  phases: [
    {
      title: "Scout",
      detail:
        "confirm clone execution model, repo URL/ref resolution, git-token handling, cwd wiring",
    },
    {
      title: "Build",
      detail: "implement, report, adversarial review, fix to green server typecheck",
    },
    { title: "Verify", detail: "full fmt/lint/typecheck + tests" },
  ],
};

const REPO = "/Users/tylersheffield/code/synara";

const SCOUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    cloneRunsInSandbox: { type: "boolean" },
    cloneExecutionModel: { type: "string" },
    repoUrlSource: { type: "string" },
    refSource: { type: "string" },
    gitTokenApproach: { type: "string" },
    cloneTargetAndCwd: { type: "string" },
    tokenPersistenceRisk: { type: "string" },
    gitInSnapshot: { type: "string" },
    keyFiles: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  },
  required: [
    "summary",
    "cloneRunsInSandbox",
    "repoUrlSource",
    "refSource",
    "gitTokenApproach",
    "cloneTargetAndCwd",
  ],
};

const REPORT = {
  type: "object",
  additionalProperties: false,
  properties: {
    slice: { type: "string" },
    status: { type: "string", enum: ["implemented", "partial", "blocked"] },
    filesChanged: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    serverTypecheck: { type: "string", enum: ["pass", "fail", "not-run"] },
    followups: { type: "array", items: { type: "string" } },
  },
  required: ["slice", "status", "summary"],
};

const REVIEW = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["ship", "fix"] },
    blocking: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          issue: { type: "string" },
          location: { type: "string" },
          fix: { type: "string" },
        },
        required: ["issue", "fix"],
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "blocking"],
};

const PRINCIPLES = `
GROUND TRUTH + GUARDRAILS:
- The codex-on-Daytona path WORKS today (codex runs in a real sandbox and streams). Do NOT regress it. Local/worktree threads must stay byte-for-byte unaffected (they already have the repo locally).
- Implementation lives in apps/server/src/executionRuntime/Layers/* and providers/daytona/*. Read the real file first.
- The clone capability EXISTS: RuntimeGitWorkspace.clone does \`git clone <repoUrl> <targetPath>\` + \`git checkout -B <ref>\` (apps/server/src/executionRuntime/Layers/RuntimeGitWorkspace.ts). It is NEVER invoked in the remote provision path — that is the gap (g11). Determine whether RuntimeGitWorkspace.clone runs git on the HOST (ChildProcessSpawner) or INSIDE the instance via the adapter exec; the repo must end up INSIDE the sandbox filesystem, so if it runs host-side, run the clone in the sandbox via the adapter's execCollect instead (the same place codex auth is injected in DaytonaRuntimeAdapter.provision).
- The project repo is PRIVATE: https://github.com/Tbsheff/synara.git . Cloning needs a GitHub token. The host has one: \`gh auth token\` (user logged in as Tbsheff; osxkeychain). Resolve it on the server (spawn \`gh auth token\`, fall back to the git credential helper) and build a tokenized URL https://x-access-token:<token>@github.com/... . Mirror the host-credential pattern of codexAuthBootstrap.ts. Degrade gracefully + surface a clear error if no token (do not crash the session).
- SECURITY: never log the token. Do NOT leave the token persisted in the sandbox's .git/config — after clone, rewrite origin to the clean (token-less) URL, or use GIT_ASKPASS / -c http.extraheader so it is not written. Mark the instance secret-tainted (snapshot already refuses to bake a tainted sandbox).
- codex cwd: today the agent runs at the discovered root (/root). After cloning, the agent (codex app-server) cwd MUST be the clone dir so codex sees the repo. Confirm git is present in the snapshot; if not, install or fail with a clear error.
- effect-smol: no Effect.catchAll / Schedule.intersect (use Effect.catch). No Math.random/Date.now in a workflow SCRIPT (app code fine). For live probing the user's key + gh token are in zsh: \`zsh -c 'source ~/.zshrc >/dev/null 2>&1; <cmd>'\`.
- After your work run \`cd ${REPO}/apps/server && bun run typecheck\` and fix to green. Do NOT run the full trio per step (Verify does it once). Work on the current branch; do not commit.`;

phase("Scout");
const scout = await agent(
  `${PRINCIPLES}\n\nSCOUT the exact wiring needed to clone the project repo into a Daytona sandbox during provision so codex runs in the repo. Determine and report:\n1. cloneRunsInSandbox + cloneExecutionModel: does RuntimeGitWorkspace.clone (Layers/RuntimeGitWorkspace.ts) execute git on the HOST or inside the instance? Trace how it spawns/execs. Decide whether to use it or to run \`git clone\` inside the sandbox via DaytonaRuntimeAdapter execCollect (like codex auth injection at DaytonaRuntimeAdapter.provision).\n2. repoUrlSource: how the server resolves the thread's project repo URL (thread.projectId -> project workspaceRoot -> \`git remote get-url origin\`). Where the project/workspace is read.\n3. refSource: how to resolve the thread's branch/ref (thread.branch / worktreePath / associatedWorktreeBranch), defaulting to the repo default branch (main).\n4. gitTokenApproach: resolving the host GitHub token on the server (\`gh auth token\` via ChildProcessSpawner, or git credential helper) and building the tokenized clone URL; how codexAuthBootstrap.ts resolves host creds (mirror it).\n5. cloneTargetAndCwd: a good clone target dir in the sandbox (e.g. <root>/synara or /workspace/<repo>) and exactly where the agent cwd is set today (DaytonaRuntimeAdapter.provision rootPath, ExecutionRuntimeService.exec/createTransport cwd, CodexAdapter session cwd) so the new clone dir becomes the codex cwd.\n6. tokenPersistenceRisk + mitigation (clean remote URL / GIT_ASKPASS).\n7. gitInSnapshot: is git present in the terry/enzo codex snapshots? (probe live if needed.)\nList keyFiles to edit and risks. Read-only — do not edit.`,
  { label: "scout:repo-clone", phase: "Scout", schema: SCOUT },
);

phase("Build");
log(`Implementing repo clone — cloneRunsInSandbox=${scout && scout.cloneRunsInSandbox}`);

await agent(
  `${PRINCIPLES}\n\nSCOUT FINDINGS (use these):\n${JSON.stringify(scout)}\n\nIMPLEMENT S6 — clone the project repo into the Daytona sandbox during provision and run codex in it:\n1. Resolve the thread's project repo URL (origin) and ref (branch, default main).\n2. Resolve the host GitHub token (\`gh auth token\` -> fallback credential helper) on the server; build the tokenized https URL. Degrade gracefully with a clear error if absent.\n3. During DaytonaRuntimeAdapter.provision, AFTER the sandbox is ready and codex auth is injected, clone the repo + \`checkout -B <ref>\` INTO a known dir in the sandbox (run inside the sandbox per the scout's execution model). Mark the instance secret-tainted.\n4. Set codex's agent cwd to the clone dir (thread the discovered/clone rootPath through exec/createTransport + the CodexAdapter session cwd; for remote, resolve cwd from the clone target, not host projectedCwd).\n5. SECURITY: never log the token; do not persist it in .git/config (clean the remote URL or use GIT_ASKPASS).\n6. Keep local/worktree threads unaffected; if clone fails, surface a clear actionable error without breaking the working transport.\nAdd a focused unit test (the fake adapter asserts the clone command shape + that cwd becomes the clone dir + token not persisted/logged). Run the server typecheck to green. Report what changed.`,
  { label: "impl:S6", phase: "Build" },
);

const report = await agent(
  `Report slice S6 (repo clone) by inspecting ${REPO}: \`git -C ${REPO} status --short\`, \`git -C ${REPO} diff --stat\`, and \`cd ${REPO}/apps/server && bun run typecheck\` (pass/fail). List files changed by this slice, summarize, followups. Do not edit.`,
  { label: "report:S6", phase: "Build", schema: REPORT },
);

const review = await agent(
  `${PRINCIPLES}\n\nAdversarially review slice S6 (repo clone). Inspect its diff: \`git -C ${REPO} diff\` on ${(report && report.filesChanged && report.filesChanged.join(", ")) || "the changed files"}. Verify: the clone runs INSIDE the sandbox (repo lands in the sandbox FS, not the host); codex cwd becomes the clone dir; the private repo actually clones (tokenized URL); the GitHub token is NEVER logged and NOT persisted in the sandbox .git/config; the instance is secret-tainted; local/worktree threads are unaffected; clone failure degrades to a clear error without breaking the session; no effect-smol misuse. Verdict "ship" or "fix" with concrete blocking issues + fixes.`,
  { label: "review:S6", phase: "Build", schema: REVIEW },
);

if (review && review.verdict === "fix" && review.blocking && review.blocking.length > 0) {
  await agent(
    `${PRINCIPLES}\n\nFix the blocking issues in slice S6 (repo clone) and re-run the server typecheck to green:\n${JSON.stringify(review.blocking, null, 2)}`,
    { label: "fix:S6", phase: "Build" },
  );
}

phase("Verify");
const verify = await agent(
  `Final verification of the S6 repo-clone work in ${REPO}. Run \`cd ${REPO} && bun run typecheck\` (turbo), \`bun run lint\`, and \`bunx oxfmt --check\` on changed files (then \`bunx oxfmt\` to fix formatting). Run \`cd ${REPO}/apps/server && bun run test\` for executionRuntime + providers/daytona. Report exact pass/fail counts + any errors with file:line. Confirm from the diff: provision clones the repo into the sandbox, codex cwd is the clone dir, the token is not logged/persisted, and local threads are unaffected. Only format-fix; do not change logic.`,
  { label: "final-verify", phase: "Verify", schema: REPORT },
);

return { scout, report, review, verify };
