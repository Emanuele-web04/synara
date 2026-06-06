export const meta = {
  name: "verify-codex-daytona",
  description:
    "Exhaustively validate the codex-on-Daytona pipeline + the new remote-Review-diff / opt-in-deps / dedup changes: verify each functional dimension against real code and tests in parallel, run the full suite, exercise a real Daytona sandbox at the boundary, adversarially refute every pass claim, then synthesize a go/no-go",
  phases: [
    {
      title: "Verify",
      detail:
        "per-dimension code+test verification, full suite, and a live sandbox boundary test, all concurrent",
    },
    { title: "Refute", detail: "adversarial skeptic per pass claim — try to break it" },
    {
      title: "Synthesize",
      detail: "go/no-go: proven-live vs proven-by-test vs unproven + real gaps",
    },
  ],
};

const REPO = "/Users/tylersheffield/code/synara";
const SNAPSHOT = "terry-vCPU-4-RAM-8GB-2026-05-27-20-58-54-codex";
const COMMIT = "a295f519";

const FACTS = `
GROUND FACTS (verified by the orchestrator before launch — trust these):
- Repo: ${REPO}, branch feat/exec-runtime-pr9, HEAD ${COMMIT} ("feat(runtime): route Review diff to the sandbox for remote threads") on top of 79a400ca (codex-on-Daytona, unanimous ship).
- The app is RUNNING: Electron on a fresh bundle (apps/server/dist/index.mjs rebuilt + touched), server HTTP/WS on 127.0.0.1:58245, web (vite) on http://localhost:5733, authEnabled. Server log: ${REPO}/.synara/electron-dev/dev/logs/server.log ; provider events: ${REPO}/.synara/electron-dev/dev/logs/provider/events.log.
- Daytona: $DAYTONA_API_KEY is in the user's zsh (len 68). Run any live probe as: zsh -c 'source ~/.zshrc >/dev/null 2>&1; <cmd>'. Management API https://app.daytona.io/api (Bearer). Toolbox/process at the PROXY host https://proxy.app.daytona.io (NO /api), Bearer same key. There are ~100 sandboxes; the Synara ones are named/snapshotted terry-...-codex (mostly stopped). Snapshot configured in settings: ${SNAPSHOT}. DO NOT touch enzo-* sandboxes (a different team's).
- Settings live at ${REPO}/.synara/electron-dev/dev/settings.json (sandboxes.defaultRemoteProvider=daytona, sandboxes.postCloneCommand unset=off, daytona snapshot set). Secrets (Daytona key, GitHub token, codex auth) live in ${REPO}/.synara/electron-dev/dev/secrets/ via ServerSecretStore — NEVER print a secret value, never cat the secret files' contents to output; checking a key's PRESENCE (key name / file exists) is fine.
- The remote workspace-diff runs exactly three git commands via the provider exec channel in the clone dir: \`git add -A -N\` (intent-to-add, non-fatal), \`git diff --binary HEAD\`, \`git status --porcelain=v1 -z\`. Parser: parsePorcelainZPaths in apps/server/src/executionRuntime/gitPorcelain.ts. Impl: apps/server/src/executionRuntime/Layers/RuntimeWorkspaceDiff.ts.

GUARDRAILS:
- effect-smol app code: Effect.catch (NOT catchAll), no Schedule.intersect. Reading the real file is mandatory before asserting anything.
- Use \`cd ${REPO} && ...\` absolute paths; do NOT rely on a persisted shell cwd (it drifts into worktrees).
- Tests: \`cd ${REPO}/apps/server && bun run test <paths>\` (vitest; NEVER \`bun test\`). Web/contracts tests via their package. There is ONE known pre-existing failure unrelated to this work: apps/server/src/git/Layers/GitCore.test.ts "reuses an existing remote when the target URL only differs by a trailing slash after .git" (origin vs origin-1) — last touched by e163aa75, reproduces in isolation. Treat it as pre-existing, not a regression.
- This is READ-ONLY verification of the app/repo. The only allowed mutation is the LIVE dimension touching its OWN Daytona sandbox (start/clone/exec/stop), which must clean up after itself.`;

