export const meta = {
  name: "build-sandbox-settings",
  description:
    "Let Settings configure all sandbox/remote-runtime provider info (Daytona/Vercel/Modal/Cloudflare credentials, default snapshot/image, options) so the server connects to real sandboxes instead of falling back to fake when env vars are absent. Adds a settings schema + secret-store-backed credential resolution (settings override env) + a web Settings UI. Sequential slices on feat/exec-runtime-pr9; heavy agents free-form, a small reporter emits status.",
  whenToUse:
    "Run to add Settings-driven sandbox configuration. Pass args.only=['contracts'] to scope a slice.",
  phases: ["Brief", "Build", "Verify"],
};

const BRANCH = (args && args.branch) || "feat/exec-runtime-pr9";

const HOUSE = [
  'Effect-first: `class X extends ServiceMap.Service<X, Shape>()("t3/...")` + `Layer.effect`; never `Effect.Service`.',
  "packages/contracts is schema-only (effect/Schema). No runtime logic.",
  "Secrets (API keys/tokens) go through ServerSecretStore (apps/server/src/auth/Layers/ServerSecretStore.ts) — never store raw tokens in settings.json or log them. Mirror how existing agent-provider secrets are persisted via updateSettings.",
  "Settings override env, env is the fallback: the existing resolvers (resolveDaytonaCredentials/resolveVercelSandboxCredentials/resolveModalCredentials + Cloudflare bridge config) take an injectable `env` map defaulting to process.env — feed them a merged map (settings/secret values over process.env), do not rip out the env path.",
  "Behavior-preserving: with no settings configured, behavior is identical to today (env-or-fake).",
  "Checks: `bun typecheck`; `cd apps/<pkg> && bunx vitest run <pattern>` (vitest — never `bun test`); `bun fmt` + `bun lint` touched files.",
];
const houseBlock = HOUSE.map((h) => `- ${h}`).join("\n");

const SLICES = [
  {
    key: "contracts",
    title: "Sandbox-provider settings schema",
    spec: "In packages/contracts/src/settings.ts add a `sandboxes` (or `runtimeProviders`) section to ServerSettings + ServerSettingsPatch. Per remote provider: daytona { apiKey (secret), apiUrl?, organizationId?, target?, snapshot? }, vercel { token (secret), teamId, projectId, runtime? }, modal { tokenId, tokenSecret (secret), environment? }, cloudflare { bridgeUrl, bridgeToken (secret) }. Plus optional defaults: defaultRemoteProvider, defaultSnapshot. Secret fields are write-only references (the value lives in ServerSecretStore) — follow exactly how the file already models agent-provider secrets (check the codex/claude provider settings + the *Patch shape). Keep schema-only. Update DEFAULT_SERVER_SETTINGS so existing settings.json decode unchanged.",
    pkg: "contracts",
    test: "settings",
  },
  {
    key: "server",
    title: "Settings-driven credential resolution + secret persistence",
    spec: "Add a `RuntimeProviderCredentials` Effect service (apps/server/src/executionRuntime/...) that, for a given provider, returns the credential env map by merging the configured settings + secret-store values OVER process.env (settings win; env is fallback; nothing configured -> process.env unchanged -> fake fallback as today). It depends on the existing settings service (serverSettings.ts) + ServerSecretStore. Refactor each provider runtime layer (daytona/runtimeLayer.ts, vercelSandbox/runtimeLayer.ts, modal/runtimeLayer.ts, cloudflare adapter layer) so it resolves credentials through this service instead of reading process.env at build time — so a key entered in Settings (no server restart) selects the real client on the NEXT provision. Wire updateSettings (wsRpc.ts / serverSettings.ts) to persist the secret fields into ServerSecretStore and the non-secret fields into settings. Do NOT log tokens. Keep the fake fallback intact when nothing is configured.",
    pkg: "server",
    test: "executionRuntime ServerSecretStore serverSettings RuntimeProviderCredentials daytona",
  },
  {
    key: "web",
    title: "Settings UI: Sandboxes section",
    spec: "In apps/web add a 'Sandboxes' (remote runtimes) section to the existing Settings surface (find where ServerSettings is edited — the settings panel that calls server.getSettings/updateSettings). Per provider: credential inputs (API key/token as password fields, never echoed back from the server — show a 'configured' indicator instead), Daytona apiUrl/organizationId/target/snapshot, Vercel teamId/projectId/runtime, Modal environment, Cloudflare bridgeUrl. Plus default remote provider + default snapshot. Wire save through the same updateSettings path other settings use. Match the existing settings UI patterns/components.",
    pkg: "web",
    test: "settings runtimePresentation",
  },
];
const selected = Array.isArray(args && args.only)
  ? SLICES.filter((s) => args.only.includes(s.key))
  : SLICES;

