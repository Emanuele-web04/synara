export const meta = {
  name: "build-pr9-providers",
  description:
    "Finish PR9 convergence: integrate the four real execution-runtime providers (Daytona, Vercel, Modal, Cloudflare) onto feat/exec-runtime-pr9 one at a time (sequential — they share serverLayers/Errors/registry, so no parallel worktrees), each conforming its bespoke adapter to the common ExecutionRuntimeProviderAdapterShape from increment 1, then unify the contract harness and verify end-to-end routing. Heavy agents run free-form; a small reporter emits structured status from git.",
  whenToUse:
    "Run after PR9 increment 1 (provider-polymorphic seam) is committed on feat/exec-runtime-pr9. Pass args.only=['daytona'] to integrate one provider, or omit for all four + unify.",
  phases: ["Brief", "Integrate", "Unify"],
};

const BRANCH = (args && args.branch) || "feat/exec-runtime-pr9";
const PLAN = ".plans/18-execution-runtime.md";
const MAX_REVIEW_ROUNDS = (args && args.maxReviewRounds) || 3;

const HOUSE = [
  'Effect-first: `class X extends ServiceMap.Service<X, Shape>()("t3/...")` + `Layer.effect`; never `Effect.Service`.',
  "Do NOT git-merge a provider branch (it re-imports conflicting serverLayers.ts/Errors.ts + duplicate contract harnesses). Bring only that provider's unique files via `git checkout <branch> -- <path>`, then hand-write registration/errors/contracts entries.",
  "Conform each bespoke provider adapter to the common ExecutionRuntimeProviderAdapterShape (the increment-1 seam) via a thin facade, mirroring apps/server/src/executionRuntime/Layers/FakeRuntimeProviderFacade.ts.",
  "Behavior-preserving: the fake + local/worktree paths stay identical; ProviderCommandReactor stays provider-agnostic (no provider ids).",
  "Real provider SDK/API calls stay gated behind env credentials; without creds the adapter falls back to its fake client and the baseline contract suite still runs.",
  "Reuse ONE shared contract harness (describeRuntimeProviderContract). Daytona establishes it; later providers reuse it — do not create a second copy.",
  "Checks: `bun typecheck`; `cd apps/server && bunx vitest run <pattern>` (vitest — never `bun test`); `bun fmt` + `bun lint` touched files.",
];
const houseBlock = HOUSE.map((h) => `- ${h}`).join("\n");

const PROVIDERS = [
  {
    key: "daytona",
    label: "Daytona",
    branch: "feat/exec-runtime-daytona",
    paths:
      "apps/server/src/executionRuntime/providers/daytona/ and the shared contract harness it introduced (executionRuntime/contract/describeRuntimeProviderContract.ts)",
    notes:
      "First real provider — establishes the shared contract harness. Full interactive workspace (pty, fs, git, preview, snapshot, stop/archive/delete). Its branch also tweaks descriptors.ts (+6) and serverLayers.ts (+6); reproduce those edits by hand, do not merge.",
  },
  {
    key: "vercel",
    label: "Vercel Sandbox",
    branch: "feat/exec-runtime-vercel",
    paths: "apps/server/src/executionRuntime/providers/vercelSandbox/",
    notes:
      "Command/log/file/preview-first, NOT PTY. Its branch adds entries to executionRuntime/Errors.ts (+20) and serverLayers.ts (+10) — add the Errors classes + registration by hand (do not merge, to avoid clobbering Daytona's Errors edits). FS ephemeral unless snapshotted.",
  },
  {
    key: "modal",
    label: "Modal",
    branch: "feat/exec-runtime-modal",
    paths: "apps/server/src/executionRuntime/providers/modal/",
    notes:
      "Job/service-first; descriptors honestly declare pty:false. Fake + real command backends. Treat Finished as terminal; do not claim PTY. serverLayers.ts (+7) by hand.",
  },
  {
    key: "cloudflare",
    label: "Cloudflare",
    branch: "feat/exec-runtime-cloudflare",
    paths:
      "apps/server/src/executionRuntime/providers/ (Cloudflare adapter Layers/Services), apps/cloudflare-runtime-bridge/ (Worker+DO), packages/contracts/src/cloudflareRuntimeBridge.ts + its index.ts barrel line, and bun.lock additions",
    notes:
      "Heaviest: also brings a new app (apps/cloudflare-runtime-bridge) + a schema-only contracts module + index barrel + bun.lock + Errors.ts (+21). Bring the bridge app and contracts module wholesale (they are new files, no conflict); add the Errors entries + index barrel line + serverLayers (+13) by hand. Raw Containers stay a lower-level service runtime, not the default workspace.",
  },
];
const selected = Array.isArray(args && args.only)
  ? PROVIDERS.filter((p) => args.only.includes(p.key))
  : PROVIDERS;