const CLAIM = {
  type: "object",
  additionalProperties: false,
  properties: {
    dimension: { type: "string" },
    status: { type: "string", enum: ["pass", "partial", "fail"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    tests: {
      type: "object",
      additionalProperties: false,
      properties: {
        ran: { type: "string" },
        passed: { type: "number" },
        failed: { type: "number" },
        failures: { type: "array", items: { type: "string" } },
      },
    },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["dimension", "status", "summary", "evidence"],
};

const REFUTE = {
  type: "object",
  additionalProperties: false,
  properties: {
    dimension: { type: "string" },
    refuted: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    holes: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["dimension", "refuted", "summary"],
};

const LIVE = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["pass", "partial", "fail", "could-not-run"] },
    sandboxId: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    diffProduced: { type: "boolean" },
    porcelainParsedPaths: { type: "array", items: { type: "string" } },
    postCloneAutoParses: { type: "boolean" },
    cleanedUp: { type: "boolean" },
    evidence: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["status", "summary", "steps"],
};

const SUITE = {
  type: "object",
  additionalProperties: false,
  properties: {
    passed: { type: "number" },
    failed: { type: "number" },
    skipped: { type: "number" },
    preExistingFailures: { type: "array", items: { type: "string" } },
    newFailures: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["passed", "failed", "summary"],
};

const VERDICT = {
  type: "object",
  additionalProperties: false,
  properties: {
    overall: { type: "string", enum: ["go", "go-with-caveats", "no-go"] },
    provenLive: { type: "array", items: { type: "string" } },
    provenByTest: { type: "array", items: { type: "string" } },
    unproven: { type: "array", items: { type: "string" } },
    realGaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          gap: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          where: { type: "string" },
          fix: { type: "string" },
        },
        required: ["gap", "severity"],
      },
    },
    summary: { type: "string" },
  },
  required: ["overall", "summary", "provenByTest", "unproven"],
};

