export const meta = {
  name: 'diff-codex-harness',
  description: 'Compare the codex agent harness local vs Daytona cloud across config/instructions, transport I/O, env/tools, approval+sandbox mode, workspace state, and binary/version/model — to explain why the agent behaves differently and how to align them',
  phases: [
    { title: 'Compare', detail: 'parallel per-dimension local-vs-cloud diff with live host+sandbox probing' },
    { title: 'Synthesize', detail: 'rank the differences that change behavior + an alignment plan' },
  ],
}

const REPO = '/Users/tylersheffield/code/synara'

const DIFF = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    local: { type: 'string' },
    cloud: { type: 'string' },
    differs: { type: 'boolean' },
    behavioralImpact: { type: 'string' },
    severity: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    recommendation: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
  },
  required: ['dimension', 'local', 'cloud', 'differs', 'behavioralImpact', 'severity', 'recommendation'],
}

const PLAN = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sameHarness: { type: 'string' },
    topCausesOfDifference: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { cause: { type: 'string' }, why: { type: 'string' }, fix: { type: 'string' } },
        required: ['cause', 'why', 'fix'],
      },
    },
    intendedDifferences: { type: 'array', items: { type: 'string' } },
    alignmentPlan: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { change: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, effort: { type: 'string' } },
        required: ['change'],
      },
    },
  },
  required: ['sameHarness', 'topCausesOfDifference', 'alignmentPlan'],
}

const CONTEXT = `
The Synara app runs the SAME coding agent (codex app-server) two ways:
- LOCAL: CodexAdapter builds CodexAppServerManager which spawns \`codex app-server\` as a host child process via makeCodexProcessTransport, env from buildCodexProcessEnv(homePath) (apps/server/src/codexProcessEnv.ts), cwd = the thread's local workspace (the user's actual working tree). codex reads the host ~/.codex/config.toml.
- CLOUD (Daytona): the SAME manager drives codex over a per-session remote JsonRpcLineTransport. The sandbox is provisioned from a codex snapshot; codex AUTH (~/.codex/auth.json) is injected from the host, plus a MINIMAL config.toml is written (codexAuthBootstrap.ts buildMinimalCodexConfigCommand). The repo is cloned into /root/synara (gitWorkspaceBootstrap.ts) and codex runs there. codex is launched as \`bash -lc 'cd /root/synara && env RUST_LOG=off codex app-server'\` under a PTY (script -qfec); stdout+stderr are MERGED and the manager frame-gates non-JSON lines.

The user reports the agent "acts different" locally vs in the cloud. Find EVERY harness difference, decide which ones change agent behavior, and how to align them.

REPO: ${REPO}. Read the real code. For ground truth, probe LIVE:
- Host: \`zsh -c 'source ~/.zshrc >/dev/null 2>&1; cat ~/.codex/config.toml; codex --version'\` (host config + version). $DAYTONA_API_KEY is also in zsh.
- Cloud sandbox: a codex sandbox may be running (list: GET https://app.daytona.io/api/sandbox with Bearer $DAYTONA_API_KEY; toolbox exec: POST https://proxy.app.daytona.io/toolbox/{id}/process/execute {command}). Probe the sandbox's /root/.codex/config.toml, codex --version, env, and the cloned repo state (git -C /root/synara status/branch/log). If no sandbox is alive, reason from the injection code (codexAuthBootstrap.ts) + what I already observed (cloud config.toml = sandbox_mode "danger-full-access", approval_policy "never", [projects."/root"] trust_level "trusted").`

