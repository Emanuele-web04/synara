export const meta = {
  name: "optimize-codex-daytona-latency",
  description:
    "Cut codex-on-Daytona latency: research the PTY WebSocket + incremental-read feasibility, then implement incremental log reads, provisioning backoff/folded setup, and a real-time PTY WebSocket transport — preserving the working polling path as a fallback",
  phases: [
    {
      title: "Research",
      detail:
        "confirm the Daytona PTY WebSocket API + incremental-read support + a latency baseline",
    },
    {
      title: "Build",
      detail: "each slice: implement, report, adversarial review, fix to a green server typecheck",
    },
    { title: "Verify", detail: "full fmt/lint/typecheck + tests + expected-improvement summary" },
  ],
};

const REPO = "/Users/tylersheffield/code/synara";

const RESEARCH = {
  type: "object",
  additionalProperties: false,
  properties: {
    area: { type: "string" },
    feasible: { type: "boolean" },
    summary: { type: "string" },
    apiDetails: { type: "array", items: { type: "string" } },
    recommendedApproach: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
  },
  required: ["area", "feasible", "summary", "recommendedApproach"],
};

const REPORT = {
  type: "object",
  additionalProperties: false,
  properties: {
    slice: { type: "string" },
    status: { type: "string", enum: ["implemented", "partial", "blocked", "skipped"] },
    filesChanged: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    expectedImprovement: { type: "string" },
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
- The codex-on-Daytona path WORKS today (codex runs in a real sandbox and streams into the UI). Do NOT regress it. The Daytona session-logs POLLING transport (HttpDaytonaSandboxClient.ts, SESSION_POLL_INTERVAL = 250ms, line ~72) is the working default and must remain a functional FALLBACK after any change.
- Implementation lives in apps/server/src/executionRuntime/Layers/* and providers/daytona/*. Read the real file before editing.
- Daytona REST: management api https://app.daytona.io/api ; toolbox/process at the PROXY host https://proxy.app.daytona.io (no /api), Bearer DAYTONA_API_KEY. The long-lived codex process runs as an async session command (POST /toolbox/{id}/process/session, then /session/{sid}/exec); output is polled from /session/{sid}/command/{cid}/logs (raw text, full accumulated body today). Stdin via /session/{sid}/command/{cid}/input.
- For LIVE probing of the Daytona API, the key is in the user's zsh: run \`zsh -c 'source ~/.zshrc >/dev/null 2>&1; source ~/.zshenv >/dev/null 2>&1; <cmd using $DAYTONA_API_KEY>'\`. A live codex sandbox may exist; you can also create a throwaway one to probe (destroy it after).
- Keep local/worktree threads byte-for-byte unaffected. Keep the keepalive lease (S7) + session teardown (transport.close -> session.close kills the remote process) working.
- effect-smol: no Effect.catchAll / Schedule.intersect (use Effect.catch). No Math.random/Date.now in a workflow SCRIPT (app code is fine).
- After each slice run \`cd ${REPO}/apps/server && bun run typecheck\` and fix until green. Do NOT run the full fmt/lint trio per slice (Verify does it once). Work on the current branch; do not commit.
- Measure where you can: note the before/after expected latency for each change (poll interval, round-trips removed, bytes re-fetched).`;

phase("Research");
log("Researching Daytona PTY WebSocket + incremental-read feasibility");

const research = (
  await parallel([
    () =>
      agent(
        `${PRINCIPLES}\n\nRESEARCH AREA: Daytona PTY/terminal WebSocket toolbox API — the real-time duplex alternative to logs-polling.\n\nThe descriptor declares \`exec: { pty: true }\` (providers/daytona/descriptor.ts:33) and the client header calls a "websocket toolbox" the later upgrade. Find the EXACT Daytona toolbox API for a real-time duplex PTY/terminal session: the endpoint(s) to create a PTY/terminal session, the WebSocket URL + subprotocol, auth (bearer over WS? query token?), and the message framing for stdin/stdout/resize/exit. Sources: Daytona's public docs (use WebSearch/WebFetch for daytona.io / Daytona toolbox/PTY/terminal API docs and the @daytonaio/sdk or daytona-api SDK), the existing HttpDaytonaSandboxClient.ts session model, and — if needed — LIVE probing of the toolbox with the user's key (list endpoints, try a PTY/terminal create). Determine feasibility of replacing/augmenting the polling transport with a WS duplex that delivers codex JSON-RPC stdout in real time and accepts stdin. Give concrete endpoints + framing + a recommended implementation approach (a new DaytonaPtyTransport that conforms to the same JsonRpcLineTransport seam, with polling kept as fallback) + risks (WS auth, reconnect, line-framing, codex PTY echo).`,
        { label: "research:pty-websocket", phase: "Research", schema: RESEARCH },
      ),
    () =>
      agent(
        `${PRINCIPLES}\n\nRESEARCH AREA: incremental session-log reads + poll tuning (the cheap streaming win).\n\nToday the poll loop GETs /toolbox/{id}/process/session/{sid}/command/{cid}/logs every 250ms and the client re-reads the FULL accumulated body each tick (O(n^2) bytes over a turn). Determine: (1) does the Daytona logs endpoint support an incremental/byte-offset/range read (e.g. a Range header, a ?offset=/?since= query param, or a follow/stream mode)? Confirm by reading the client + the Daytona docs/SDK + LIVE probing the logs endpoint with the key (create a sandbox running a chatty command, then try Range/offset requests and compare). (2) What is a safe lower poll interval (e.g. 100ms) given Daytona rate limits? (3) Is there a streaming/SSE/follow variant of the logs endpoint? Recommend the concrete change to read only the new tail each poll (offset tracking + range request, or the streaming endpoint) and the safe interval. If no incremental support exists, say so and recommend the best alternative.`,
        { label: "research:incremental-reads", phase: "Research", schema: RESEARCH },
      ),
  ])
).filter(Boolean);

const researchJson = JSON.stringify(research);

const SLICES = [
  {
    key: "L1",
    title: "Incremental session-log reads + poll tuning (streaming, O(n^2) -> O(n))",
    spec: `Use the incremental-reads research finding. In HttpDaytonaSandboxClient.ts, change the session-logs poll loop (pollOnce ~line 603, SESSION_POLL_INTERVAL ~line 72) to read only the NEW tail each tick instead of re-fetching the full accumulated body: track a byte offset and request the incremental slice (Range header / ?offset= / streaming-follow per research). If the endpoint truly has no incremental mode, at minimum stop re-processing already-emitted bytes and reduce redundant work, and document the limit. Lower the poll interval to the safe value the research found (~100ms) if it does not risk rate limits. Preserve exact line-framing + echo suppression + exit handling; the transport contract (stdoutLines/exit) must be unchanged.`,
    gaps: "streaming O(n^2) re-fetch + 250ms floor",
  },
  {
    key: "L2",
    title: "Provisioning cold-start: discoverRoot exponential backoff + folded/parallel setup",
    spec: `In DaytonaRuntimeAdapter.ts provision: (1) discoverRoot (~line 180) retries pwd with a flat Effect.sleep("2 seconds") x40 — replace with exponential backoff (e.g. 100ms,200ms,400ms... capped at ~2s) keeping roughly the same total max wait budget, so a sandbox that is ready in ~300ms is detected fast instead of waiting a full 2s. (2) The provision setup is fully serialized: client.create -> discoverRoot -> injectCodexCredentials -> assertCodexPresent. injectCodexCredentials and assertCodexPresent are independent — either run them concurrently (Effect.all) OR fold discoverRoot's final pwd + the auth write + 'codex --version' into a SINGLE setup exec and parse the combined output, cutting ~2 toolbox round-trips. Keep the fail-fast behavior (codex-missing -> actionable error; auth-resolve null-degrades). Do not change WHEN provisioning happens (no eager-provision here — that is a separate product decision).`,
    gaps: "cold-start serial round-trips + flat 2s backoff",
  },
  {
    key: "L4",
    title:
      "Real-time PTY WebSocket transport (gated on research feasibility; polling stays the fallback)",
    spec: `Use the pty-websocket research finding. IF the research confirmed a usable Daytona PTY/terminal WebSocket toolbox API: add a DaytonaPtyTransport that conforms to the same JsonRpcLineTransport seam (send/inbound/stderr/exit/isAlive/close) but delivers codex stdout in REAL TIME over the WS and writes stdin over the WS — eliminating the 250ms poll floor and the re-fetch. Wire the Daytona adapter.createTransport to PREFER the PTY WS transport and FALL BACK to the existing polling session transport on WS failure/unsupported (env or capability flag). Keep echo suppression, the merged-stdout frame-gate parity, exit -> session teardown (kills the remote codex), and the keepalive lease working. Add a focused test (the in-memory/contract harness or a recorded WS). IF the research found the WS API is NOT usable/available: do NOT rewrite the transport — instead apply the research's best alternative (e.g. a logs follow/stream endpoint, or just confirm L1 captured the achievable win) and report it as the outcome, leaving the working polling path intact.`,
    gaps: "streaming 250ms poll floor + handshake round-trips",
  },
];

phase("Build");
log(
  `Implementing ${SLICES.length} latency slices (research feasible: ${research.map((r) => r.area + "=" + r.feasible).join(", ")})`,
);

const results = [];
for (const slice of SLICES) {
  await agent(
    `${PRINCIPLES}\n\nRESEARCH FINDINGS (use these — do not re-research from scratch):\n${researchJson}\n\nSLICE ${slice.key}: ${slice.title}\nTarget: ${slice.gaps}\n\nWHAT TO DO:\n${slice.spec}\n\nImplement this slice on the current branch in ${REPO}. Read the real files first, write the code, add or update a focused unit test, run the server typecheck until green. Preserve the working polling path + local threads. Report what changed and the expected latency improvement.`,
    { label: `impl:${slice.key}`, phase: "Build" },
  );

  const report = await agent(
    `Report slice ${slice.key} ("${slice.title}") by inspecting ${REPO}: \`git -C ${REPO} status --short\`, \`git -C ${REPO} diff --stat\`, and \`cd ${REPO}/apps/server && bun run typecheck\` (record pass/fail). List files changed BY THIS SLICE, summarize the change, the expected latency improvement (interval/round-trips/bytes), and followups. Do not edit.`,
    { label: `report:${slice.key}`, phase: "Build", schema: REPORT },
  );

  const review = await agent(
    `${PRINCIPLES}\n\nAdversarially review slice ${slice.key} ("${slice.title}"). Inspect its diff: \`git -C ${REPO} diff\` on ${(report && report.filesChanged && report.filesChanged.join(", ")) || "the changed files"}. Verify: it actually reduces latency as claimed; it does NOT regress the working codex-on-Daytona streaming path; the polling transport still works as a fallback; line-framing/echo-suppression/exit-teardown/keepalive are intact; local threads unaffected; no effect-smol misuse; correct offset/Range handling (no dropped or duplicated bytes) for L1; correct WS reconnect/close/teardown for L4. Verdict "ship" or "fix" with concrete blocking issues + fixes.`,
    { label: `review:${slice.key}`, phase: "Build", schema: REVIEW },
  );

  if (review && review.verdict === "fix" && review.blocking && review.blocking.length > 0) {
    await agent(
      `${PRINCIPLES}\n\nFix the blocking issues in slice ${slice.key} ("${slice.title}") and re-run the server typecheck until green:\n${JSON.stringify(review.blocking, null, 2)}`,
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
  `Final verification of the codex-on-Daytona latency work in ${REPO}. Run \`cd ${REPO} && bun run typecheck\` (turbo), \`bun run lint\`, and \`bunx oxfmt --check\` on the changed files (then \`bunx oxfmt\` to fix formatting if it fails). Run \`cd ${REPO}/apps/server && bun run test\` for the touched areas (executionRuntime, providers/daytona, codexAppServerManager). Report exact pass/fail counts and any errors with file:line. Then summarize the expected latency improvement per slice (streaming per-token interval before/after, provisioning round-trips/backoff before/after, whether the PTY WebSocket landed or fell back to polling) and confirm the working polling path + local threads are intact. Do not fix logic — only format-fix and verify.`,
  { label: "final-verify", phase: "Verify", schema: REPORT },
);

return { research, slices: results.map((r) => r.slice), results, verify };