const DIMENSIONS = [
  {
    key: "settings-credentials",
    title:
      "Settings + credential persistence (Daytona creds in the secret store, snapshot config, per-provision resolution)",
    spec: `Verify a user can configure Daytona in Settings and the creds persist securely and resolve per-provision (not boot-time). Check: packages/contracts/src/settings.ts sandbox schema (defaultRemoteProvider, daytona apiKey/apiUrl/orgId/target, postCloneCommand); apps/web settings route + sandboxSettings serialization; the server reads the Daytona key from ServerSecretStore (apps/server/src/.../providerCredentialLayer.ts + DispatchingDaytonaSandboxClient) at PROVISION time, not boot (no restart needed after saving). Confirm the key is NOT stored in settings.json plaintext (read the live settings.json — apiKey should be empty/unset there) and IS in the secrets dir (presence only — never print its value). Run the settings/sandboxSettings tests. Live: confirm the secrets dir holds a daytona key entry (filename/key presence). Status pass only if creds persist to the secret store, settings.json has no plaintext secret, and resolution is per-provision.`,
  },
  {
    key: "provision-injection",
    title: "Sandbox provision + codex auth/AGENTS.md/config injection",
    spec: `Verify provisioning a remote thread injects what codex needs to behave like local. Check apps/server/src/executionRuntime/codexAuthBootstrap.ts (resolveOperatorCodexAuth + buildCodexAuthInjectionCommand -> ~/.codex/auth.json; resolveOperatorCodexInstructions + buildCodexInstructionsInjectionCommand -> ~/.codex/AGENTS.md; buildMinimalCodexConfigCommand -> sandbox_mode danger-full-access + approval_policy never + project trust) and DaytonaRuntimeAdapter.injectCodexCredentials wiring (auth + instructions). Confirm auth/instructions ride as base64 args (never plaintext on the command line) and assertCodexPresent verifies the binary. Run codexAuthBootstrap.test.ts + DaytonaRuntimeAdapter.test.ts. Status pass if auth+instructions+config are all injected, base64-guarded, and tested.`,
  },
  {
    key: "repo-clone-branch",
    title: "Repo clone into the sandbox + branch resolution + token strip",
    spec: `Verify the project repo is cloned into the sandbox at the right ref with the GitHub token folded in for a private fetch then stripped from .git/config. Check apps/server/src/executionRuntime/gitWorkspaceBootstrap.ts (resolveGitHubToken via gh auth/credential fill; buildTokenizedRepoUrl x-access-token; buildGitCloneCommand: ls-remote-gated fetch + checkout -B "$ref" FETCH_HEAD BEFORE remote set-url to the clean URL; token never on the visible command line) and DaytonaRuntimeAdapter.cloneRepoIntoSandbox + discoverRoot. Run gitWorkspaceBootstrap.test.ts. Confirm a not-yet-pushed branch falls back to HEAD and the token is stripped after the authenticated fetch. Status pass if clone+branch+token-strip are correct and tested.`,
  },
  {
    key: "transport-streaming",
    title: "Remote transport + codex app-server streaming into the UI",
    spec: `Verify the per-session remote transport carries codex app-server JSON-RPC and streams deltas to the browser. Trace the seam: ProviderCommandReactor.ensureSessionForThread builds sessionServerOptions.remoteTransport (delegating to executionRuntimeService.exec) for remote threads -> ProviderService/CodexAdapter.startSession(serverOptions) builds per-session createTransport({command,args,cwd}) -> CodexAppServerManager uses it (version-gate skipped when a transport is supplied). Confirm assistant streaming is enabled (enableAssistantStreaming true) and deltas project to orchestration.domainEvent on the WS. Inspect the live server.log + provider/events.log for evidence of a prior remote codex turn streaming (thread.message deltas / item events). Run the provider + codexAppServerManager + ProviderCommandReactor tests. Status pass if the transport seam is wired end-to-end, streaming is on, and tests + logs corroborate.`,
  },
  {
    key: "remote-review-diff",
    title:
      "NEW: Review/turn-diff routes to the sandbox for remote threads (no host 'ref unavailable')",
    spec: `THE headline new feature. Verify remote-runtime threads source their Review/turn diff from the sandbox, local threads keep the host CheckpointStore, and remote NEVER emits "Checkpoint ref is unavailable". Read: Services/RuntimeWorkspaceDiff.ts + Layers/RuntimeWorkspaceDiff.ts (the 3 git commands, degrade-to-empty), gitPorcelain.ts parser, Services+Layers/ExecutionRuntimeService.ts workspaceDiff(), checkpointing/Layers/CheckpointDiffQuery.ts resolveRemoteThreadDiff (short-circuits getTurnDiff + getFullThreadDiff for remote), orchestration/Layers/CheckpointReactor.ts remoteInstanceForDiff + captureAndDispatchRemoteDiff (emits the same thread.turn.diff.complete shape), serverLayers.ts wiring (registry/workspace-diff built before the diff query to avoid a layer cycle). Run RuntimeWorkspaceDiff.test.ts + CheckpointDiffQuery.test.ts + CheckpointReactor.test.ts and report the specific tests that assert remote->sandbox (workspaceDiff called once, host ref absent) and local->CheckpointStore (workspaceDiff never called, host ref exists). Note the known non-blocking asymmetry: the reactor gates on instance status (starting/running/idle), the diff query does not — both degrade to empty. Status pass if remote routes to the sandbox, local is unchanged, the host error is gone for remote, and tests prove both branches.`,
  },
  {
    key: "post-clone-deps",
    title: "NEW: opt-in post-clone dependency install (default off, best-effort)",
    spec: `Verify the new postCloneCommand is opt-in, default-off, best-effort, and shell-safe. Read gitWorkspaceBootstrap.ts buildPostCloneCommand (blank->null; 'auto'->lockfile detect with .join("\\n") so the script PARSES; literal->eval; dir/cmd as base64 $0/$1 so nothing breaks the shell or appears on the visible line) and DaytonaRuntimeAdapter.runPostCloneCommand (runs AFTER clone, in the clone dir, wrapped so a non-zero exit or sandbox error is logged and SWALLOWED — never aborts provisioning), ExecutionRuntimeService reading the setting live (orElseSucceed("")), and the contracts docstring (blank=off; 'auto' detects — must NOT claim blank auto-detects). Run gitWorkspaceBootstrap.test.ts (incl. the bash -n syntax check on the auto script) + settings tests. Reproduce the auto-script bug fix yourself: reconstruct the auto-detect script and run \`bash -n\` on it (must parse). Status pass if default-off + best-effort + auto-parses + docstring correct, all tested.`,
  },
  {
    key: "daytona-dedup",
    title: "NEW: Daytona error-wrapping dedup is behavior-preserving",
    spec: `Verify the wrapUnknown / toApiError / bodyJsonRequest extraction preserves behavior. Read DaytonaRuntimeAdapter.ts (wrapUnknown(operation, mapDetail?) replacing the repeated DaytonaSandboxUnknownError->DaytonaApiError catchTag; the one secret-touching path passes redactSecrets) and HttpDaytonaSandboxClient.ts (toApiError(operation, status=null) + bodyJsonRequest). Confirm every call site preserves its operation label and status semantics (null pre-response, response.status once a response exists) and that redaction is intact at every site. Run the daytona provider tests. Compare against HEAD~ if useful (\`git -C ${REPO} show 79a400ca:...\`). Status pass if it is a pure behavior-preserving extraction with redaction + labels intact and tests green.`,
  },
  {
    key: "local-parity",
    title: "Local threads unaffected (local codex spawn, host CheckpointStore, local diff)",
    spec: `Verify NONE of the remote changes touch the local path. Confirm: local threads still spawn codex as a host child (makeCodexProcessTransport / buildCodexProcessEnv), still use checkpointStore.captureCheckpoint/diffCheckpoints against the host cwd (CheckpointReactor falls through to resolveCheckpointCwd + captureAndDispatchCheckpoint when remoteInstanceForDiff is null), and CheckpointDiffQuery.resolveRemoteThreadDiff returns null for non-remote threads (host path unchanged). The postCloneCommand/workspaceDiff seams are only reached on the remote provision path (fake provider / local never hit them). Run the local-path tests (checkpointing + orchestration) and confirm the local assertions. Status pass if the local agent harness, checkpoint capture, and diff are byte-for-byte unchanged for local/worktree threads.`,
  },
];

