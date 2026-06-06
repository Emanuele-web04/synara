export const meta = {
  name: "audit-sandbox-lifecycle",
  description:
    "Adversarially audit the just-built sandbox suspend/resume lifecycle change for correctness and race bugs, live-test the resume path against real Daytona, survey the session's uncommitted changesets and deferred items, then synthesize a prioritized what's-left list with a go/no-go",
  phases: [
    {
      title: "Audit",
      detail: "correctness + races + live Daytona boundary + loose-ends survey, concurrent",
    },
    { title: "Verify", detail: "adversarially refute each substantive finding" },
    { title: "Synthesize", detail: "prioritized remaining-work list + go/no-go" },
  ],
};

const REPO = "/Users/tylersheffield/code/synara";

const FACTS = `
GROUND FACTS (verified by the orchestrator):
- Repo ${REPO}, branch feat/exec-runtime-pr9, HEAD 5d8c1cb8. The work under audit is UNCOMMITTED in the working tree. Inspect it with \`git -C ${REPO} diff\`.
- THREE unrelated changesets are piled uncommitted on this one branch:
  A) Sandbox suspend/resume LIFECYCLE (the focus): apps/server/src/executionRuntime/{Services/ExecutionRuntimeProviderAdapter.ts, Services/ExecutionRuntimeService.ts, Layers/ExecutionRuntimeService.ts, Layers/ExecutionRuntimeReconciler.ts(+test), Layers/DaytonaRuntimeProviderFacade.ts(+test), providers/daytona/DaytonaRuntimeAdapter.ts}.
  B) Remote-workspace UI polish: apps/web composer/settings (RuntimeEnvironmentControl, _chat.settings, sandboxSettings, appSettings, RuntimeStatusChip, runtimePresentation) + packages/contracts/src/settings.ts (sandbox runtime defaults).
  C) Skill-search latency: apps/web/src/lib/providerDiscovery*, hooks/useComposerCommandMenuItems, components/chat/ComposerCommandMenu, components/PluginLibrary, components/ChatView + the untracked apps/web/src/lib/providerDiscoveryReactQuery.test.ts.
- Daytona: $DAYTONA_API_KEY is in the user's zsh. Probe live as: zsh -c 'source ~/.zshrc >/dev/null 2>&1; <cmd>'. Mgmt API https://app.daytona.io/api (Bearer); toolbox proxy https://proxy.app.daytona.io. The Synara sandboxes are named/snapshotted terry-...-codex (mostly stopped). NEVER touch enzo-* sandboxes. NEVER print a secret value.
- effect-smol: Effect.catch (not catchAll), no Schedule.intersect. Read the real file before asserting.

WHAT THE LIFECYCLE CHANGE DOES (claim under audit):
- Probe liveness widened to alive|suspended|absent. Daytona livenessProbe: getStatus running/starting -> alive, stopped -> suspended, archived/destroyed/error/null -> absent. Adapter gains start? (Daytona: POST /sandbox/{id}/start then poll getStatus up to RESUME_POLL_ATTEMPTS(30) x 1s until running; returns false on null/archived/destroyed/error or timeout).
- ensureTargetForThread: a persisted-status==="stopped" instance -> resumeInstance (adapter.start) + reinject creds -> reuse; start returns false -> fall through to fresh provisionRemote. running/idle/starting reuse path is UNCHANGED.
- Reconciler: probe "suspended" -> record state "stopped" + keep (TTL cap only, no mark-lost, no destroy). probe "alive" idle (no live transport, past idleThreshold) -> service.stop (SUSPEND) instead of destroy. TTL raised 6h->24h. "absent" -> mark lost (unchanged).
- Facade: reinjectCredentials now warns on failure instead of silent Effect.ignore.`;

const FINDING = {
  type: "object",
  additionalProperties: false,
  properties: {
    dimension: { type: "string" },
    verdict: { type: "string", enum: ["clean", "issues"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          issue: { type: "string" },
          where: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "issue", "where"],
      },
    },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
  },
  required: ["dimension", "verdict", "summary"],
};

