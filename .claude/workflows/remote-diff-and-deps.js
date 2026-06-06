export const meta = {
  name: "remote-diff-and-deps",
  description:
    "Make the Review/turn-diff work for remote Daytona threads (route to the sandbox git diff), add an opt-in post-clone install, and dedup the Daytona error-wrapping boilerplate — each implemented, reviewed, fixed to a green typecheck",
  phases: [
    { title: "Build", detail: "each slice: implement, report, adversarial review, fix to green" },
    { title: "Verify", detail: "full fmt/lint/typecheck + tests" },
  ],
};

const REPO = "/Users/tylersheffield/code/synara";

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
- The codex-on-Daytona path WORKS and is committed (79a400ca, unanimous ship). Do NOT regress it. LOCAL/worktree threads must stay byte-for-byte unchanged.
- Implementation lives in apps/server/src/* (the Services/* dirs hold interfaces). Read the real file before editing.
- Checkpointing is HOST-ONLY today, with NO remote awareness: apps/server/src/orchestration/Layers/CheckpointReactor.ts captures + diffs on the host cwd via apps/server/src/checkpointing/Layers/CheckpointStore.ts (diffCheckpoints, ~238) and CheckpointDiffQuery.ts. For a remote-runtime thread the agent edits the SANDBOX, so the host repo never changes and the diff ref is missing -> "Checkpoint ref is unavailable for diff operation" + an empty Review panel.
- The sandbox-side git diff EXISTS: RuntimeGitWorkspace.diff/status (apps/server/src/executionRuntime/Services/RuntimeGitWorkspace.ts + Layers/RuntimeGitWorkspace.ts) run git INSIDE the instance via adapter.execCollect. The clone target is the discovered sandbox rootPath (e.g. /root/<repo>) recorded as runtime.instance.rootPath.
- A thread is remote when thread.runtime?.targetKind === "remote-runtime"; its instance is thread.runtime.instance (id + rootPath). The reactor already loads full thread detail (projectionSnapshotQuery). ExecutionRuntimeService is the orchestration->sandbox seam (it already has exec) and can expose a workspace-diff method that delegates to the adapter/RuntimeGitWorkspace.
- effect-smol: no Effect.catchAll / Schedule.intersect (use Effect.catch). No Math.random/Date.now in a workflow SCRIPT (app code is fine). DAYTONA_API_KEY is in the user's zsh for live probing: zsh -c 'source ~/.zshrc >/dev/null 2>&1; <cmd>'.
- After each slice run \`cd ${REPO}/apps/server && bun run typecheck\` and fix to green. Do NOT run the full trio per slice (Verify does it once). Work on the current branch; do not commit.`;

const SLICES = [
  {
    key: "DEDUP",
    title: "Extract the repeated Daytona error-wrapping helpers (ship-gate follow-up)",
    spec: `Behavior-preserving cleanup the ship-gate flagged. In apps/server/src/executionRuntime/providers/daytona/DaytonaRuntimeAdapter.ts the \`DaytonaSandboxUnknownError -> DaytonaApiError\` catch block repeats ~8x; in HttpDaytonaSandboxClient.ts the \`bodyJson mapError -> DaytonaApiError redact(String(cause))\` wrapper repeats ~11x. Extract two small helpers (e.g. wrapUnknown(operation) and toApiError(operation)) and replace the repeats, removing ~40 lines. Keep redaction + the operation label intact at every call site; no behavior change. Add/keep tests green.`,
  },
  {
    key: "DEPS",
    title: "Opt-in post-clone dependency install in the sandbox",
    spec: `Add an OPT-IN post-clone install so a remote agent can run tests/lint/typecheck (it currently has no node_modules; the agent itself reported pnpm missing dotenv/tsx/prisma). Default OFF — install adds minutes to every provision and most tasks do not need it. Add a sandbox setting \`postCloneCommand\` (string, default "" = off) to packages/contracts/src/settings.ts (sandboxes section, schema-only) + sandboxCredentialMapping if it needs threading; resolve it where the repo clone runs (DaytonaRuntimeAdapter cloneRepoIntoSandbox / gitWorkspaceBootstrap). When non-empty, after the clone + checkout, run it in the sandbox cwd (the clone dir) via the adapter exec, BEST-EFFORT (log on failure, never fatally block the session/transport). Optionally auto-detect the package manager when the command is left blank but a lockfile is present (bun.lock->bun install, pnpm-lock.yaml->pnpm install --frozen-lockfile, package-lock.json->npm ci) — only if cheap; otherwise the explicit setting alone is fine for v1. Wire a Settings UI field if the other sandbox fields have one (apps/web/src/sandboxSettings.ts + the settings route), else leave the schema + server side. Keep local threads unaffected.`,
  },
  {
    key: "DIFF",
    title: "Route the Review/turn-diff to the sandbox for remote-runtime threads",
    spec: `Make the Review panel + turn-diff work for remote threads (today: "Checkpoint ref is unavailable" + empty Review). When a thread is remote (thread.runtime?.targetKind === "remote-runtime" with a running instance), source the turn diff from the SANDBOX instead of the host CheckpointStore.
Approach: add an ExecutionRuntimeService method (e.g. workspaceDiff(threadId, instanceId)) that delegates to RuntimeGitWorkspace.diff (or adapter.execCollect of \`git diff\`/\`git status --porcelain\`) in the instance's rootPath, returning the unified diff + the per-file add/delete counts the Review panel expects (reuse parseTurnDiffFilesFromUnifiedDiff). In CheckpointReactor / CheckpointDiffQuery, branch on remote: for a remote thread, skip the host captureCheckpoint/diffCheckpoints and instead read the sandbox diff; emit the same turn-diff shape the projection/Review UI consumes. For LOCAL threads keep the existing host CheckpointStore path exactly.
v1 scope: show the sandbox's working-tree diff (uncommitted changes vs the cloned ref) so the Review panel is populated and not errored. Per-turn boundary precision (a sandbox checkpoint at each turn start) and remote checkpoint RESTORE are acceptable follow-ups — but do NOT emit the host "ref unavailable" error for remote threads; degrade to an empty-but-clean diff if the sandbox diff cannot be read. Add a unit test that a remote thread routes to the sandbox diff and a local thread still uses CheckpointStore.`,
  },
];

phase("Build");
log(`Building remote-diff + opt-in deps + dedup — ${SLICES.length} slices`);

const results = [];
for (const slice of SLICES) {
  await agent(
    `${PRINCIPLES}\n\nSLICE ${slice.key}: ${slice.title}\n\nWHAT TO DO:\n${slice.spec}\n\nImplement on the current branch in ${REPO}. Read the real files first, write the code, add/update focused unit tests, run the server typecheck to green. Keep local/worktree threads unaffected and the working codex-on-Daytona path intact. Report what changed.`,
    { label: `impl:${slice.key}`, phase: "Build" },
  );

  const report = await agent(
    `Report slice ${slice.key} ("${slice.title}") by inspecting ${REPO}: \`git -C ${REPO} status --short\`, \`git -C ${REPO} diff --stat\`, and \`cd ${REPO}/apps/server && bun run typecheck\` (pass/fail). List files changed by this slice, summarize, followups. Do not edit.`,
    { label: `report:${slice.key}`, phase: "Build", schema: REPORT },
  );

  const review = await agent(
    `${PRINCIPLES}\n\nAdversarially review slice ${slice.key} ("${slice.title}"). Inspect its diff (\`git -C ${REPO} diff\` on ${(report && report.filesChanged && report.filesChanged.join(", ")) || "the changed files"}). Verify: it does what the slice intends; LOCAL/worktree threads are unaffected; the committed codex-on-Daytona path still works; for DIFF — remote threads no longer hit the host "ref unavailable" error and local threads still use CheckpointStore; for DEPS — install is opt-in (default off), best-effort, and never fatally blocks a turn; for DEDUP — redaction + operation labels are intact and behavior is unchanged; no effect-smol misuse. Verdict "ship" or "fix" with concrete blocking issues + fixes.`,
    { label: `review:${slice.key}`, phase: "Build", schema: REVIEW },
  );

  if (review && review.verdict === "fix" && review.blocking && review.blocking.length > 0) {
    await agent(
      `${PRINCIPLES}\n\nFix the blocking issues in slice ${slice.key} ("${slice.title}") and re-run the server typecheck to green:\n${JSON.stringify(review.blocking, null, 2)}`,
      { label: `fix:${slice.key}`, phase: "Build" },
    );
  }

  results.push({ slice: slice.key, report, review });
  log(
    `Slice ${slice.key}: report=${report ? report.status : "null"} review=${review ? review.verdict : "null"}`,
  );
}

phase("Verify");
const verify = await agent(
  `Final verification in ${REPO}. Run \`cd ${REPO} && bun run typecheck\` (turbo), \`bun run lint\`, and \`bunx oxfmt --check\` on the changed files (then \`bunx oxfmt\` to fix formatting). Run \`cd ${REPO}/apps/server && bun run test\` for the touched areas (checkpointing, orchestration, executionRuntime, providers/daytona). Report exact pass/fail counts + any errors with file:line. Confirm from the diff: remote threads route the turn-diff to the sandbox (no host "ref unavailable"), local threads still use CheckpointStore, post-clone install is opt-in/default-off/best-effort, and the Daytona error-wrapping dedup is behavior-preserving. Only format-fix; do not change logic.`,
  { label: "final-verify", phase: "Verify", schema: REPORT },
);

return { slices: results.map((r) => r.slice), results, verify };
