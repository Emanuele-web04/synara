export const meta = {
  name: "finish-cloud-sandboxes-e2e",
  description:
    "Finish the real cloud-sandbox provider SDK integrations on feat/exec-runtime-pr9 (Vercel @vercel/sandbox client, Modal exposePort URL, Daytona REST hardening, Cloudflare deploy-ready factory), then RUN the real codex binary end-to-end through a cloud-sandbox provider's remote runtime path (fake-backed locally, cred-ready for live) and verify. Every schema agent is a tiny emitter fed by free-form work, so heavy agents never fail on missing StructuredOutput.",
  whenToUse:
    "Run to complete the cloud sandboxes and prove an agent runs end-to-end through the remote runtime. Pass args.only=['vercel'] to finish one provider.",
  phases: ["Finish", "RunE2E", "Verify"],
};

const BRANCH = (args && args.branch) || "feat/exec-runtime-pr9";
const PLAN = ".plans/18-execution-runtime.md";

const HOUSE = [
  'Effect-first: `class X extends ServiceMap.Service<X, Shape>()("t3/...")` + `Layer.effect`; never `Effect.Service`.',
  "Work on branch " +
    BRANCH +
    " (sequential — avoid parallel edits to root package.json/bun.lock/serverLayers).",
  "Real provider SDK/API calls stay gated behind env credentials; without creds the adapter falls back to its fake client and tests still run. Prefer dynamic/optional import for an uninstalled SDK so typecheck passes without the dependency, and document any dep that must be installed for live use.",
  "Behavior-preserving for fake + local/worktree + codex paths; ProviderCommandReactor stays provider-agnostic.",
  "Checks: `bun typecheck`; `cd apps/server && bunx vitest run <pattern>` (vitest — never `bun test`); `bun fmt`+`bun lint` touched files.",
];
const houseBlock = HOUSE.map((h) => `- ${h}`).join("\n");

const PROVIDERS = [
  {
    key: "vercel",
    label: "Vercel Sandbox",
    gap: "VercelSandboxClientLive.ts is stubbed (Effect.die / 'not implemented' / 'unimplemented'). Implement the real @vercel/sandbox client: create sandbox with declared preview ports, run the agent as a streaming/detached command, stream logs, write stdin if supported, collect git diff, update network policy, extend timeout, snapshot, stop. Gate behind VERCEL_* creds; without creds keep the fake client. If @vercel/sandbox is not installed, integrate via a guarded dynamic import and document the dep — do NOT block typecheck on it.",
  },
  {
    key: "modal",
    label: "Modal",
    gap: "ModalRealCommandBackend.ts (and Fake) return url: null for exposePort. Implement service/tunnel URL resolution where Modal supports it (real backend), and a deterministic local URL for the fake backend so exposePort returns a usable route. Keep pty:false honest; Finished is terminal.",
  },
  {
    key: "daytona",
    label: "Daytona",
    gap: "HttpDaytonaSandboxClient.ts REST field shapes are unvalidated against the live API. Harden request/response decoding with effect/Schema (decode responses, surface DaytonaApiError on shape mismatch), confirm clone/setup/exec/diff/preview/stop/snapshot/delete map to the documented Daytona REST endpoints, and keep the fake client behavior identical. Use context7/docs if needed to confirm endpoint shapes.",
  },
  {
    key: "cloudflare",
    label: "Cloudflare",
    gap: "realSandboxRuntimeFactory throws until a deploy-time binding exists and the logs stream has no producer. Make the bridge (apps/cloudflare-runtime-bridge) and adapter deploy-ready: the factory should construct from a provided binding/config rather than throw, wire a logs producer for the exec stream, and the adapter should talk to the bridge over authenticated HTTP/WS. Live use requires a deployed Worker — document that; keep the fake/local path working for tests.",
  },
];
const selected = Array.isArray(args && args.only)
  ? PROVIDERS.filter((p) => args.only.includes(p.key))
  : PROVIDERS;

const STATUS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["key", "status", "checksPassed", "filesChanged", "summary", "openIssues"],
  properties: {
    key: { type: "string" },
    status: { type: "string", enum: ["finished", "partial", "blocked", "skipped"] },
    checksPassed: { type: "boolean" },
    filesChanged: { type: "array", items: { type: "string" } },
    commit: { type: "string" },
    summary: { type: "string" },
    openIssues: { type: "array", items: { type: "string" } },
  },
};