const VERDICT = {
  type: "object",
  additionalProperties: false,
  properties: {
    lifecycleVerdict: { type: "string", enum: ["ship", "ship-with-fixes", "needs-work"] },
    realBugs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          issue: { type: "string" },
          where: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "issue", "fix"],
      },
    },
    liveResumeProven: { type: "string", enum: ["proven", "partial", "not-run"] },
    remainingWork: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          item: { type: "string" },
          priority: { type: "string", enum: ["now", "next", "later"] },
          why: { type: "string" },
        },
        required: ["item", "priority"],
      },
    },
    commitPlan: { type: "string" },
    summary: { type: "string" },
  },
  required: ["lifecycleVerdict", "remainingWork", "summary"],
};

phase("Audit");
log("Auditing the sandbox suspend/resume lifecycle: correctness, races, live Daytona, loose ends");

const DIMENSIONS = [
  {
    key: "correctness",
    title: "Lifecycle correctness",
    spec: `Adversarially review the LIFECYCLE diff (changeset A) for correctness bugs. Read each changed file. Scrutinize: (1) the Daytona start poll loop — can it loop wrong, mis-handle a "starting" that never reaches running (returns false at timeout — good?), is Effect.sleep("1 second") valid effect-smol, does refreshActivity-as-start actually resume a STOPPED sandbox (POST /start) or only refresh a running one? (2) livenessProbe status mapping — is "stopped" the only suspended state, should "archived" be resumable (it is not — un-archive differs from /start; confirm that is acceptable), what about "starting" mapped to alive (a half-up sandbox)? (3) ensureTargetForThread — does the stopped->resume branch correctly fall through to fresh provision on start=false, and is reinject called only on success? Does it leave the running/idle reuse path byte-for-byte unchanged? (4) reconciler — does recording "stopped" each sweep dedupe (commandId)? Does service.stop on idle-alive actually suspend for Daytona (vs no-op)? Does the TTL 6h->24h interact badly with anything? (5) local/worktree threads: confirm targetKind!=="remote-runtime" is wholly unaffected. Report real bugs only, with file:line.`,
  },
  {
    key: "races",
    title: "Race conditions + failure modes (ops lens)",
    spec: `Hunt the race + failure modes the ops review warned about, against the ACTUAL code. (1) Stale-status race: the persisted instance status can lag reality — a Daytona sandbox auto-stopped (~15min) but the read-model still says "running"/"idle" until the reconciler records "stopped" (5-min sweep). In that window ensureTargetForThread takes the REUSE path (RUNNING_INSTANCE_STATUSES) and createTransport runs against a STOPPED sandbox. Does the new code handle this, or is it a gap? (the resume branch only triggers on persisted status==="stopped".) How bad is it — does createTransport fail the turn, or does Daytona auto-start on exec? (2) Resume-vs-reaper: can a turn resume an instance the same/next sweep is about to destroy/stop? (3) Resume of a provider-GC'd sandbox: start polls getStatus; null(404)->false->fresh provision — confirm that path is clean and never hangs. (4) Double-provision for one thread under concurrent turns. (5) The start poll holds the turn up to 30s — acceptable, or should it be shorter/async? Classify each as real-gap vs handled vs pre-existing, with file:line.`,
  },
  {
    key: "live-boundary",
    title: "Live Daytona resume-path boundary test",
    spec: `Prove the resume primitives work against REAL Daytona (not the app). Read DaytonaRuntimeAdapter.ts (livenessProbe + start) and HttpDaytonaSandboxClient.ts (getStatus, refreshActivity=POST /start, stop) for exact REST shapes. Then, using $DAYTONA_API_KEY: (1) pick a STOPPED terry-...-codex sandbox (GET /sandbox), record its id; confirm GET /sandbox/{id} returns a stopped state that normalizes to "stopped" (so livenessProbe would say "suspended"). (2) Exercise the resume: POST /sandbox/{id}/start, then poll GET /sandbox/{id} until state normalizes to running (mirror the adapter's 30x1s loop) — confirm a stopped sandbox actually comes back to running. (3) Then POST /sandbox/{id}/stop to put it back (cleanup), confirm it returns to stopped. NEVER touch enzo-* sandboxes. NEVER print the key. Report: did a real stopped sandbox resume to running, how long it took, the sandbox id used, and whether you cleaned up (stopped it again). If Daytona is too slow/limited, say how far you got — do not fabricate.`,
  },
  {
    key: "loose-ends",
    title: "Uncommitted changesets + deferred items survey",
    spec: `READ-ONLY survey of what's left in the session. (1) Using \`git -C ${REPO} status --short\` and \`git -C ${REPO} diff --stat\`, map every uncommitted file to one of the three changesets (A lifecycle / B remote-workspace UI polish / C skill-search latency) — list which files belong to which, and flag any that are ambiguous or accidentally touched. (2) Propose a clean commit/split plan: which files to stage for each of three separate commits (explicit paths; explicitly EXCLUDE .synara, .claude/worktrees, secrets), in what order, with a one-line conventional message each. (3) List the deferred lifecycle follow-ups the prior design review named (snapshot-at-reclaim blocked by secretTainted; tie reclaim to thread archive/delete; count-cap LRU orphan cleanup; resume-vs-reaper lease + double-provision mutex; wire the Timeout(s)/Persistent settings to real meaning) and rank them. Do NOT edit anything.`,
  },
];