phase("Verify");
log(
  `Validating codex-on-Daytona: ${DIMENSIONS.length} dimensions + full suite + live sandbox boundary, concurrent`,
);

const liveSpec = `${FACTS}

You are the LIVE BOUNDARY test. Exercise the REAL Daytona sandbox path end-to-end at the system boundary, proving the new remote-Review-diff actually works against real git in a real sandbox (not just unit tests).

STEPS (read DaytonaRuntimeAdapter.ts + HttpDaytonaSandboxClient.ts first for the exact REST shapes/headers):
1. Pick ONE terry-...-codex sandbox that is STOPPED (GET https://app.daytona.io/api/sandbox), or provision a fresh one from snapshot ${SNAPSHOT} if starting an existing one is unreliable. Never use an enzo-* sandbox. Record its id.
2. Start it (management API) and wait until it is started/running (poll state).
3. Via the toolbox proxy exec (POST https://proxy.app.daytona.io/toolbox/{id}/process/execute with {"command": "..."} and Bearer), run a quick \`codex --version\` and \`git --version\` to confirm the harness, then clone a small public repo (or synara) into a clone dir using the same shape as buildGitCloneCommand (a public clone is fine — you do NOT need the user's GitHub token; if you want synara and it is private, clone any small public repo instead — the goal is to exercise the diff commands, not auth).
4. Make a representative edit in the clone dir: modify a tracked file AND create a new untracked file.
5. Run the EXACT three workspace-diff commands in the clone dir: \`git add -A -N\`, then \`git diff --binary HEAD\`, then \`git status --porcelain=v1 -z\`. Confirm: the diff is non-empty and includes BOTH the modified file and the new file (the add -A -N is what makes the untracked file show in diff HEAD), and the porcelain output, when split on NUL, yields both paths (mirror parsePorcelainZPaths). This proves RuntimeWorkspaceDiff would populate the Review panel.
6. Exercise the opt-in post-clone 'auto' path: reconstruct the auto-detect script from buildPostCloneCommand and run \`bash -n\` on it inside the sandbox (must parse), and run it in a dir containing a lockfile to confirm it detects the package manager (you may just verify detection echoes, not a full install).
7. CLEAN UP: stop the sandbox you started (and delete it if you provisioned a fresh one) so nothing is left running. Confirm cleanup.

Report status (pass = the live diff produced both files + porcelain parsed both paths + auto script parsed; partial/could-not-run if Daytona was too slow/limited — say exactly how far you got and why). Put the real command outputs (trimmed) in evidence. NEVER print any secret value. This is allowed to take a while; do not give up at the first slow poll — retry. Record sandboxId and cleanedUp.`;