const E2E_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ran", "agentRanEndToEnd", "depth", "evidence", "openIssues"],
  properties: {
    ran: { type: "boolean", description: "the e2e test/script executed" },
    agentRanEndToEnd: {
      type: "boolean",
      description:
        "the real codex process ran through a remote-runtime provider transport and produced output",
    },
    depth: {
      type: "string",
      enum: ["full-turn", "handshake-only", "spawn-only", "none"],
      description: "how far the real codex run got (full-turn requires codex auth)",
    },
    evidence: {
      type: "string",
      description:
        "test name, command, and the observed output proving the agent ran (file:line / log excerpt)",
    },
    commit: { type: "string" },
    openIssues: { type: "array", items: { type: "string" } },
  },
};

const GO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goNoGo", "summary", "providerStatuses", "e2e", "checksRun", "credsNeededForLive"],
  properties: {
    goNoGo: { type: "string", enum: ["go", "no-go"] },
    summary: { type: "string" },
    providerStatuses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "status"],
        properties: { key: { type: "string" }, status: { type: "string" } },
      },
    },
    e2e: {
      type: "string",
      description:
        "did a real agent run end-to-end through a cloud-sandbox provider; at what depth",
    },
    checksRun: { type: "string" },
    credsNeededForLive: {
      type: "array",
      items: { type: "string" },
      description: "env vars / accounts required to run each provider against the live cloud",
    },
  },
};

const emit = (label, prose, schema, instruction) =>
  agent(
    `READ-ONLY: emit the structured result from the findings below. Do not edit files; you may run git/grep to confirm.\n${instruction}\n\nFindings:\n${prose}\n\nCall StructuredOutput as your final action.`,
    { label, schema },
  );

// ── Finish (sequential on the branch) ────────────────────────────────────────
phase("Finish");
const finishStatuses = [];
for (const p of selected) {
  const work = await agent(
    [
      `Finish the real ${p.label} cloud-sandbox integration on ${BRANCH} (cwd = repo root). WORK step.`,
      `Plan: ${PLAN}. The provider is already registered via a facade on ${BRANCH}; you are completing its real-SDK path.`,
      ``,
      `Gap to close: ${p.gap}`,
      ``,
      `House rules:`,
      houseBlock,
      ``,
      `Verify: \`bun typecheck\`; \`cd apps/server && bunx vitest run ${p.key} executionRuntime\`; \`bun fmt\`+\`bun lint\` touched files. Commit on ${BRANCH} stating checks + results. Finish with a plain-text summary: files changed, commit sha, checks run + results, and exactly what env creds/accounts are needed for live use + any open issues. Be honest about what is real vs still fake-backed.`,
    ].join("\n"),
    { label: `finish:${p.key}`, phase: "Finish" },
  );
  const status = await emit(
    `status:${p.key}`,
    String(work),
    STATUS_SCHEMA,
    `Inspect git (\`git log --oneline -3 ${BRANCH}\`, \`git show --stat ${BRANCH}\`). Set key=${p.key}. status=finished if the real SDK path is implemented + checks pass, partial if real path is implemented but a dep/cred/deploy is still required, blocked if it could not be done, skipped if no change. checksPassed only if the summary states they passed.`,
  );
  if (status) finishStatuses.push(status);
}
log(`Finished providers: ${finishStatuses.map((s) => `${s.key}:${s.status}`).join(", ")}.`);

