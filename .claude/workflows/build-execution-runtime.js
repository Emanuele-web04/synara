export const meta = {
  name: "build-execution-runtime",
  description:
    "Build the execution-runtime abstraction (.plans/18-execution-runtime.md) slice-by-slice along its dependency DAG: each slice is implemented (free-form), adversarially reviewed, and fixed to checks-green; a small reporter agent emits structured status from git so heavy agents never fail on missing StructuredOutput. Parallel provider+UI tail runs in isolated worktrees; ends with an integration go/no-go. Produces branches for human PR/CI merge, not an auto-merge.",
  whenToUse:
    "Run when you want the execution-runtime plan built end-to-end with per-slice review/fix gates. Heavy run. Pass args.slices=['pr4'] to checkpoint one slice, 'spine' for PR1-8, 'providers' for the parallel tail, an explicit array to scope, or omit for all.",
  phases: ["Brief", "Spine", "Providers", "Integrate"],
};

// ── Tunables (override via args) ───────────────────────────────────────────
const PLAN = (args && args.planPath) || ".plans/18-execution-runtime.md";
const BASE_BRANCH = (args && args.base) || "main";
const SPINE_BRANCH = (args && args.spineBranch) || "feat/exec-runtime";
const MAX_REVIEW_ROUNDS = (args && args.maxReviewRounds) || 3;
// 'all' | 'spine' | 'providers' | array of slice keys (e.g. ['pr4','pr5'])
const SELECT = (args && args.slices) || "all";

const HOUSE = [
  'Effect-first: services are `class X extends ServiceMap.Service<X, Shape>()("t3/...")` + `Layer.effect` (Effect.Service is never used in this repo).',
  "packages/contracts is schema-only (effect/Schema). No runtime logic. Pure barrel re-export via index.ts.",
  "Mirror packages/effect-acp/_internal/stdio.ts (makeChildStdio / makeInMemoryStdio) for JSON-RPC-over-process transport; do NOT build on processRunner.ts.",
  "Do NOT extend ProviderRuntimeEvent (agent-activity union); execution-runtime infra events are a separate family.",
  "Keep ProviderKind, RuntimeMode (permission policy), and the new ExecutionTarget axis strictly separate.",
  "Preserve existing local/worktree behavior at every slice. Behavior-preserving refactor for Codex: replace only the process boundary, never rewrite protocol logic.",
  "Adding an orchestration event/thread field is a fixed multi-file checklist (plan Appendices A/B) — touch every site or it silently no-ops.",
  "Checks: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` (vitest — NEVER `bun test`).",
];