const WORK_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["key", "status", "branch", "checksPassed", "filesChanged", "summary", "openIssues"],
  properties: {
    key: { type: "string" },
    status: { type: "string", enum: ["passed", "blocked", "failed", "skipped"] },
    branch: { type: "string" },
    checksPassed: {
      type: "boolean",
      description: "true only if the commit body/log shows typecheck + the provider's tests passed",
    },
    filesChanged: { type: "array", items: { type: "string" } },
    commit: { type: "string" },
    summary: { type: "string" },
    openIssues: { type: "array", items: { type: "string" } },
  },
};

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings", "notes"],
  properties: {
    verdict: { type: "string", enum: ["ship", "block"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "location", "issue", "fix"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          location: { type: "string" },
          issue: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
    notes: { type: "string" },
  },
};

const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "commonInterface",
    "interfaceAdjustment",
    "registrationSteps",
    "cherryPickRule",
    "contractHarnessLocation",
    "perProvider",
    "risks",
  ],
  properties: {
    commonInterface: {
      type: "string",
      description:
        "the exact common ExecutionRuntimeProviderAdapterShape each facade must satisfy (with file:line)",
    },
    interfaceAdjustment: {
      type: "string",
      description:
        "any change increment-2 should make to the common interface so real adapters conform (e.g. make controller optional), or 'none'",
    },
    registrationSteps: {
      type: "array",
      items: { type: "string" },
      description:
        "exact steps to register a provider: facade, registry adapter binding, descriptors list, serverLayers wiring, ExecutionRuntimeProvider routing",
    },
    cherryPickRule: { type: "string" },
    contractHarnessLocation: { type: "string" },
    perProvider: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "bespokeShape", "conformNotes"],
        properties: {
          key: { type: "string" },
          bespokeShape: { type: "string" },
          conformNotes: { type: "string" },
        },
      },
    },
    risks: { type: "array", items: { type: "string" } },
  },
};

const INTEGRATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goNoGo", "summary", "providerStatuses", "checksRun", "blockingIssues"],
  properties: {
    goNoGo: { type: "string", enum: ["go", "no-go"] },
    summary: { type: "string" },
    checksRun: { type: "string" },
    providerStatuses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "status"],
        properties: {
          key: { type: "string" },
          status: { type: "string" },
          note: { type: "string" },
        },
      },
    },
    blockingIssues: { type: "array", items: { type: "string" } },
  },
};

function workPrompt(p, recipe) {
  return [
    `Integrate the ${p.label} execution-runtime provider onto branch ${BRANCH} (cwd = repo root). This is the WORK step; a reporter follows.`,
    `Plan: ${PLAN}. Increment-1 seam already on ${BRANCH}: the common ExecutionRuntimeProviderAdapterShape + RuntimeProviderRegistry.getAdapter + FakeRuntimeProviderFacade. ProviderCommandReactor calls ExecutionRuntimeService only.`,
    ``,
    `Integration recipe (from the Brief — follow it exactly):`,
    JSON.stringify(recipe),
    ``,
    `${p.label} specifics:`,
    `- Source branch: ${p.branch}. Bring these files: ${p.paths}.`,
    `- ${p.notes}`,
    ``,
    `House rules:`,
    houseBlock,
    ``,
    `Steps: (1) cherry-pick the provider's unique files via \`git checkout ${p.branch} -- <path>\` (do NOT \`git merge\`). (2) Write a \`${p.label.replace(/[^A-Za-z]/g, "")}RuntimeProviderFacade\` conforming its bespoke adapter to the common shape (mirror FakeRuntimeProviderFacade). (3) Register ${p.key} → its adapter+descriptor in the registry adapter bindings + descriptors list + serverLayers wiring, gated behind env creds (fall back to the provider's fake client without creds). (4) Re-add any Errors.ts / contracts / index-barrel entries by hand. (5) Reuse the shared contract harness at the recipe's location.`,
    `Verify: \`bun typecheck\`; \`cd apps/server && bunx vitest run ${p.key}\` and \`bunx vitest run executionRuntime ExecutionRuntimeService codexAppServerManager\` (fake/local/codex paths must stay green); \`bun fmt\`+\`bun lint\` touched files. Commit on ${BRANCH} with a conventional message stating checks + results.`,
    `Finish with a short plain-text summary: files changed, commit sha, checks run + results, open issues (honest).`,
  ].join("\n");
}