// ── RunE2E (the goal: a real agent end-to-end through a cloud-sandbox path) ───
phase("RunE2E");
const e2eWork = await agent(
  [
    `Run a REAL coding agent end-to-end through a cloud-sandbox provider's remote runtime path on ${BRANCH} (cwd = repo root). This is the primary goal. WORK step.`,
    `The real \`codex\` binary is installed at /opt/homebrew/bin/codex. There are NO cloud credentials, so use a real cloud-sandbox PROVIDER adapter in its fake-backed mode (e.g. provider "daytona" without DAYTONA_API_KEY → its fake sandbox client provisions a local temp dir). This exercises the entire remote path with the real agent process, exactly as a live cloud run would minus the remote API call.`,
    ``,
    `Write an end-to-end vitest at apps/server/src/executionRuntime/e2e/cloudSandboxAgent.e2e.test.ts (gate behind an env flag like RUN_E2E so CI default stays fast, but RUN IT NOW yourself) that:`,
    `1. Builds the execution-runtime layers (registry with real providers + fake clients, ExecutionRuntimeService, ChildProcessSpawner, FileSystem, orchestration engine as needed — reuse existing test layer helpers, e.g. executionRuntime/Layers/testSupport.ts).`,
    `2. Marks a thread remote for a cloud-sandbox provider and runs ensureTargetForThread → provisions an instance (assert a RuntimeInstance with a rootPath).`,
    `3. Calls ExecutionRuntimeService.exec to start the REAL \`codex app-server\` inside the instance, obtaining the JsonRpcLineTransport, and drives the JSON-RPC handshake over it: initialize → initialized → model/list (and account/read). Assert the initialize response comes back over the transport — this proves the real agent process runs inside the provisioned sandbox via the remote transport.`,
    `4. If \`codex\` is authenticated on this machine (account/read succeeds), start a thread and send one turn (e.g. ask it to create a file) and assert a turn/response item streams back; then collect a git diff via RuntimeGitWorkspace. If codex is NOT authed, complete the handshake depth and clearly record that a full turn needs codex auth.`,
    `5. Destroy the instance and assert cleanup (temp dir gone / isAlive false).`,
    ``,
    `Discover and adapt: if a chosen provider's fake client cannot forward a real command into the transport, either fix that fake client to forward (mirror FakeRuntimeProviderAdapter's forwardLocalcommand) or fall back to the "fake" provider which forwards real commands, and document which provider path you proved. Run the test (\`cd apps/server && RUN_E2E=1 bunx vitest run cloudSandboxAgent.e2e\`), iterate until the real codex process runs through the remote transport. Commit the test + any fixes on ${BRANCH}.`,
    ``,
    `House rules:`,
    houseBlock,
    ``,
    `Finish with a plain-text report: the exact test command + its output proving codex ran (initialize result / turn output), how deep it got (full-turn vs handshake-only) and why, the commit sha, and what creds are needed for each live cloud provider.`,
  ].join("\n"),
  { label: "run-agent-e2e", phase: "RunE2E" },
);
const e2e = await emit(
  "e2e-report",
  String(e2eWork),
  E2E_SCHEMA,
  `Confirm via git that the e2e test was committed (\`git log --oneline -3 ${BRANCH}\`, \`git show --stat ${BRANCH}\`). agentRanEndToEnd=true only if the report shows the real codex process produced output over the remote transport. depth reflects how far it got.`,
);

// ── Verify ───────────────────────────────────────────────────────────────────
phase("Verify");
const verifyWork = await agent(
  [
    `Final verification of the cloud-sandbox finish + e2e on ${BRANCH} (cwd = repo root). WORK step.`,
    `Run: \`bun fmt\`, \`bun lint\`, \`bun typecheck\`, and \`cd apps/server && bunx vitest run executionRuntime ExecutionRuntimeService ProviderCommandReactor codexAppServerManager\` and \`RUN_E2E=1 bunx vitest run cloudSandboxAgent.e2e\`. Confirm registry.getAdapter resolves fake + daytona + vercel + modal + cloudflare.`,
    `Known pre-existing failures (GitCore trailing-slash, terminal Manager ENOTEMPTY, web zustand-persist) are not regressions — note but do not chase.`,
    `Finish with a plain-text report: each command + pass/fail, the e2e depth achieved, and any blocking issues.`,
  ].join("\n"),
  { label: "verify-work", phase: "Verify" },
);
const verdict = await emit(
  "go-no-go",
  `Provider finish statuses: ${JSON.stringify(finishStatuses)}\nE2E: ${JSON.stringify(e2e)}\nVerify findings:\n${verifyWork}`,
  GO_SCHEMA,
  `goNoGo="go" only if typecheck + the runtime/codex suites pass AND a real agent ran end-to-end through a cloud-sandbox provider transport (e2e.agentRanEndToEnd true, depth handshake-only or better). List per-provider finish status, the e2e depth, checks run, and the env creds/accounts needed per provider for live cloud use.`,
);

return { branch: BRANCH, finish: finishStatuses, e2e, verdict };