const STATUS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["key", "status", "checksPassed", "filesChanged", "summary", "openIssues"],
  properties: {
    key: { type: "string" },
    status: { type: "string", enum: ["passed", "blocked", "failed", "skipped"] },
    checksPassed: { type: "boolean" },
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
  required: ["secretPattern", "settingsEditSurface", "credResolutionPlan", "risks"],
  properties: {
    secretPattern: {
      type: "string",
      description:
        "exactly how existing agent-provider secrets are modeled in settings.ts + persisted via updateSettings/ServerSecretStore (file:line)",
    },
    settingsEditSurface: {
      type: "string",
      description:
        "where ServerSettings is edited in apps/web (component/path) and the getSettings/updateSettings call path",
    },
    credResolutionPlan: {
      type: "string",
      description:
        "the exact seam to move provider cred resolution from build-time process.env to a settings-backed service, per provider layer (file:line)",
    },
    risks: { type: "array", items: { type: "string" } },
  },
};
const GO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goNoGo", "summary", "sliceStatuses", "checksRun", "blockingIssues"],
  properties: {
    goNoGo: { type: "string", enum: ["go", "no-go"] },
    summary: { type: "string" },
    sliceStatuses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "status"],
        properties: { key: { type: "string" }, status: { type: "string" } },
      },
    },
    checksRun: { type: "string" },
    blockingIssues: { type: "array", items: { type: "string" } },
  },
};

function workPrompt(s, recipe) {
  return [
    `Implement "${s.title}" for Settings-driven sandbox configuration on branch ${BRANCH} (cwd = repo root). WORK step.`,
    `Goal: a key entered in the app's Settings (e.g. DAYTONA_API_KEY) makes the server use the REAL provider client instead of falling back to fake. Today the embedded server has no env creds, so remote threads provision a \`daytona-fake\` instance — this fixes that.`,
    ``,
    `Design recipe (from the Brief — follow it):`,
    JSON.stringify(recipe),
    ``,
    `Slice scope: ${s.spec}`,
    ``,
    `House rules:`,
    houseBlock,
    ``,
    `Verify: \`bun typecheck\`; \`cd apps/${s.pkg === "contracts" ? "../packages/contracts" : s.pkg} && bunx vitest run ${s.test}\` (adjust path for the contracts package); \`bun fmt\`+\`bun lint\` touched files. Commit on ${BRANCH} stating checks + results. Finish with a short plain-text summary (files, commit sha, checks + results, honest open issues).`,
  ].join("\n");
}
function reportPrompt(s) {
  return [
    `READ-ONLY status report for the "${s.title}" slice. cwd = repo root. Do NOT edit files.`,
    `Inspect git: \`git log --oneline -3 ${BRANCH}\`, \`git show --stat ${BRANCH}\`. Return the structured result: key=${s.key}, status, branch=${BRANCH}, commit, filesChanged, one-line summary, openIssues. checksPassed only if the commit body states checks passed. Call StructuredOutput as your final action.`,
  ].join("\n");
}
function reviewPrompt(s, impl) {
  return [
    `Adversarial review of the "${s.title}" slice on ${BRANCH}. Default to BLOCK. cwd = repo root.`,
    `Reporter status: ${JSON.stringify(impl)}`,
    `Inspect the real change (\`git show ${BRANCH}\`); run \`bun typecheck\` and the slice's tests.`,
    `Block if: secrets are stored in plaintext settings or logged; settings do NOT override env at provision time (a key entered in Settings still falls back to fake); behavior changes when nothing is configured; contracts gained runtime logic; checks fail; an openIssue is a blocker.`,
    `Return verdict ship|block with concrete findings (severity, file:line, issue, fix).`,
  ].join("\n");
}
function fixPrompt(s, review) {
  return [
    `Fix review findings for "${s.title}" on ${BRANCH} (cwd = repo root). WORK step.`,
    `House rules:`,
    houseBlock,
    `Address every blocker/major. Re-run typecheck + the slice tests; fmt+lint touched files. Amend/add a commit on ${BRANCH}.`,
    `Findings: ${JSON.stringify(review.findings)}\nNotes: ${review.notes}`,
    `Finish with a short plain-text summary.`,
  ].join("\n");
}
async function reportSlice(s, ph) {
  return agent(reportPrompt(s), { label: `report:${s.key}`, phase: ph, schema: STATUS_SCHEMA });
}

