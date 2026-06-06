export const meta = {
  name: "find-codex-daytona-gaps",
  description:
    "Find every gap preventing codex from running in a Daytona sandbox and streaming into the Synara UI, then produce an ordered fix plan",
  phases: [
    {
      title: "Investigate",
      detail: "parallel deep trace of each pipeline layer + structured gap report",
    },
    { title: "Synthesize", detail: "dedup + order gaps into a dependency-aware fix plan" },
    { title: "Critique", detail: "adversarial completeness check for missed gaps and weak fixes" },
  ],
};

const REPO = "/Users/tylersheffield/code/synara";

const GAP_REPORT = {
  type: "object",
  additionalProperties: false,
  properties: {
    layer: { type: "string" },
    summary: { type: "string" },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          location: { type: "string" },
          rootCause: { type: "string" },
          fix: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["title", "severity", "location", "rootCause", "fix"],
      },
    },
  },
  required: ["layer", "gaps"],
};

const FIX_PLAN = {
  type: "object",
  additionalProperties: false,
  properties: {
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          layer: { type: "string" },
          location: { type: "string" },
          fix: { type: "string" },
        },
        required: ["id", "title", "severity", "fix"],
      },
    },
    orderedSlices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          slice: { type: "string" },
          title: { type: "string" },
          gapIds: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "string" } },
          approach: { type: "string" },
          verification: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
        },
        required: ["slice", "title", "approach", "verification"],
      },
    },
    openQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["gaps", "orderedSlices"],
};

const CRITIQUE = {
  type: "object",
  additionalProperties: false,
  properties: {
    missingGaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          why: { type: "string" },
          location: { type: "string" },
        },
        required: ["title", "why"],
      },
    },
    weakFixes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { gap: { type: "string" }, concern: { type: "string" } },
        required: ["gap", "concern"],
      },
    },
    verdict: { type: "string" },
  },
  required: ["missingGaps", "verdict"],
};

const CONTEXT = `
GOAL: make a coding agent (codex) run inside a real Daytona cloud sandbox and stream its turn events into the Synara web UI, started from the UI (Remote -> Daytona thread).

WHAT ALREADY WORKS / WAS JUST FIXED (do not re-report as gaps):
- A per-session remote transport seam is wired: ProviderCommandReactor builds a transport factory from ExecutionRuntimeService.exec(instanceId, role:"agent") and threads it via a server-only serverOptions arg -> ProviderService.startSession -> CodexAdapter -> CodexAppServerManager (per-session createTransport; local CLI version gate skipped when supplied). Files: apps/server/src/orchestration/Layers/ProviderCommandReactor.ts (ensureSessionForThread), apps/server/src/provider/Services/ProviderAdapter.ts (RemoteAgentTransportFactory/ProviderSessionStartServerOptions), apps/server/src/provider/Layers/CodexAdapter.ts, apps/server/src/codexAppServerManager.ts.
- Real-vs-fake Daytona client selection works from settings/secret credentials.
- A live e2e (apps/server/src/executionRuntime/e2e/daytonaCodexLive.e2e.test.ts) PROVES a real codex turn streams from a real Daytona sandbox over the PTY transport. The app path is NOT yet working end to end.

CURRENT SYMPTOMS (real, from the running app):
- "Received invalid JSON from codex app-server." (codexAppServerManager.ts:2136 JSON.parse on every inbound line)
- Before creds were configured: stuck on a "daytona-fake-..." instance; fake forwards to a LOCAL codex spawn that fails ("failed to spawn codex") because the Electron app's PATH lacks codex.

KNOWN/SUSPECTED GAPS to verify and add to (not exhaustive — find MORE):
- Codex auth is NOT injected into the sandbox in the app path (the e2e injects ~/.codex/auth.json by hand). RuntimeCredentialBroker only hands opaque grant handles, it does not write auth into the instance.
- The Daytona client (real vs fake) is selected at LAYER BUILD (server startup, providerCredentialLayer.ts buildProviderLayerFromEnv -> Layer.unwrap), so a key saved in Settings only takes effect after a server restart.
- Secret settings fields are write-only with no "Configured" indicator, so a saved key looks unsaved (apps/web/src/routes/_chat.settings.tsx, apps/web/src/sandboxSettings.ts, apps/server getSettings).
- The snapshot must contain codex; the app does not validate/ensure a codex-equipped snapshot.

REPO: ${REPO}. Use git/grep/read freely. Cite exact file:line. A "gap" = anything that prevents codex from starting, authenticating, streaming, or being controlled from the UI on Daytona, OR makes the flow unusable/confusing.`;