// PR1-PR3 are already committed on feat/exec-runtime (transport extraction,
// in-memory transport test, executionRuntime contracts + planner). The catalog
// keeps them for documentation; default SELECT below starts at pr4.
const SLICES = [
  {
    key: "pr1",
    kind: "spine",
    title: "Codex JSON-RPC transport extraction (local-only) — the keystone",
    refs: "Plan §0, §3 (the keystone), §1 corrections.",
    spec: "Effect-native JsonRpcLineTransport over ChildProcessSpawner; CodexAppServerManager consumes it instead of node:child_process; imperative bridge keeps protocol logic. (DONE/committed.)",
    acceptance: "Codex works locally; manager off node:child_process; existing Codex tests pass.",
  },
  {
    key: "pr2",
    kind: "spine",
    title: "In-memory / fake process transport + test seam",
    refs: "Plan §3 (Test seam).",
    spec: "makeInMemoryStdio-style transport; codex tests drive scripted inbound lines. (DONE/committed.)",
    acceptance: "Codex protocol exercised end-to-end against a scripted transport; tests green.",
  },
  {
    key: "pr3",
    kind: "spine",
    title: "executionRuntime public contracts + server-internal descriptors/registry/planner",
    refs: "Plan §4 Phase 1 + Phase 3, Decision #8.",
    spec: "Schema-only contracts + server-internal adapter/descriptor/planner/registry. (DONE/committed.)",
    acceptance:
      "bun typecheck passes; planner rejects unsupported plans; ProviderRuntimeEvent not extended.",
  },
  {
    key: "pr4",
    kind: "spine",
    title: "Runtime projection + persistence (dedicated tables + lifecycle events)",
    refs: "Plan §4 Phase 2 (storage = dedicated tables) + Phase 7 (events) + Appendix B, Decisions #3/#5.",
    spec: "Add OrchestrationThread.runtime (optional NullOr, withDecodingDefault null) to thread + shell contracts, hydrated from a SEPARATE projection_thread_runtime table (NOT a column on projection_threads). Add operational tables execution_runtime_{instances,processes,routes,snapshots,activity_leases} + migrations registered in Migrations.ts. Add the runtime event family (thread.runtime-* events + thread.runtime.* commands) end-to-end via Appendix B (OrchestrationEventType, payload structs, union, Schemas.ts, decider, projector, ProjectionPipeline projectors, isThreadDetailEvent, snapshot hydration). instance-state hot; process-output is STREAM-ONLY (persist lifecycle/exit/failure/tail, never every line). Build on the committed PR3 contracts/services.",
    acceptance:
      "Existing persisted threads decode with runtime=null; existing projection_threads path untouched; runtime state survives WS reconnect (snapshot + replay); shell snapshot shows status without full thread detail; bun typecheck + projection tests pass.",
  },
  {
    key: "pr5",
    kind: "spine",
    title: "Execution runtime service + fake remote runtime via internal command path",
    refs: "Plan §4 Phase 6, Reactor purity rule, Decisions #4/#6.",
    spec: "Implement ExecutionRuntimeService (ensureTargetForThread, exec, destroy, etc.) + fake providers (fake-pty-workspace, fake-command-workspace, fake-job-runtime, fake-service-runtime, fake-ephemeral-runtime) running commands locally in temp dirs but via the remote path (real RuntimeInstance records, makeInMemoryStdio transport, runtime lifecycle events, destroy cleanup). Wire ProviderCommandReactor to provision via ExecutionRuntimeService.ensureTargetForThread BEFORE ProviderService.startSession. Reactor MUST stay provider-agnostic (no Daytona/Vercel/Modal/Cloudflare ids/states). Drive provisioning through an INTERNAL orchestration command only — no public runtimePlan yet. Discovery stays local-only.",
    acceptance:
      "A remote-runtime thread provisions a fake instance via an internal command, runs Codex through the in-memory transport, streams logs, destroys cleanly; tests cover PTY-like and non-PTY fakes; ProviderCommandReactor references no provider-specific identifiers.",
  },
  {
    key: "pr6",
    kind: "spine",
    title: "Expose runtimePlan on create/handoff/fork (public surface)",
    refs: "Plan §4 Phase 8, Decision #6.",
    spec: "Add optional runtimePlan to ThreadCreateCommand/ThreadHandoffCreateCommand/ThreadForkCreateCommand + their thread.created decider blocks. No plan / local / worktree -> current behavior. Remote -> planner validates then reactor provisions before session start. Handle the field across import/fork/handoff/snapshot paths.",
    acceptance:
      "Existing callers unchanged (no runtimePlan = current behavior); invalid plans rejected pre-provision; remote runtimePlan provisions via the PR5 mechanism end-to-end.",
  },
  {
    key: "pr7",
    kind: "spine",
    title: "Cross-cutting remote concerns: git v1, activity leases, credential broker",
    refs: "Plan §4 Phases 9-11.",
    spec: "RuntimeGitWorkspace v1 via exec (clone / checkout -B / status --porcelain / diff --binary), local git WS RPCs unchanged. RuntimeActivityLeaseManager hiding per-provider keepalive; lease on active turn/terminal/preview, release on exit/close. RuntimeCredentialBroker (env-var/provider-secret/mounted-file/ssh-agent/git-credential-helper/outbound-proxy/worker-broker): never persist raw tokens in runtime metadata, never log tokenized clone URLs, setup commands get fewer secrets than agent processes, snapshots flagged secret-tainted. Validate all three against the fake providers.",
    acceptance:
      "Private-repo clone works against a fake remote; logs redact credentials; runtime metadata is safe to persist; leases acquire/release correctly on turn/terminal/route.",
  },
  {
    key: "pr8",
    kind: "spine",
    title: "ExecutionRuntimeReconciler (partial-failure recovery)",
    refs: "Plan §5.",
    spec: "ExecutionRuntimeReconciler ServiceMap.Service forked into the server scope (like the other reactors, effectServer.ts): list active execution_runtime_instances, reconnect/getStatus where supported, mark lost/failed/destroyed, retry pending destroy, enforce TTL/idle. Cover the partial-failure matrix (instance created but event not appended; event appended but provider call failed; crash after create; destroy timeout; DB/provider divergence both directions) against the fake providers.",
    acceptance:
      "Each partial-failure scenario resolves deterministically against fakes; reconciler is provider-agnostic via adapter capability flags; tests green.",
  },
  {
    key: "daytona",
    kind: "provider",
    title: "Daytona adapter (first real provider)",
    refs: "Plan §4 Phase 12.",
    spec: "apps/server/src/executionRuntime/providers/daytona/: descriptor + adapter + process transport + filesystem + activity lease. v1: create sandbox -> clone -> setup -> codex app-server -> stream stdio -> git diff -> preview -> activity refresh -> stop/archive/snapshot/delete. Gate behind env credentials; pass the Phase-17 baseline contract with fakes when creds absent.",
    acceptance:
      "Codex runs inside Daytona behind the same transport; auto-stop prevented while a turn runs; diff appears; destroy cleans up provider state; baseline + capability contract tests pass (real provider opt-in via env).",
  },
  {
    key: "vercel",
    kind: "provider",
    title: "Vercel Sandbox adapter (command/log/file/preview-first)",
    refs: "Plan §4 Phase 13.",
    spec: "providers/vercelSandbox/: descriptor + adapter + command transport + filesystem + activity lease. Declare preview ports at create; clone/seed; run agent as streaming/detached command (not PTY); stream logs; collect diff; network policy; timeout extend; snapshot; stop. Treat FS as ephemeral unless snapshotted; reconnect best-effort.",
    acceptance:
      "Remote command/log mode works without PTY; declared ports yield usable URLs; snapshot semantics represented accurately; cleanup reliable; contract tests pass.",
  },
  {
    key: "modal",
    kind: "provider",
    title: "Modal adapter (job/service-first, no forced PTY)",
    refs: "Plan §4 Phase 14.",
    spec: "providers/modal/: descriptor + adapter + job runtime + service runtime + command transport. Roles job/service/preview. Logs as process output; Finished is terminal; volume sync tracked separately from snapshots; do not claim PTY. Good for remote bun typecheck/lint/test/build validation jobs.",
    acceptance:
      "Runs a remote verification job with logs streamed back; can expose service/tunnel where supported; terminates and collects artifacts; does not claim PTY unless supported; contract tests pass.",
  },
  {
    key: "cloudflare",
    kind: "provider",
    title: "Cloudflare Runtime Bridge + adapters",
    refs: "Plan §4 Phase 15.",
    spec: "apps/cloudflare-runtime-bridge/ (Worker + Durable Object mapping runtimeInstanceId -> instance, routes for instances/exec/logs/terminal/files/ports/network-policy/renew-activity/delete). Synara adapter providers/cloudflareSandboxSdk/ (bridge client + terminal websocket transport). Keep raw Containers as a separate lower-level service runtime, not the default workspace.",
    acceptance:
      "Server talks to the bridge over authenticated HTTP/WS; commands run and stream; terminal WS works; file read/write/watch where supported; raw Containers remain service-oriented; contract tests pass.",
  },
  {
    key: "ui",
    kind: "provider",
    title: "Runtime selection + management UI",
    refs: "Plan §4 Phase 16.",
    spec: "apps/web: thread-creation Environment (Local/Worktree/Remote) + provider + advanced (resources/timeout/ports/persistence/egress/secrets). Thread header 'Runtime: <provider> · <status>'. Runtime panel: processes, routes, actions (stop/destroy/snapshot/refresh). Default creation stays local; remote opt-in; provider-session UI stays agent-focused, runtime UI infra-focused.",
    acceptance:
      "Default thread creation unchanged; remote opt-in; runtime state visible and actionable; consumes the runtime read-model from PR4 contracts.",
  },
];