const suiteSpec = `${FACTS}

Run the FULL server test suite and report precisely. \`cd ${REPO}/apps/server && bun run test\` (vitest run, all files). Also run the web + contracts suites if quick (\`cd ${REPO}/apps/web && bun run test\` and the contracts package test). Report total passed/failed/skipped. For EVERY failure, decide pre-existing vs new: the GitCore.test.ts trailing-slash case (origin vs origin-1) is KNOWN pre-existing (e163aa75) — reproduce it in isolation to confirm, and list it under preExistingFailures. Anything else that fails and IS touched by ${COMMIT}'s diff (git -C ${REPO} show --stat ${COMMIT}) goes under newFailures with the file:line and assertion. Do not format/lint here — tests only.`;

const verifyPromises = DIMENSIONS.map(
  (d) => () =>
    agent(
      `${FACTS}

DIMENSION: ${d.title}

WHAT TO VERIFY:
${d.spec}

Read the real implementation files (cite file:line), run the named tests and report exact pass/fail counts, and live-probe (read-only) where the spec says. Be a verifier, not an implementer — do not edit code. Return a structured claim: status pass only when the evidence actually proves it; partial if wired-but-unproven; fail with the concrete reason otherwise.`,
      { label: `verify:${d.key}`, phase: "Verify", schema: CLAIM },
    ),
);

const [claims, suite, live] = await Promise.all([
  parallel(verifyPromises),
  agent(suiteSpec, { label: "full-suite", phase: "Verify", schema: SUITE }),
  agent(liveSpec, { label: "live-boundary", phase: "Verify", schema: LIVE }),
]);

const realClaims = claims.filter(Boolean);
for (const c of realClaims) {
  log(`verify:${c.dimension} -> ${c.status}`);
}
log(
  `suite -> ${suite ? `${suite.passed} pass / ${suite.failed} fail` : "null"}; live -> ${live ? live.status : "null"}`,
);

phase("Refute");
const judged = (
  await parallel(
    realClaims
      .filter((c) => c.status !== "fail")
      .map(
        (c) => () =>
          agent(
            `${FACTS}

A prior verifier claimed dimension "${c.dimension}" is "${c.status}":
${JSON.stringify(c, null, 2)}

ADVERSARIALLY REFUTE this. Default to skepticism. Read the real code and tests yourself and try to find a hole: an untested code path, a claim the tests do not actually assert, a remote/local branch that leaks, a degraded path that hides a real failure, a security issue (secret on a command line / in logs), or an effect-smol misuse. If you can break it, set refuted=true with concrete holes (file:line). If after a genuine attempt it holds, refuted=false. Be specific; "looks fine" is not a review.`,
            { label: `refute:${c.dimension}`, phase: "Refute", schema: REFUTE },
          ),
      ),
  )
).filter(Boolean);

for (const j of judged) {
  log(`refute:${j.dimension} -> ${j.refuted ? "REFUTED" : "holds"}`);
}

phase("Synthesize");
const verdict = await agent(
  `${FACTS}

Synthesize a final validation verdict for the codex-on-Daytona functionality (commit ${COMMIT} and the 79a400ca pipeline it builds on). You have:

PER-DIMENSION CLAIMS:
${JSON.stringify(realClaims)}

ADVERSARIAL REFUTATIONS:
${JSON.stringify(judged)}

FULL SUITE:
${JSON.stringify(suite)}

LIVE SANDBOX BOUNDARY:
${JSON.stringify(live)}

Produce: overall go / go-with-caveats / no-go. Classify each capability into provenLive (the live sandbox actually demonstrated it), provenByTest (green tests assert it but no live demo), or unproven (neither — e.g. live UI streaming was not driven this run). List realGaps = only findings a refuter actually confirmed or the suite/live surfaced (severity + where + fix); do NOT invent phantom gaps, and explicitly set aside the known pre-existing GitCore failure. Be honest about the live-UI boundary: if no real remote thread was driven through the running app's UI this run, say streaming-into-the-UI is proven-by-test + proven-at-the-transport-boundary but not eyeballed in the UI. Keep the summary tight and lead with the verdict.`,
  { label: "synthesize", phase: "Synthesize", schema: VERDICT },
);

return { claims: realClaims, judged, suite, live, verdict };