const LAYERS = [
  {
    key: "transport-json-noise",
    title: "PTY transport + invalid-JSON parsing",
    focus: `Trace why "Received invalid JSON from codex app-server" happens. The manager parses EVERY inbound line as JSON (apps/server/src/codexAppServerManager.ts ~2115-2150 Stream.runForEach over context.transport.inbound -> JSON.parse). The Daytona PTY transport (apps/server/src/executionRuntime/providers/daytona/HttpDaytonaSandboxClient.ts: wrapInPty uses 'script -qfec ... stty -echo cols 100000', offerCompleteLines strips \\r and suppresses echoed input via pendingEcho, forwards each line to stdoutQueue). Identify EXACTLY which non-JSON lines reach the parser: the 'script' banner, stty output, codex stderr/log/banner lines, PTY control sequences, partial/coalesced frames, or echoed multi-line input. Decide the correct fix: should the manager skip lines that are not JSON-RPC frames (e.g. ignore lines not starting with '{'), or should the Daytona transport filter to JSON lines, or both? Also check JsonRpcLineTransport.ts:241 JSON.parse. Consider whether codex app-server writes logs to stdout vs stderr in the sandbox, and whether the PTY merges them.`,
  },
  {
    key: "codex-auth-injection",
    title: "Codex auth provisioning into the sandbox",
    focus: `Confirm and detail the codex-auth gap. The e2e injects ~/.codex/auth.json into the sandbox before driving the turn (see daytonaCodexLive.e2e.test.ts). The app provision/exec path does NOT. Trace: DaytonaRuntimeAdapter.provision, ExecutionRuntimeService.exec, RuntimeCredentialBroker (Layers/Services), RuntimeGitWorkspace, and any setup-role exec. Design the productized fix: WHERE to inject codex auth (provision-time once vs pre-agent-exec), WHAT to inject (host ~/.codex/auth.json, or the configured codex homePath, or a ServerSecretStore-held credential), HOW (a setup exec writing $HOME/.codex/auth.json, base64-safe), and how it interacts with secret-tainting/snapshots. Note CODEX_HOME/HOME differences across snapshot images (terry runs as root at /root). Also: does codex need only auth.json, or also config.toml / a chatgpt token refresh?`,
  },
  {
    key: "snapshot-and-binary",
    title: "Snapshot selection, codex binary + working dir",
    focus: `How does the app decide which Daytona snapshot to provision from? Trace the runtime plan (snapshotId) from UI -> contracts RuntimePlan -> ExecutionRuntimePlanner -> DaytonaRuntimeAdapter.provision -> client.create, plus ServerSettings.sandboxes.daytona.snapshot / defaultSnapshot and how/if it is applied. Gaps: is the snapshot validated to contain codex? Is there a sane default codex snapshot? How is the codex binary path + version resolved inside the sandbox (the manager skips the local version gate for remote, but does codex-cli version in the snapshot match the app-server protocol the manager speaks)? How is the working dir discovered (DaytonaRuntimeAdapter discoverRoot polling pwd) and is it correct for a codex image? Cite file:line.`,
  },
  {
    key: "cred-hot-reload",
    title: "Credential selection timing (restart requirement) + fake fallback",
    focus: `The Daytona client real-vs-fake choice is made at layer build (apps/server/src/executionRuntime/providerCredentialLayer.ts buildProviderLayerFromEnv -> Layer.unwrap, evaluated once when the runtime is constructed at server startup; runtimeLayer.ts). So a key saved in Settings needs a server restart. Find the cleanest fix to make credential changes take effect WITHOUT a restart (e.g. resolve the client per-provision, or rebuild/refresh the provider sub-layer on settings change, or read creds at provision time inside the adapter). Also: when a thread targets remote Daytona but NO real creds are configured, the system silently provisions a fake instance whose transport forwards to a LOCAL codex spawn that fails in the Electron PATH ("failed to spawn codex"). Decide whether remote-without-creds should error clearly ("no Daytona credentials configured") instead of fake-forwarding. Trace ExecutionRuntimeService provisionRemote/ensureTargetForThread + the fake flavor selection.`,
  },
  {
    key: "settings-ux",
    title: "Settings save UX for write-only secrets",
    focus: `The save path is correct (wsRpc serverUpdateSettings -> SandboxSecretWriter.persistSecrets -> ServerSecretStore; non-secret fields round-trip). But secret fields are write-only and the UI "Configured" badge checks the (always-empty-after-reload) value, so a saved key looks unsaved and there is no signal it is set. Trace: apps/web/src/routes/_chat.settings.tsx (badge render ~3024), apps/web/src/sandboxSettings.ts (sandboxSettingsToAppSettings skips secrets), apps/server/src/serverSettings.ts getSettings (no secret store access), apps/server/src/wsRpc.ts getSettings, apps/server/src/executionRuntime/sandboxCredentialMapping.ts. Design the clean fix: server reports which sandbox secrets are configured (booleans from ServerSecretStore) via getSettings, web shows a "Configured" badge from that. Note any contract-shape concerns (getSettings returns ServerSettings; do not pollute the persisted schema). Also note the snapshot/default-provider selection UX.`,
  },
  {
    key: "ui-create-render",
    title: "UI: create remote thread + render stream/errors",
    focus: `Trace how the web creates a Remote -> Daytona thread and how the runtime plan (provider + snapshotId) is built and sent: apps/web/src/components/RuntimeEnvironmentControl.tsx, runtimePlanDraftStore.ts, lib/runtimePresentation.ts, and the create/handoff command carrying runtimePlan (contracts). Gaps: can the user pick a snapshot/image in the UI? Is the configured defaultSnapshot used? How are remote runtime errors (like "invalid JSON", provisioning failures, auth failures) surfaced to the user in the conversation/runtime panel (RuntimeStatusChip, RuntimePanel)? Is there any retry/teardown UI? Confirm streaming render is runtime-agnostic (already believed yes) and find any UI-side gaps specific to remote.`,
  },
  {
    key: "lifecycle-reconnect",
    title: "Session lifecycle, teardown, reconnect on the running server",
    focus: `In the running app (not tests), trace the remote session lifecycle: ExecutionRuntimeService.exec records process.start and forks a detached watcher dispatching process.complete on transport.exit; CodexAppServerManager.stopSession -> closeTransport -> Daytona transport close -> session.close (kills the remote process). Gaps to verify: does stopping/restarting a remote thread leak the sandbox or the codex process? Does a second turn reuse the session (no double exec)? Does ExecutionRuntimeReconciler handle a remote instance after a server restart (the in-memory instanceProviders map is cold)? Is the sandbox ever destroyed (TTL/idle), and does the UI expose stop/destroy/snapshot (thread.runtime.action)? Cite file:line.`,
  },
  {
    key: "e2e-vs-app-parity",
    title: "Diff the working e2e against the broken app path",
    focus: `The live e2e (apps/server/src/executionRuntime/e2e/daytonaCodexLive.e2e.test.ts) drives a REAL codex turn that streams from a real Daytona sandbox. The app path does not. Do a precise DIFF of what the e2e does that the production app path does NOT. The e2e: applyRuntimePlan({provider:"daytona", snapshotId}), ensureTargetForThread, manually injects ~/.codex/auth.json, then builds CodexAppServerManager with a createTransport calling DaytonaRuntimeAdapter.createTransport directly, and drives startSession/sendTurn. Compare each step to the app path (reactor -> ProviderService -> CodexAdapter -> manager via my new serverOptions seam; ExecutionRuntimeService.exec vs adapter.createTransport directly). List every divergence that could explain why the app fails where the e2e passes (auth injection, env, cwd, snapshot, model selection, the exec wrapper vs direct createTransport, version gate, initialize params). This is the highest-signal investigator — be exhaustive.`,
  },
];