// Default skips the already-committed PR1-3 unless the caller asks for them.
const DONE = ["pr1", "pr2", "pr3"];
function selected(slice) {
  if (Array.isArray(SELECT)) return SELECT.includes(slice.key);
  if (SELECT === "spine") return slice.kind === "spine" && !DONE.includes(slice.key);
  if (SELECT === "providers") return slice.kind !== "spine";
  return !DONE.includes(slice.key); // 'all' -> everything except the committed PR1-3
}
const spineSlices = SLICES.filter((s) => s.kind === "spine" && selected(s));
const parallelSlices = SLICES.filter((s) => s.kind !== "spine" && selected(s));

// ── Schemas (only on the SMALL reporter/review/integration agents) ───────────
const SLICE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["key", "status", "branch", "checksPassed", "filesChanged", "summary", "openIssues"],
  properties: {
    key: { type: "string" },
    status: { type: "string", enum: ["passed", "blocked", "failed", "skipped"] },
    branch: { type: "string" },
    checksPassed: {
      type: "boolean",
      description:
        "true only if the commit/log shows fmt+lint+typecheck and affected tests actually ran and passed",
    },
    filesChanged: { type: "array", items: { type: "string" } },
    commit: { type: "string", description: "latest commit sha on the branch, else empty" },
    summary: { type: "string" },
    openIssues: {
      type: "array",
      items: { type: "string" },
      description: "anything missing vs scope, from git evidence — be honest",
    },
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
          location: { type: "string", description: "file:line" },
          issue: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
    notes: { type: "string" },
  },
};

const INTEGRATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "goNoGo",
    "summary",
    "sliceStatuses",
    "branchesForHumanMerge",
    "blockingIssues",
    "checksRun",
  ],
  properties: {
    goNoGo: { type: "string", enum: ["go", "no-go"] },
    summary: { type: "string" },
    checksRun: { type: "string", description: "exact commands run + pass/fail for each" },
    sliceStatuses: {
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
    branchesForHumanMerge: { type: "array", items: { type: "string" } },
    blockingIssues: { type: "array", items: { type: "string" } },
  },
};

// ── Prompt builders ──────────────────────────────────────────────────────────
const houseBlock = HOUSE.map((h) => `- ${h}`).join("\n");

function implementPrompt(slice, isFirstSpine) {
  return [
    `You are implementing one slice of the execution-runtime build for the Synara repo (cwd = repo root).`,
    `Authoritative plan: ${PLAN}. Read it in full first, plus AGENTS.md/CLAUDE.md. Relevant sections: ${slice.refs}`,
    ``,
    `SLICE ${slice.key.toUpperCase()} — ${slice.title}`,
    `Scope: ${slice.spec}`,
    `Acceptance: ${slice.acceptance}`,
    ``,
    `House rules (non-negotiable):`,
    houseBlock,
    ``,
    `Git:`,
    isFirstSpine
      ? `- Create branch ${SPINE_BRANCH} off ${BASE_BRANCH} if it does not exist (never commit to ${BASE_BRANCH}).`
      : `- Work on the existing branch ${SPINE_BRANCH} (it carries prior slices incl. the committed PR1-3). Verify with \`git log --oneline -8 ${SPINE_BRANCH}\`.`,
    `- Implement ONLY this slice's scope. Preserve all existing local/worktree behavior.`,
    `- Run the slice's checks: at minimum \`bun typecheck\` and the affected package's tests (\`cd apps/<pkg> && bunx vitest run <pattern>\`); \`bun fmt\` + \`bun lint\` touched files. Do not claim success you didn't verify.`,
    `- Commit with a conventional message scoped to this slice. State the checks you ran and their result in the commit body.`,
    ``,
    `This is the WORK step. Do the implementation and commit. Finish with a short plain-text summary of what you changed, the commit sha, and the checks you ran + results. (A separate reporter agent will read git and produce the structured status — you do not need to.)`,
  ].join("\n");
}