function reportPrompt(p) {
  return [
    `READ-ONLY status report for the ${p.label} provider integration. cwd = repo root. Do NOT edit files.`,
    `Inspect git only: \`git log --oneline -3 ${BRANCH}\`, \`git show --stat ${BRANCH}\`.`,
    `Return the structured result from git evidence: key=${p.key}, branch=${BRANCH}, latest commit sha, filesChanged, one-line summary, openIssues (anything the diff clearly does not cover: facade missing a method, no registration, no contract test). checksPassed=true only if the commit body states typecheck + ${p.key} tests passed. status=passed if a matching commit exists, blocked if partial, failed if none. Call StructuredOutput as your final action.`,
  ].join("\n");
}

function reviewPrompt(p, impl) {
  return [
    `Adversarial review of the ${p.label} provider integration on ${BRANCH}. Default to BLOCK. cwd = repo root.`,
    `Plan: ${PLAN}. Reporter status: ${JSON.stringify(impl)}`,
    `Inspect the real change: \`git show ${BRANCH}\` / \`git diff\`. Independently run \`bun typecheck\` and \`cd apps/server && bunx vitest run ${p.key} executionRuntime\`.`,
    ``,
    `Block if: the facade does not honestly satisfy every common-interface method (no silent stubs that pretend success); ${p.key} is not actually registered (getAdapter("${p.key}") would not resolve it, or no descriptor); the fake/local/worktree/codex paths regressed; a real SDK call is not gated behind env creds; ProviderCommandReactor gained a provider id; a SECOND contract harness was created instead of reusing the shared one; checks do not pass; an openIssue is actually a blocker.`,
    `Return verdict ship|block with concrete findings (severity, file:line, issue, exact fix). "ship" only when confident.`,
  ].join("\n");
}

function fixPrompt(p, review) {
  return [
    `Fix review findings for the ${p.label} provider integration on ${BRANCH} (cwd = repo root). WORK step.`,
    `Plan: ${PLAN}. House rules:`,
    houseBlock,
    `Address every blocker/major finding. Re-run \`bun typecheck\` + \`cd apps/server && bunx vitest run ${p.key} executionRuntime\`; \`bun fmt\`+\`bun lint\` touched files. Amend/add a commit on ${BRANCH} stating checks + results.`,
    `Findings: ${JSON.stringify(review.findings)}`,
    `Notes: ${review.notes}`,
    `Finish with a short plain-text summary.`,
  ].join("\n");
}

async function reportProvider(p, ph) {
  return agent(reportPrompt(p), {
    label: `report:${p.key}`,
    phase: ph,
    schema: WORK_REPORT_SCHEMA,
  });
}

async function integrateProvider(p, recipe) {
  const work = await agent(workPrompt(p, recipe), { label: `build:${p.key}`, phase: "Integrate" });
  if (work == null) {
    log(`${p.key}: integrator skipped.`);
    return null;
  }
  let impl = await reportProvider(p, "Integrate");
  if (!impl)
    return {
      key: p.key,
      status: "blocked",
      branch: BRANCH,
      finalVerdict: "unknown",
      openIssues: ["no reporter status"],
    };
  let round = 0;
  let verdict = "unknown";
  while (round < MAX_REVIEW_ROUNDS) {
    const review = await agent(reviewPrompt(p, impl), {
      label: `review:${p.key}#${round + 1}`,
      phase: "Integrate",
      schema: REVIEW_SCHEMA,
    });
    if (!review) break;
    verdict = review.verdict;
    if (verdict === "ship") break;
    await agent(fixPrompt(p, review), { label: `fix:${p.key}#${round + 1}`, phase: "Integrate" });
    const re = await reportProvider(p, "Integrate");
    if (re) impl = re;
    round++;
  }
  if (verdict !== "ship")
    log(
      `${p.key}: still blocking after ${round} fix round(s). Halting (later providers stack registrations on the same shared files).`,
    );
  return { ...impl, finalVerdict: verdict, reviewRounds: round };
}