phase("Investigate");
log(`Tracing ${LAYERS.length} pipeline layers for codex-on-Daytona gaps`);

const reports = (
  await pipeline(
    LAYERS,
    (layer) =>
      agent(
        `${CONTEXT}\n\nLAYER: ${layer.title}\n\nINVESTIGATE: ${layer.focus}\n\nProduce a thorough, evidence-backed trace: cite exact file:line, quote the key code, explain the root cause of each gap, and propose a concrete fix (files + approach). Be exhaustive within this layer; surface gaps even if low-confidence. Do not write code — this is read-only investigation.`,
        {
          label: `trace:${layer.key}`,
          phase: "Investigate",
        },
      ),
    (trace, layer) =>
      agent(
        `Convert the following investigation of the "${layer.title}" layer into the structured gap report. Keep every distinct gap as its own entry with a precise file:line location, severity (blocker = stops codex working at all on Daytona; major = wrong/leaky/unusable; minor = polish), the real root cause, and a concrete fix. Layer key: "${layer.key}".\n\nINVESTIGATION:\n${trace}`,
        {
          label: `report:${layer.key}`,
          phase: "Investigate",
          schema: GAP_REPORT,
        },
      ),
  )
).filter(Boolean);

phase("Synthesize");
log(`Synthesizing ${reports.length} layer reports into an ordered fix plan`);