phase("Brief");
const recipe = await agent(
  [
    `Produce the precise implementation recipe for adding Settings-driven sandbox/runtime-provider configuration. Read-only; cite file:line. cwd = repo root.`,
    `Read: packages/contracts/src/settings.ts (ServerSettings + ServerSettingsPatch + how agent-provider SECRETS are modeled), apps/server/src/serverSettings.ts + wsRpc.ts (getSettings/updateSettings flow), apps/server/src/auth/Layers/ServerSecretStore.ts (secret read/write API), the provider cred resolvers (executionRuntime/providers/{daytona/DaytonaConfig.ts, vercelSandbox/Layers/VercelSandboxConfig.ts, modal/ModalCredentials.ts} + their runtimeLayer.ts that env-select real-vs-fake at build time), and the apps/web Settings UI (where ServerSettings is edited).`,
    `Decide: (1) the exact secret pattern to mirror; (2) the web settings edit surface; (3) the seam to move provider credential resolution from build-time process.env to a settings-backed Effect service so a Settings change selects the real client on the next provision (without a restart); (4) risks.`,
  ].join("\n"),
  { label: "sandbox-settings-recipe", phase: "Brief", schema: BRIEF_SCHEMA },
);
log(`Recipe ready. Slices: ${selected.map((s) => s.key).join(", ")}.`);

phase("Build");
const results = [];
let halted = false;
for (const s of selected) {
  const work = await agent(workPrompt(s, recipe), { label: `build:${s.key}`, phase: "Build" });
  if (work == null) {
    log(`${s.key}: skipped`);
    halted = true;
    break;
  }
  let impl = await reportSlice(s, "Build");
  if (!impl) {
    halted = true;
    break;
  }
  let round = 0,
    verdict = "unknown";
  while (round < 3) {
    const review = await agent(reviewPrompt(s, impl), {
      label: `review:${s.key}#${round + 1}`,
      phase: "Build",
      schema: REVIEW_SCHEMA,
    });
    if (!review) break;
    verdict = review.verdict;
    if (verdict === "ship") break;
    await agent(fixPrompt(s, review), { label: `fix:${s.key}#${round + 1}`, phase: "Build" });
    const re = await reportSlice(s, "Build");
    if (re) impl = re;
    round++;
  }
  results.push({ ...impl, finalVerdict: verdict });
  if (verdict !== "ship") {
    halted = true;
    log(`Halting at ${s.key}: not shippable. Later slices depend on it.`);
    break;
  }
}

phase("Verify");
const allShipped = !halted && results.length === selected.length;
const verifyWork = allShipped
  ? await agent(
      [
        `Final verification on ${BRANCH} (cwd = repo root). Run \`bun fmt\`, \`bun lint\`, \`bun typecheck\`, and \`cd apps/server && bunx vitest run executionRuntime serverSettings ServerSecretStore\` + \`cd apps/web && bunx vitest run settings\` + \`cd packages/contracts && bunx vitest run settings\`. Confirm: with a daytona apiKey set in settings, the daytona layer resolves the REAL client (write a focused test feeding a settings/secret map and asserting the real client is selected — no live network). Report each command + pass/fail and any regressions. Known pre-existing failures (GitCore trailing-slash, terminal Manager ENOTEMPTY, web zustand-persist) are not regressions.`,
      ].join("\n"),
      { label: "verify-work", phase: "Verify" },
    )
  : "skipped (build incomplete)";
const verdict = await agent(
  [
    `READ-ONLY: structured go/no-go for the sandbox-settings feature. Do not edit files.`,
    `Slice results: ${JSON.stringify(results)}\nVerify findings:\n${verifyWork}`,
    `goNoGo="go" only if all slices shipped, typecheck + tests pass, and settings-override-env is proven (a configured key selects the real client). List per-slice statuses, checks run, blocking issues. Call StructuredOutput as your final action.`,
  ].join("\n"),
  { label: "go-no-go", phase: "Verify", schema: GO_SCHEMA },
);

return { branch: BRANCH, slices: results, verdict };