// ── Brief ───────────────────────────────────────────────────────────────────
phase("Brief");
const recipe = await agent(
  [
    `Produce the exact recipe for integrating real execution-runtime providers onto ${BRANCH}. Read-only; cite file:line.`,
    `Read on ${BRANCH}: the common interface apps/server/src/executionRuntime/Services/ExecutionRuntimeProviderAdapter.ts, the registry (Services + Layers/RuntimeProviderRegistry.ts getAdapter), Layers/FakeRuntimeProviderFacade.ts, Layers/ExecutionRuntimeService.ts (how it resolves + calls the adapter), serverLayers.ts (how the fake adapter + registry are wired), and Layers/descriptors.ts.`,
    `Then inspect each real adapter's bespoke shape on its branch via \`git show <branch>:<path>\`: feat/exec-runtime-daytona DaytonaRuntimeAdapter.ts, feat/exec-runtime-vercel vercelSandbox adapter, feat/exec-runtime-modal modal adapter, feat/exec-runtime-cloudflare cloudflare adapter.`,
    `Decide whether the common interface needs a small adjustment so real adapters conform cleanly (e.g. the fake exposes an in-memory \`controller\` in createTransport's return — do real adapters? if not, recommend making controller optional / fake-only). Give the exact registration steps (facade, registry adapter binding, descriptors list, serverLayers wiring), the no-merge cherry-pick rule, the single shared contract-harness location, and per-provider conform notes.`,
  ].join("\n"),
  { label: "integration-recipe", phase: "Brief", schema: BRIEF_SCHEMA },
);
log(`Recipe ready. Integrating (sequential): ${selected.map((p) => p.key).join(", ")}.`);

// ── Integrate (sequential — shared serverLayers/registry, graceful halt) ─────
phase("Integrate");
const results = [];
let halted = false;
for (const p of selected) {
  const r = await integrateProvider(p, recipe);
  results.push(r || { key: p.key, status: "failed", finalVerdict: "error" });
  if (!r || r.finalVerdict !== "ship") {
    halted = true;
    log(
      `Halting provider integration at ${p.key}. Resume with args.only starting here after fixing.`,
    );
    break;
  }
}

// ── Unify + final verify ─────────────────────────────────────────────────────
phase("Unify");
const allShipped =
  !halted && results.length > 0 && results.every((r) => r && r.finalVerdict === "ship");
let unifyWork = "skipped (integration incomplete)";
if (allShipped) {
  unifyWork = await agent(
    [
      `Unify + final-verify PR9 on ${BRANCH} (cwd = repo root). WORK step; a reporter follows.`,
      `1) Ensure exactly ONE shared contract harness (describeRuntimeProviderContract) — if multiple copies exist across providers, dedupe to one and update imports. 2) Ensure executionRuntime/Errors.ts has a single coherent set of all provider error classes (no duplicate declarations). 3) Confirm registry.getAdapter resolves all of: fake, ${selected.map((p) => p.key).join(", ")} (add a focused test if missing). 4) Run the FULL relevant suite: \`bun fmt\`, \`bun lint\`, \`bun typecheck\`, and \`cd apps/server && bunx vitest run executionRuntime ExecutionRuntimeService ProviderCommandReactor codexAppServerManager\` plus each provider's contract suite.`,
      `Commit any unify fixes on ${BRANCH}. Finish with a plain-text report: each command + pass/fail, whether getAdapter resolves all providers, and any remaining gaps. Known pre-existing failures (GitCore trailing-slash, terminal Manager ENOTEMPTY, web zustand-persist) are not regressions — note but do not chase.`,
    ].join("\n"),
    { label: "unify-verify", phase: "Unify" },
  );
} else {
  log("Integration did not complete for all selected providers — skipping unify/final-verify.");
}

const integration = await agent(
  [
    `READ-ONLY: turn the PR9 provider integration into the structured result. Do not edit files. You may run \`git log --oneline -12 ${BRANCH}\` and \`grep -rn getAdapter\` to confirm.`,
    `Provider results: ${JSON.stringify(results)}`,
    `Unify/verify findings:\n${unifyWork}`,
    `Decide go/no-go: "go" only if every selected provider shipped, the shared contract harness is single, getAdapter resolves fake + all selected providers, and typecheck + the runtime/codex suites pass. List per-provider statuses, the checks run + results, and blocking issues. Call StructuredOutput as your final action.`,
  ].join("\n"),
  { label: "pr9-report", phase: "Unify", schema: INTEGRATION_SCHEMA },
);

return { branch: BRANCH, providers: results, integration };