function implementIsolatedPrompt(slice) {
  return [
    `You are implementing one INDEPENDENT slice of the execution-runtime build in an ISOLATED git worktree (cwd = your worktree root).`,
    `Authoritative plan: ${PLAN}. Read it in full first, plus AGENTS.md/CLAUDE.md. Relevant sections: ${slice.refs}`,
    ``,
    `SLICE ${slice.key.toUpperCase()} — ${slice.title}`,
    `Scope: ${slice.spec}`,
    `Acceptance: ${slice.acceptance}`,
    ``,
    `House rules (non-negotiable):`,
    houseBlock,
    ``,
    `Git:`,
    `- Your worktree is branched from the spine tip. Confirm the spine work is present (\`git log --oneline -12\` should show ${SPINE_BRANCH} commits incl. the runtime service). If NOT, base your work on ${SPINE_BRANCH}.`,
    `- Create branch feat/exec-runtime-${slice.key} and implement ONLY this slice on it. It is independent of the other provider/UI slices — do not depend on their files.`,
    `- Real provider API calls gated behind env credentials; pass the Phase-17 baseline contract with fakes when creds are absent.`,
    `- Run \`bun typecheck\` and affected tests; \`bun fmt\`+\`bun lint\` touched files. Commit on feat/exec-runtime-${slice.key} with a conventional message stating checks + results.`,
    ``,
    `This is the WORK step. Finish with a short plain-text summary, the branch name, the commit sha, and checks run + results. (A reporter agent reads git for the structured status.)`,
  ].join("\n");
}

function reportPrompt(slice, branch) {
  return [
    `READ-ONLY status report for execution-runtime slice ${slice.key.toUpperCase()}. cwd = repo root. Do NOT edit any files.`,
    `An implementer just committed work on branch ${branch}. Inspect git only:`,
    `- \`git log --oneline -5 ${branch}\``,
    `- \`git show --stat ${branch}\` (and \`git diff --stat ${SPINE_BRANCH}...${branch}\` if ${branch} is a provider branch, not ${SPINE_BRANCH} itself)`,
    `Acceptance for this slice: ${slice.acceptance}`,
    ``,
    `Return the structured slice result strictly from git evidence: key=${slice.key}, branch=${branch}, latest commit sha, filesChanged (paths from the stat), a one-line summary, and openIssues listing anything in the scope that the diff clearly does NOT cover. Set checksPassed=true only if the commit body/log states fmt+lint+typecheck+tests passed; otherwise false (the reviewer verifies independently). status=passed if a commit exists and matches the slice scope, blocked if missing/partial, failed if no commit.`,
    `Your ONLY job is to emit the structured result — call StructuredOutput as your final action.`,
  ].join("\n");
}

function reviewPrompt(slice, impl, isIsolated) {
  const branch =
    impl && impl.branch
      ? impl.branch
      : isIsolated
        ? `feat/exec-runtime-${slice.key}`
        : SPINE_BRANCH;
  return [
    `You are an adversarial reviewer for one execution-runtime slice. Default to skepticism; BLOCK work that does not meet acceptance or violates house rules.`,
    `Plan: ${PLAN} (sections: ${slice.refs}).`,
    ``,
    `SLICE ${slice.key.toUpperCase()} — ${slice.title}`,
    `Acceptance: ${slice.acceptance}`,
    `Reporter status: ${JSON.stringify(impl)}`,
    ``,
    `Inspect the actual change, do not trust the report:`,
    isIsolated
      ? `- Review the diff with \`git diff ${SPINE_BRANCH}...${branch}\` (read-only; do not modify the tree).`
      : `- Review the slice's commit(s) on ${SPINE_BRANCH} with \`git show\` / \`git diff\`.`,
    `- Independently run \`bun typecheck\` and an affected test; if checks fail, that is a blocker regardless of the report.`,
    ``,
    `Block if any holds: acceptance unmet; a house rule violated (Codex protocol logic rewritten, contracts gained runtime logic, ProviderRuntimeEvent extended, runtime stored on projection_threads, ProviderCommandReactor learned a provider id, an event-checklist site missed); existing behavior regressed; checks do not pass; an openIssue is actually a blocker.`,
    ``,
    `Return verdict ship|block with concrete findings (severity, file:line, issue, exact fix). Only "ship" when confident the slice is correct and complete.`,
  ].join("\n");
}