const plan = await agent(
  `You are the lead engineer. Merge these per-layer gap reports into ONE complete, de-duplicated, dependency-ordered fix plan to get codex running in a real Daytona sandbox and streaming into the Synara UI, started from the UI.\n\nAssign each gap a stable id (g1, g2, ...). Dedupe gaps reported by multiple layers. Order the work into implementable slices (each slice = a coherent change with files + approach + how to verify it), sequenced by dependency (e.g. fix invalid-JSON parsing and auth injection before a real turn can stream; credential hot-reload before settings UX matters). Blockers first. Each slice must name the gap ids it closes, the files it touches, the approach, and a concrete verification (unit test, the live e2e, or a manual UI step). Flag open questions that need a human decision.\n\nLAYER REPORTS (JSON):\n${JSON.stringify(reports)}`,
  { label: "synthesize-plan", phase: "Synthesize", schema: FIX_PLAN },
);

phase("Critique");
const critique = await agent(
  `Adversarially review this fix plan for COMPLETENESS and correctness. The goal is codex actually running in a Daytona sandbox and streaming into the UI from a user click. Independently re-examine the codebase at ${REPO}. Identify: (1) gaps the plan MISSED entirely (a layer or failure mode not covered) — give title, why it matters, and file:line; (2) fixes in the plan that are WRONG, too shallow, or would not actually work; (3) ordering/dependency mistakes. Be skeptical and specific. End with a verdict: is this plan complete enough to fully get codex working on Daytona, or what must be added.\n\nPLAN (JSON):\n${JSON.stringify(plan)}`,
  { label: "completeness-critic", phase: "Critique", schema: CRITIQUE },
);

return {
  gapCount: plan.gaps.length,
  sliceCount: plan.orderedSlices.length,
  reports,
  plan,
  critique,
};
