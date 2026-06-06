export const meta = {
  name: "get-codex-on-daytona",
  description:
    "Implement the codex-on-Daytona fix plan slice-by-slice (implement -> report -> adversarial review -> fix), so a UI Remote->Daytona thread runs codex in a real sandbox and streams a turn",
  phases: [
    {
      title: "Build",
      detail: "each slice: implement, structured report, adversarial review, fix to green",
    },
    { title: "Verify", detail: "full fmt/lint/typecheck + e2e parity assertions" },
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
    gapsClosed: { type: "array", items: { type: "string" } },
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
GROUND TRUTH RULES (a prior plan had stale paths/call-sites — trust the code, not the spec):
- The IMPLEMENTATION lives in apps/server/src/executionRuntime/Layers/* (the Services/* dir holds interfaces). Read the real file before editing.
- discoverRoot + the create body live INSIDE the Daytona adapter (DaytonaRuntimeAdapter.ts / HttpDaytonaSandboxClient.ts), NOT in ExecutionRuntimeService.provisionRemote. Auth/setup execs must go through the adapter (execCollect) or a service method that delegates to it.
- The Daytona toolbox runs commands BARE (buildShellCommand: \`cd '<dir>' && env K=V '<cmd>'\`), with no bash -lc login shell. If codex must be found on PATH or $HOME-relative paths must resolve, wrap the command in \`bash -lc\` (or set absolute paths) — verify, do not assume.
- The Daytona PTY merges stdout+stderr (stderrLines is Stream.empty). Codex log lines are interleaved into the JSON-RPC stream.
- Local/worktree threads must be byte-for-byte unaffected by every change (gate remote behavior on the resolved remote instance/target only).
- effect-smol: there is no Effect.catchAll or Schedule.intersect (use Effect.catch). Do not use Math.random/Date.now in any workflow script, but app code may.
- After your slice, run \`cd ${REPO}/apps/server && bun run typecheck\` (server tsc --noEmit, fast) and fix until it passes — this is the targeted check for your slice. Do NOT run the full fmt/lint/typecheck trio (the Verify phase does that once).
- Make changes on the current branch (feat/exec-runtime-pr9). Do not commit.`;

// Slice specs. The implementer re-verifies against real code; these set direction + the critic's corrections.
const SLICES = [
  {
    key: "S1",
    mvp: true,
    title: "Per-provision credential resolution + missing-creds preflight (no server restart)",
    spec: `Make the Daytona real-vs-fake client choice happen per provision, not once at server boot. Today providerCredentialLayer.ts buildProviderLayerFromEnv uses Layer.unwrap, evaluated once at runtime construction, so a key saved in Settings needs a restart. Replace with a per-call dispatching client: provide BOTH the fake and the real Http client (the real one needs HttpClient in RIn — make sure it is provided), plus a thin selector that on each create() reads RuntimeProviderCredentials.envFor('daytona'), runs resolveDaytonaCredentials, picks real or fake, and caches the chosen impl per sandboxId so exec/startSession/destroy stay on the same backend. Apply at the shared provider seam so other providers inherit it. In applyRuntimePlan/provisionRemote, reject at create with a typed error (RuntimeProvisionFailedError or a new MissingCredentialsError) when a non-'fake' provider has no creds (mirror daytonaCredentialsConfigured). Default provisionRemote's missing-intent fallback to the persisted runtime.instance.provider, only using 'fake' when persisted is 'fake'. Reconcile the three contradictory credential docstrings to 'next provision'.`,
    gaps: "g1,g5,g6,g26",
  },
  {
    key: "S2",
    mvp: true,
    title: "Snapshot + provider threaded UI -> plan -> create; reconcile dead defaultSnapshot",
    spec: `The composer "Remote" always means fake (RuntimeEnvironmentControl.tsx defaults provider to "fake"), and buildRuntimePlanFromDraft hardcodes snapshotId:null (runtimePresentation.ts:250). Add snapshotId:string|null to RuntimePlanDraft + DEFAULT_RUNTIME_PLAN_DRAFT; render a "Snapshot (image)" input in the RuntimeEnvironmentControl advanced panel defaulting to the resolved snapshot setting; thread it through buildRuntimePlanFromDraft. Seed draft.provider from the configured sandboxDefaultRemoteProvider in selectRemote so "Remote" uses the real provider. Decide defaultSnapshot's fate: wire resolution order plan -> daytona.snapshot -> defaultSnapshot in the create body, OR delete defaultSnapshot entirely (contracts + sandboxCredentialMapping + settings UI) — do not ship two live-looking snapshot fields.`,
    gaps: "g3,g10,g20",
  },
  {
    key: "S3S4",
    mvp: true,
    title:
      "JSON-noise frame-gate + codex auth injection + bash -lc login shell + minimal config (co-blocking)",
    spec: `These are co-blocking: the parseError flood is PARTLY unauthenticated-codex login text, so the JSON fix alone will not clear it — auth must land together.
(1) JSON noise: in codexAppServerManager.ts handleStdoutLine (~2129), before JSON.parse, frame-gate on '{': a line whose first non-whitespace char is not '{' is process/log output — route it through classifyCodexStderrLine (emit process/stderr for ERROR-level codex logs, restoring local-transport parity) and never emit a user-visible protocol/parseError. Downgrade the JSON.parse catch to a debug log. Also harden pendingEcho echo-suppression (an unmatched echoed outbound frame is valid JSON and gets mis-dispatched as an inbound request) — make stty -echo reliable / verify it applied before codex starts, or tag/track outbound frames so echoes can't be mistaken for inbound. Drop the unterminated exit-time residual unless it parses.
(2) Silence logs at source: thread RUST_LOG=off (or error) through the spawn env (toExecInput / DaytonaRuntimeAdapter spawn) and redirect codex stderr off the merged PTY where feasible.
(3) Auth injection: write codex auth into the sandbox BEFORE the agent transport starts. After the sandbox is provisioned and the working dir discovered, run a setup-role exec (adapter.execCollect) that creates $HOME/.codex/auth.json from the host operator's auth (resolveBaseCodexHomePath -> read auth.json -> base64-safe: bash -lc 'mkdir -p "$HOME/.codex" && printf %s "$0" | base64 -d > "$HOME/.codex/auth.json" && chmod 600 ...' <b64>). Write a MINIMAL config.toml if codex needs it to pick model/approval/sandbox (verify against codex app-server startup) — do NOT copy host config.toml (it references a local browser socket). Make auth.json writable (token refresh).
(4) bash -lc: codex must be on PATH and $HOME must resolve inside the sandbox. buildShellCommand currently runs bare with no login shell — wrap agent/setup commands in bash -lc (or use absolute paths + explicit HOME) so codex is found and auth lands in the right HOME. Verify against the snapshot image.`,
    gaps: "g2,g4,g7,g18,g24,g27,g28,g31",
  },
  {
    key: "S5",
    mvp: true,
    title:
      "Codex presence/version probe + snapshot/auth taint + re-inject-on-resume + model validation",
    spec: `After provision, run execCollect('codex',['--version']) (or 'command -v codex') and FAIL provisioning with a clear actionable error ("snapshot has no compatible codex" / version mismatch) instead of a late opaque JSON/transport error; gate the version against the manager's initialize handshake minimum. Tag the instance secret-tainted when auth is written; gate adapter.snapshot when tainted; re-inject fresh auth on every resume in ensureTargetForThread's reuse/resume branch (token expiry). Validate the requested model against the sandbox codex model/list and fall back gracefully instead of wedging initialize.`,
    gaps: "g8,g9,g32",
  },
  {
    key: "S7",
    mvp: true,
    title:
      "Activity-lease keepalive so live turns are not torn down (refreshActivity timer, NOT per-line events)",
    spec: `Two blockers: the idle reconciler destroys the sandbox mid-conversation because lastActivityAt freezes (stream output is not event-sourced), and the activity-lease keepalive (RuntimeActivityLeaseManager acquire/renew/release) has zero callers so Daytona auto-stops the sandbox under a live agent. Inject RuntimeActivityLeaseManager into the live ExecutionRuntimeService; acquire a lease on exec and renew on a timer while built.transport is alive (release on transport.exit), routing renew through adapter.refreshActivity. To keep the reconciler from idle-destroying an active sandbox, prefer skipping idle-destroy when the thread has a live transport/lease — do NOT re-event-source every output line (that volume was deliberately removed by resolved decision #5). Keep local threads unaffected.`,
    gaps: "g13,g14",
  },
  {
    key: "S6",
    mvp: false,
    title: "Remote cwd unification + repo clone into the sandbox",
    spec: `Clone the repo (RuntimeGitWorkspace.clone + checkout -B thread branch) into a known working dir during remote provision for agent threads, and pass that dir as the agent cwd. Make exec/createTransport cwd and the CodexAdapter session cwd resolve from the single discovered/cloned rootPath; for remote threads resolve effectiveCwd from the discovered target only (no host projectedCwd leak). getStatus should return the discovered rootPath, not the SANDBOX_ROOT constant. (Note: remote cwd already largely converges; verify before adding code — g12 may be near-dead.)`,
    gaps: "g11,g12",
  },
  {
    key: "S8",
    mvp: false,
    title: "Sandbox lifecycle teardown: destroy-on-delete, reaper, PTY kill, reconnect aborts",
    spec: `ThreadDeletionReactor: look up the instance and call ExecutionRuntimeService.destroy BEFORE dropping the read-model row. Make ProviderSessionReaper remote-aware (stop/destroy the instance) or defer remote threads to the reconciler — unify the two 30-min idle sweeps under one owner. Give the Daytona session close a real idempotent remote teardown (session-delete / interrupt) before Scope.close so restart/stop kills the PTY (no orphaned codex). On startup, for any remote thread with a non-terminal session.status but no live manager session, emit session-error/turn-aborted so the UI doesn't show a phantom running turn.`,
    gaps: "g21,g22,g23,g25",
  },
  {
    key: "S9",
    mvp: false,
    title: "Server-truth secret-configured signal + blank-secret no-op",
    spec: `Compute a secretsConfigured boolean map (per provider/field) from ServerSecretStore using the exact resolver predicate; add it to ServerGetSettingsResult/ServerUpdateSettingsResult (a SIBLING struct, not on disk-persisted ServerSettings) and to the settingsUpdated push; emit from wsRpc getSettings/update. Web: gate the "Configured" badge on secretsConfigured (not the always-empty value) and apply the push value. In appSettingsPatchToSandboxesPatch, OMIT secret fields that are empty-after-trim so a blank input never clears a stored key (g16 silent data loss). Drop persisted-localStorage secret keys once server-truth lands.`,
    gaps: "g15,g16,g29",
  },
  {
    key: "S10",
    mvp: false,
    title: "Remote provisioning UX: failure banner+retry, deferred-provision cue, configured hints",
    spec: `Promote instance.failureReason to a banner (ThreadErrorBanner or a runtime banner) on error tone with a Retry action wired to a server re-provision command (surface S1's typed missing-credentials message). Add a presentation flag so "provisioning + instance==null" renders "Provisioning starts on first message". Show a "not configured" hint (or disable) on un-credentialed providers in the Default remote provider select using S9's secretsConfigured.`,
    gaps: "g17,g19,g30",
  },
];

const scope = (args && args.scope) || "mvp";
const selected = Array.isArray(scope)
  ? SLICES.filter((s) => scope.includes(s.key))
  : scope === "all"
    ? SLICES
    : SLICES.filter((s) => s.mvp);

log(
  `Building codex-on-Daytona — scope=${Array.isArray(scope) ? scope.join(",") : scope} — ${selected.length} slices: ${selected.map((s) => s.key).join(", ")}`,
);

phase("Build");

const results = [];
for (const slice of selected) {
  // Implement (free-form; re-verifies against real code, edits the working tree).
  await agent(
    `${PRINCIPLES}\n\nSLICE ${slice.key}: ${slice.title}\nCloses gaps: ${slice.gaps}\n\nWHAT TO DO:\n${slice.spec}\n\nImplement this slice end-to-end in ${REPO} on the current branch. Read the real files first, write the code, add or update focused unit tests where they pin the behavior, and run the server typecheck until it passes. Keep local/worktree behavior unchanged. Report what you changed.`,
    { label: `impl:${slice.key}`, phase: "Build" },
  );

  // Structured report from git (decoupled so the heavy impl agent never fails on a missing tool call).
  const report = await agent(
    `Report the status of slice ${slice.key} ("${slice.title}") by inspecting the working tree at ${REPO}: run \`git -C ${REPO} status --short\` and \`git -C ${REPO} diff --stat\`, and \`cd ${REPO}/apps/server && bun run typecheck\` (record pass/fail). List the files changed by this slice, summarize what was done, which of these gaps it closed (${slice.gaps}), and any followups. Do not edit anything.`,
    { label: `report:${slice.key}`, phase: "Build", schema: REPORT },
  );

  // Adversarial review of this slice's diff.
  const review = await agent(
    `${PRINCIPLES}\n\nAdversarially review slice ${slice.key} ("${slice.title}", gaps ${slice.gaps}). Inspect its diff: \`git -C ${REPO} diff\` (focus on the files this slice touched: ${(report && report.filesChanged && report.filesChanged.join(", ")) || "see git diff"}). Check: does it actually close the named gaps? Does it break the local/worktree path? Any effect-smol misuse (Effect.catchAll/Schedule.intersect don't exist)? Any of the known traps for THIS slice (e.g. for auth: does the command use bash -lc so $HOME resolves and codex is on PATH? for JSON: does the frame-gate still surface ERROR logs and not drop real frames? for creds: is HttpClient provided to the real client and is local behavior untouched?). Return a verdict: "ship" if no blocking problems, else "fix" with concrete blocking issues + fixes.`,
    { label: `review:${slice.key}`, phase: "Build", schema: REVIEW },
  );

  // One fix pass if the reviewer found blocking issues.
  if (review && review.verdict === "fix" && review.blocking && review.blocking.length > 0) {
    await agent(
      `${PRINCIPLES}\n\nFix the blocking issues found in slice ${slice.key} ("${slice.title}"). Address each and re-run the server typecheck until it passes:\n${JSON.stringify(review.blocking, null, 2)}`,
      { label: `fix:${slice.key}`, phase: "Build" },
    );
  }

  results.push({ slice: slice.key, report, review });
  log(
    `Slice ${slice.key} done — report=${report ? report.status : "null"} review=${review ? review.verdict : "null"}`,
  );
}

phase("Verify");
log("Running full fmt/lint/typecheck and summarizing e2e parity");

const verify = await agent(
  `Final verification of the codex-on-Daytona build in ${REPO}. Run the one bundled heavyweight check: \`cd ${REPO} && bun run typecheck\` (turbo, all packages), \`bun run lint\`, and \`bunx oxfmt --check\` on the changed files. Then run the affected unit tests with \`cd ${REPO}/apps/server && bun run test\` for the touched areas (provider, executionRuntime, codexAppServerManager, orchestration). Report exact pass/fail counts and any remaining errors with file:line. Also state, based on the diff, whether the app path can now: select the real Daytona client without restart, provision a codex snapshot, inject auth, parse codex output without parseError spam, and keep the sandbox alive during a turn. Do not fix — just verify and report precisely.`,
  { label: "final-verify", phase: "Verify", schema: REPORT },
);

return { scope, slices: results.map((r) => r.slice), results, verify };