function fixPrompt(slice, impl, review) {
  return [
    `You are fixing review findings for execution-runtime slice ${slice.key.toUpperCase()} on branch ${SPINE_BRANCH} (cwd = repo root).`,
    `Plan: ${PLAN}. Acceptance: ${slice.acceptance}`,
    `House rules:`,
    houseBlock,
    ``,
    `Address every blocker/major finding below. Re-run \`bun typecheck\` + affected tests; \`bun fmt\`+\`bun lint\` touched files. Amend or add a commit on ${SPINE_BRANCH} stating checks + results.`,
    `Findings: ${JSON.stringify(review.findings)}`,
    `Reviewer notes: ${review.notes}`,
    ``,
    `This is a WORK step — finish with a short plain-text summary of the fixes and checks run. (A reporter agent reads git for structured status.)`,
  ].join("\n");
}

async function reportSlice(slice, branch, ph) {
  return agent(reportPrompt(slice, branch), {
    label: `report:${slice.key}`,
    phase: ph,
    schema: SLICE_RESULT_SCHEMA,
  });
}

// ── Spine slice driver: work -> report -> (review -> fix -> report)* ─────────
async function runSpineSlice(slice, isFirstSpine) {
  const work = await agent(implementPrompt(slice, isFirstSpine), {
    label: `build:${slice.key}`,
    phase: "Spine",
  });
  if (work == null) {
    log(`${slice.key}: implementer skipped.`);
    return null;
  }
  let impl = await reportSlice(slice, SPINE_BRANCH, "Spine");
  if (!impl) {
    log(`${slice.key}: reporter produced no status.`);
    return {
      key: slice.key,
      status: "blocked",
      branch: SPINE_BRANCH,
      finalVerdict: "unknown",
      reviewRounds: 0,
      openIssues: ["no reporter status"],
    };
  }
  let round = 0;
  let verdict = "unknown";
  while (round < MAX_REVIEW_ROUNDS) {
    const review = await agent(reviewPrompt(slice, impl, false), {
      label: `review:${slice.key}#${round + 1}`,
      phase: "Spine",
      schema: REVIEW_SCHEMA,
    });
    if (!review) break;
    verdict = review.verdict;
    if (verdict === "ship") break;
    await agent(fixPrompt(slice, impl, review), {
      label: `fix:${slice.key}#${round + 1}`,
      phase: "Spine",
    });
    const re = await reportSlice(slice, SPINE_BRANCH, "Spine");
    if (re) impl = re;
    round++;
  }
  if (verdict !== "ship") {
    log(
      `${slice.key}: still blocking after ${round} fix round(s). Spine halts here (downstream depends on it).`,
    );
  }
  return { ...impl, finalVerdict: verdict, reviewRounds: round };
}

// ── Phase 1: Brief ───────────────────────────────────────────────────────────
phase("Brief");
const brief = await agent(
  [
    `Read ${PLAN} in full, plus AGENTS.md/CLAUDE.md and the key files it cites (codexAppServerManager.ts + the new provider/process/JsonRpcLineTransport.ts, packages/effect-acp, ProviderCommandReactor, orchestration.ts, ProjectionPipeline, serverLayers.ts, the committed executionRuntime contracts + services).`,
    `PR1-PR3 are already committed on ${SPINE_BRANCH}; this run continues from PR4. Produce a compact build brief every implementer will rely on: exact check commands, the Effect Service/Layer skeleton to copy, the contracts barrel pattern, the effect-acp transport + makeInMemoryStdio fake, the add-an-event and add-a-thread-field checklists (file:line), and the top behavior-preservation risks.`,
    `Read-only. Cite file:line. Be dense.`,
  ].join("\n"),
  {
    label: "build-brief",
    phase: "Brief",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["commands", "conventions", "keyFiles", "risks"],
      properties: {
        commands: { type: "object", additionalProperties: { type: "string" } },
        conventions: { type: "array", items: { type: "string" } },
        keyFiles: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "role"],
            properties: { path: { type: "string" }, role: { type: "string" } },
          },
        },
        risks: { type: "array", items: { type: "string" } },
      },
    },
  },
);
log(
  `Brief ready. Spine slices: ${spineSlices.map((s) => s.key).join(", ") || "(none)"}. Parallel slices: ${parallelSlices.map((s) => s.key).join(", ") || "(none)"}.`,
);