const DIMENSIONS = [
  {
    key: 'config-instructions',
    title: 'config.toml, MCP servers, profiles, custom instructions, AGENTS.md',
    focus: `THE most likely cause. Compare the host ~/.codex/config.toml (full: model defaults, profiles, [mcp_servers], approval_policy, sandbox_mode, custom instructions, model_reasoning_effort, etc.) against the MINIMAL config.toml the cloud injects (codexAuthBootstrap.ts buildMinimalCodexConfigCommand — currently just sandbox_mode/approval_policy/trust_level). Enumerate exactly what the host config has that the cloud LACKS: MCP servers (tools the agent can call), profiles, default model + reasoning effort, custom/developer instructions, project trust, web-search/browser tools. Also: AGENTS.md is in the repo (now cloned) so codex reads it in both — confirm. The cloud agent with no MCP servers and no custom instructions and a forced approval policy will behave differently. Recommend whether to inject a SANITIZED copy of the host config.toml (minus host-only bits like the local browser-use socket / absolute host paths) instead of the minimal stub.`,
  },
  {
    key: 'approval-sandbox-runtimemode',
    title: 'approval policy + sandbox mode + runtimeMode mapping',
    focus: `Locally, the thread's runtimeMode maps to codex approval_policy + sandbox via mapCodexRuntimeMode (codexAppServerManager.ts) in the thread/start params. In the cloud, the injected config.toml hardcodes approval_policy="never" + sandbox_mode="danger-full-access" AND thread/start still passes mapped overrides. Determine which wins and whether the cloud agent auto-approves/executes everything while a local approval-required thread asks first — a visible behavior difference. Also whether codex's own sandboxing (seatbelt/landlock) differs (the cloud is danger-full-access in a container; local may be sandboxed). Recommend making the cloud honor the thread's runtimeMode like local.`,
  },
  {
    key: 'workspace-state',
    title: 'working tree the agent sees (local uncommitted vs fresh clone)',
    focus: `Local codex runs in the user's ACTUAL working tree: current branch HEAD + uncommitted changes + untracked files + ignored build artifacts. The cloud clones the repo fresh (gitWorkspaceBootstrap.ts / DaytonaRuntimeAdapter cloneRepoIntoSandbox) at a ref (determine: the thread's associatedWorktreeBranch/branch, default main) with NO uncommitted local changes and NO dependencies installed (node_modules, build outputs). So the cloud agent sees a clean checkout of a possibly-different branch, missing the user's in-progress edits and installed deps — a large behavior difference. Determine the exact ref cloned and whether deps/build are set up. Recommend: clone the thread's actual branch, and whether to mirror uncommitted changes (e.g. push a snapshot / apply a diff) and run install.`,
  },
  {
    key: 'env-tools',
    title: 'environment + tool availability',
    focus: `Compare buildCodexProcessEnv (codexProcessEnv.ts — host env, CODEX_HOME, PATH, any API keys / tool configs, browser-use pipe, RUST_LOG) against the cloud spawn env (\`env RUST_LOG=off\` over a sandbox login shell). What environment-dependent capabilities differ: API keys for tools the agent shells out to, PATH to dev tools (node/bun/python/linters/test runners), network egress, the codex browser tool / MCP transport sockets. RUST_LOG=off also means the cloud agent's own logging differs (cosmetic). Recommend which env the cloud agent needs to match local tool behavior.`,
  },
  {
    key: 'transport-io',
    title: 'transport + I/O fidelity (child process vs PTY polling)',
    focus: `Local uses makeCodexProcessTransport: separate stdout (pure JSON-RPC) + stderr channels, real-time pipe. Cloud uses the Daytona session/PTY transport: merged stdout+stderr over a PTY (script -qfec), polled at 100ms (after L1) with frame-gating + echo suppression, stderr classified from the merged stream. Determine whether this changes what the agent DOES (vs just streaming smoothness): could merged/echo/frame-gating drop or reorder frames, lose stderr-only signals codex acts on, or mangle large/binary outputs? Is approval/user-input request round-tripping reliable over the polled transport? Distinguish cosmetic streaming differences from behavior-affecting I/O fidelity issues.`,
  },
  {
    key: 'binary-version-model',
    title: 'codex binary version + model resolution',
    focus: `Compare the HOST codex version (\`codex --version\`) to the SNAPSHOT codex version (terry snapshot = codex-cli 0.128.0; enzo = 0.135.0). A version skew changes default behavior, prompts, tool schemas, and the app-server protocol. Also compare model resolution: locally vs cloud, how the requested model + reasoning effort + service tier reach thread/start (codexAppServerManager mapCodex.../resolveCodexModelForAccount), and whether the cloud account (the injected auth) resolves the same model/plan as local. Recommend pinning the snapshot codex version to match (or be >=) the host, and confirming model parity.`,
  },
]

phase('Compare')
log(`Comparing the codex harness local vs cloud across ${DIMENSIONS.length} dimensions`)

const diffs = (
  await parallel(
    DIMENSIONS.map((d) => () =>
      agent(
        `${CONTEXT}\n\nDIMENSION: ${d.title}\n\nCOMPARE (local vs cloud): ${d.focus}\n\nProduce ONE structured diff for this dimension: what it is locally, what it is in the cloud, whether they differ, the behavioral impact on the agent, a severity (high = likely explains "acts different", down to none), and a concrete recommendation to align them. Back it with evidence (file:line and any live-probe output). Read the real code and probe live where it helps.`,
        { label: `diff:${d.key}`, phase: 'Compare', schema: DIFF },
      ),
    ),
  )
).filter(Boolean)

phase('Synthesize')
const plan = await agent(
  `Synthesize these per-dimension local-vs-cloud codex-harness diffs into a clear answer to the user's question "is it running the same harness?". State plainly whether it IS the same harness and where it diverges. Rank the top causes of the agent behaving differently (most likely first) with why + the fix. List differences that are intended/acceptable (cosmetic streaming, logging). Give an ordered alignment plan (each change + files + rough effort) to make the cloud agent behave like local — prioritizing config/instructions, workspace state, and approval/runtime-mode parity if those rank high.\n\nDIFFS (JSON):\n${JSON.stringify(diffs)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: PLAN },
)

return { diffs, plan }