const audits = (
  await parallel(
    DIMENSIONS.map(
      (d) => () =>
        agent(
          `${FACTS}\n\nDIMENSION: ${d.title}\n\n${d.spec}\n\nRead the real code/probe live. Return structured findings; verdict "issues" only for concrete, file:line-cited problems (or, for live-boundary, report what the live test showed). Be a skeptic, not a rubber stamp.`,
          { label: `audit:${d.key}`, phase: "Audit", schema: FINDING },
        ),
    ),
  )
).filter(Boolean);

for (const a of audits) {
  log(`audit:${a.dimension} -> ${a.verdict} (${(a.findings || []).length} finding(s))`);
}

phase("Verify");
const candidateFindings = audits
  .filter((a) => a.dimension !== "Live Daytona resume-path boundary test")
  .flatMap((a) => (a.findings || []).map((f) => ({ ...f, dimension: a.dimension })))
  .filter((f) => f.severity === "high" || f.severity === "medium");

const verified = (
  await parallel(
    candidateFindings.map(
      (f) => () =>
        agent(
          `${FACTS}\n\nA reviewer (${f.dimension}) raised this finding about the lifecycle change:\n${JSON.stringify(f, null, 2)}\n\nAdversarially verify it against the REAL code. Default to refuted=true. Is it a genuine bug that would bite in production, or a false positive / pre-existing / acceptable-by-design? Read the cited file. Decide refuted true|false with a one-line reason and (if real) the concrete minimal fix.`,
          {
            label: `verify:${(f.where || f.issue).slice(0, 28)}`,
            phase: "Verify",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                refuted: { type: "boolean" },
                severity: { type: "string", enum: ["high", "medium", "low"] },
                issue: { type: "string" },
                where: { type: "string" },
                fix: { type: "string" },
                reason: { type: "string" },
              },
              required: ["refuted", "issue", "reason"],
            },
          },
        ),
    ),
  )
).filter(Boolean);

const confirmed = verified.filter((v) => v.refuted === false);
log(`verify: ${confirmed.length}/${verified.length} findings confirmed as real`);

phase("Synthesize");
const live = audits.find((a) => a.dimension === "Live Daytona resume-path boundary test");
const looseEnds = audits.find((a) => a.dimension.includes("Uncommitted"));
const verdict = await agent(
  `${FACTS}\n\nSynthesize the final answer to "anything else to do here" for the sandbox lifecycle work and the session's loose ends.\n\nCONFIRMED REAL BUGS (survived adversarial verification):\n${JSON.stringify(confirmed)}\n\nLIVE DAYTONA BOUNDARY RESULT:\n${JSON.stringify(live)}\n\nLOOSE-ENDS / COMMIT-SPLIT SURVEY:\n${JSON.stringify(looseEnds)}\n\nProduce: lifecycleVerdict (ship / ship-with-fixes / needs-work); realBugs (only confirmed ones, with the minimal fix); liveResumeProven (proven/partial/not-run from the boundary result); a prioritized remainingWork list (now/next/later) covering both the confirmed bugs AND the deferred follow-ups AND the commit-split; and a concrete commitPlan (the three separate commits, explicit paths, never .synara/secrets/worktrees). Lead the summary with the single most important thing the user should do next.`,
  { label: "synthesize", phase: "Synthesize", schema: VERDICT },
);

return { audits, confirmed, live, looseEnds, verdict };