// ── Phase 2: Spine (sequential; graceful halt on failure or block) ───────────
phase("Spine");
const spineResults = [];
let spineHalted = false;
for (let i = 0; i < spineSlices.length; i++) {
  const slice = spineSlices[i];
  const isFirstSpine = i === 0 && slice.key === "pr1";
  let r = null;
  try {
    r = await runSpineSlice(slice, isFirstSpine);
  } catch (e) {
    log(`${slice.key}: errored (${String(e && e.message ? e.message : e).slice(0, 200)}).`);
  }
  spineResults.push(r || { key: slice.key, status: "failed", finalVerdict: "error" });
  if (!r || r.finalVerdict !== "ship") {
    spineHalted = true;
    log(
      `Halting spine at ${slice.key}. Resume with args.slices starting at this key after fixing.`,
    );
    break;
  }
}

// ── Phase 3: Providers + UI (parallel, isolated worktrees) ───────────────────
phase("Providers");
let providerResults = [];
const spineComplete =
  spineSlices.length === 0 ||
  (!spineHalted && spineResults.every((r) => r && r.finalVerdict === "ship"));

if (parallelSlices.length === 0) {
  log("No parallel provider/UI slices selected.");
} else if (!spineComplete) {
  log(
    "Spine incomplete/blocked — skipping the parallel provider+UI build (it depends on the runtime service). Fix the spine and resume.",
  );
} else {
  providerResults = (
    await parallel(
      parallelSlices.map((slice) => () => {
        const branch = `feat/exec-runtime-${slice.key}`;
        return agent(implementIsolatedPrompt(slice), {
          label: `build:${slice.key}`,
          phase: "Providers",
          isolation: "worktree",
        }).then((work) => {
          if (work == null) return null;
          return reportSlice(slice, branch, "Providers").then((impl) => {
            if (!impl) return null;
            return agent(reviewPrompt(slice, impl, true), {
              label: `review:${slice.key}`,
              phase: "Providers",
              schema: REVIEW_SCHEMA,
            }).then((rev) => ({
              ...impl,
              finalVerdict: rev ? rev.verdict : "unknown",
              reviewFindings: rev ? rev.findings : [],
              reviewNotes: rev ? rev.notes : "",
            }));
          });
        });
      }),
    )
  ).filter(Boolean);
}

// ── Phase 4: Integrate (full suite + go/no-go) ───────────────────────────────
phase("Integrate");
const integrateWork = await agent(
  [
    `You are the integration gate for the execution-runtime build. cwd = repo root. This is the WORK step (run checks; a reporter follows).`,
    `Spine branch: ${SPINE_BRANCH} (off ${BASE_BRANCH}). Provider/UI slices each landed on feat/exec-runtime-<key>.`,
    `Spine results: ${JSON.stringify(spineResults)}`,
    `Provider/UI results: ${JSON.stringify(providerResults)}`,
    ``,
    `Check out ${SPINE_BRANCH} and run the FULL suite once: \`bun fmt\`, \`bun lint\`, \`bun typecheck\`, \`bun run test\`. Then skim \`git diff ${BASE_BRANCH}...${SPINE_BRANCH}\` for cross-slice regressions (local/worktree Codex behavior preserved; no provider id in ProviderCommandReactor; contracts still schema-only).`,
    `Finish with a plain-text report: each command + pass/fail, any regressions, and per provider/UI branch its review status. Do NOT merge anything.`,
  ].join("\n"),
  { label: "integrate-work", phase: "Integrate" },
);
const integration = await agent(
  [
    `READ-ONLY: turn the integration findings below into the structured result. Do not edit files. You may run \`git branch --list 'feat/exec-runtime*'\` to list branches.`,
    `Spine results: ${JSON.stringify(spineResults)}`,
    `Provider/UI results: ${JSON.stringify(providerResults)}`,
    `Integration findings:\n${integrateWork}`,
    ``,
    `Decide go/no-go for the spine: "go" only if the full suite passed and no slice is blocked. List every feat/exec-runtime* branch for human merge, all blocking issues, per-slice statuses, the exact checks run + results, and a one-paragraph summary. Call StructuredOutput as your final action.`,
  ].join("\n"),
  { label: "integrate-report", phase: "Integrate", schema: INTEGRATION_SCHEMA },
);

return {
  spineBranch: SPINE_BRANCH,
  baseBranch: BASE_BRANCH,
  spine: spineResults,
  providers: providerResults,
  integration,
};
