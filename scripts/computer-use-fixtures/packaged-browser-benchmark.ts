/** Bounded, explicitly comparable browser tasks in an already running
 * isolated package. Observation never navigates or performs the model's task. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ClientOrchestrationCommand,
  COMPUTER_WS_METHODS,
  ModelSelection,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type ComputerAuditHistoryEntry,
  type OrchestrationLatestTurn,
  type ServerConfig,
} from "@synara/contracts";
import { Schema, type Effect } from "effect";
import {
  startFocusProbe,
  type FocusProbeExpect,
} from "../../apps/desktop/src/cuaFixtures/focusProbe.ts";
import { artifactIdentity, PackagedAppInstallationError } from "./packaged-artifact.ts";
import {
  connectPackagedOwner,
  waitForSelectedProvider,
  type PackagedOwnerClient,
} from "./packaged-client.ts";
import { assessContinuousFocus, assertPassiveComputerReady } from "./packaged-evidence.ts";
import { delay, waitUntil } from "./packaged-fixture.ts";
import {
  collectComputerRun,
  prepareComputerRunDiagnostics,
  type DiagnosticToolCaller,
} from "./measurement.ts";
import {
  assessGitHubCompletion,
  assessNeweggCompletion,
  assessBrowserBenchmarkRuns,
  BROWSER_BENCHMARK_BUDGET_MS,
  browserBenchmarkPrompt,
  parseBrowserBenchmarkRunCount,
  type BrowserBenchmarkTask,
} from "./browser-benchmark-evidence.ts";
import { createBrowserObserver, readGitHubReference } from "./browser-benchmark-observer.ts";

const { values } = parseArgs({
  strict: true,
  options: {
    task: { type: "string" },
    runs: { type: "string" },
    repo: { type: "string" },
    bundle: { type: "string" },
    home: { type: "string" },
    "cdp-port": { type: "string" },
    "focus-probe": { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    "model-options": { type: "string" },
    "observer-dir": { type: "string" },
    "profile-root": { type: "string" },
  },
});
const requestedRuns = parseBrowserBenchmarkRunCount(values.runs);
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
});
process.once("SIGTERM", () => {
  interrupted = true;
});
const required = (name: "bundle" | "home" | "focus-probe" | "observer-dir" | "profile-root") => {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return resolve(value);
};
const save = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });

async function mutationAudit(
  client: PackagedOwnerClient,
  threadId: ThreadId,
  turnId: string,
  since: number,
) {
  const entries: ComputerAuditHistoryEntry[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  let truncated = false;
  for (let page = 0; page < 20; page++) {
    const result = await client.run(
      client.api[COMPUTER_WS_METHODS.getAuditHistory]({
        limit: 100,
        ...(before ? { before } : {}),
      }),
    );
    if (result.status !== "available")
      return { coverage: "unverified", reason: result.status, entries };
    truncated ||= result.truncated;
    for (const entry of result.entries) {
      if (entry.threadId === threadId && entry.turnId === turnId && !seen.has(entry.id)) {
        entries.push(entry);
        seen.add(entry.id);
      }
    }
    if (!result.nextCursor || result.entries.some((entry) => Date.parse(entry.ts) < since))
      return {
        coverage: truncated ? "unverified" : "complete-retained-window",
        reason: truncated ? "truncated" : null,
        entries,
      };
    if (result.nextCursor === before) break;
    before = result.nextCursor;
  }
  return { coverage: "unverified", reason: "pagination-bound", entries };
}

async function main() {
  const task = values.task as BrowserBenchmarkTask;
  if (!Object.hasOwn(BROWSER_BENCHMARK_BUDGET_MS, task)) throw new Error("Unknown benchmark task");
  if (task === "github-running") {
    console.info(
      JSON.stringify({
        task,
        requestedRuns,
        status: "unsupported",
        reason: "current-user-Dia-profile-attachment-unsupported",
        substituteRun: false,
      }),
    );
    process.exitCode = 2;
    return;
  }
  if (process.platform !== "darwin")
    throw new Error("This packaged focus benchmark requires macOS");
  const home = await realpath(required("home"));
  const bundle = await realpath(required("bundle"));
  const focusBinary = await realpath(required("focus-probe"));
  const observerDirectory = required("observer-dir");
  const profileRoot = required("profile-root");
  const port = Number(values["cdp-port"]);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid --cdp-port");
  const model = Schema.decodeUnknownSync(ModelSelection)({
    provider: values.provider,
    model: values.model,
    ...(values["model-options"] ? { options: JSON.parse(values["model-options"]) } : {}),
  });
  const artifact = await artifactIdentity(bundle);
  const marker = JSON.parse(await readFile(join(home, "computer-fixture-instance.json"), "utf8"));
  if (marker.bundle !== bundle || marker.cdpPort !== port)
    throw new Error("Isolated instance marker mismatch");
  const runDirectory = join(home, `browser-evidence-${Date.now()}`);
  const workspace = join(runDirectory, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(observerDirectory, { recursive: true, mode: 0o700 });
  const reports: unknown[] = [];
  let client: PackagedOwnerClient | undefined;
  let activeThread: ThreadId | undefined;
  let phase = "owner-connection";
  let failure: string | null = null;
  let cleanupProven = true;
  let accepted = true;
  const dispatch = (command: unknown) => {
    if (!client) throw new Error("Owner not connected");
    return client.run(
      client.api[ORCHESTRATION_WS_METHODS.dispatchCommand](
        Schema.decodeUnknownSync(ClientOrchestrationCommand)(command),
      ),
    );
  };
  const stop = async (threadId: ThreadId, dispatched = true) => {
    if (!client) return false;
    const revoked = await client
      .run(client.api[COMPUTER_WS_METHODS.setControlEnabled]({ threadId, enabled: false }))
      .then((value) => !value.enabled)
      .catch(() => false);
    if (dispatched) {
      await dispatch({
        type: "thread.turn.interrupt",
        commandId: randomUUID(),
        threadId,
        createdAt: new Date().toISOString(),
      }).catch(() => undefined);
    } else if (revoked && activeThread === threadId) {
      activeThread = undefined;
    }
    return revoked;
  };
  try {
    client = await connectPackagedOwner(port);
    const owner = client;
    const config = await owner.run(
      owner.api[WS_METHODS.serverGetConfig]({}) as Effect.Effect<ServerConfig, unknown>,
    );
    if ((await realpath(dirname(config.worktreesDir))) !== home)
      throw new Error("Isolated server home mismatch");
    phase = "provider-and-computer-readiness";
    const status = await owner.run(owner.api[COMPUTER_WS_METHODS.getStatus]({}));
    assertPassiveComputerReady(status);
    const provider = await waitForSelectedProvider({
      provider: model.provider,
      initial: config.providers,
      read: async () =>
        (
          await owner.run(
            owner.api[WS_METHODS.serverGetConfig]({}) as Effect.Effect<ServerConfig, unknown>,
          )
        ).providers,
    });
    if (!provider?.available || provider.authStatus === "unauthenticated")
      throw new Error("Requested provider or Computer is unavailable");
    const projectId = ProjectId.makeUnsafe(randomUUID());
    await dispatch({
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title: "Isolated browser benchmark",
      workspaceRoot: workspace,
      createdAt: new Date().toISOString(),
    });
    const diagnostics: DiagnosticToolCaller = (name, args) =>
      owner.run(
        owner.api[WS_METHODS.serverReadThreadDiagnostics]({
          ...args,
          source: name === "synara_read_thread_events" ? "events" : "runtime",
          threadId: ThreadId.makeUnsafe(String(args.threadId)),
        }),
      );
    for (let index = 1; index <= requestedRuns; index++) {
      if (interrupted) break;
      phase = `browser-task-${index}`;
      const threadId = ThreadId.makeUnsafe(randomUUID());
      const profileName = `synara-bench-${randomUUID()}`;
      const prompt = browserBenchmarkPrompt(task, profileName, values.repo);
      const referenceBefore =
        task === "github-isolated" ? await readGitHubReference(values.repo!) : null;
      const startedAtMs = Date.now();
      const runStartedAt = new Date(startedAtMs).toISOString();
      const descriptorPath = join(observerDirectory, `observer-${profileName}.json`);
      await save(join(observerDirectory, `request-${profileName}.json`), {
        index,
        threadId,
        profileName,
        profileRoot,
        descriptorPath,
        runStartedAt,
      });
      console.info(`Run ${index}: observer descriptor ${descriptorPath}`);
      const observer = createBrowserObserver({
        descriptorPath,
        profileRoot,
        profileName,
        startedAtMs,
        task,
        ...(values.repo ? { repo: values.repo } : {}),
      });
      const probe = await startFocusProbe({
        binaryPath: focusBinary,
        hz: 50,
        strictFocus: true,
        maxDurationSeconds: BROWSER_BENCHMARK_BUDGET_MS[task] / 1000 + 90,
      });
      if (!probe) throw new Error("Focus probe missing");
      let expected: FocusProbeExpect | undefined;
      let terminal: OrchestrationLatestTurn | null = null;
      let finalText = "";
      let dispatchAt = 0;
      let terminalAt: number | null = null;
      let firstWitnessAt: number | null = null;
      let finalObservationStartedAtMs = 0;
      let finalOutcomeReceiptMs: number | null = null;
      let intervalStart = Date.now();
      let intervalEnd = intervalStart;
      let stopReason: string | null = null;
      let stopRequestedAt: number | null = null;
      let stopPromise: Promise<boolean> | undefined;
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      let focusGuardTimer: ReturnType<typeof setInterval> | undefined;
      const requestStop = (reason: string) => {
        if (!stopPromise) {
          stopReason = reason;
          stopRequestedAt = performance.now();
          stopPromise = stop(threadId, dispatchAt > 0);
        }
        return stopPromise;
      };
      let runFailure: string | null = null;
      let diagnosticsPreparation: Awaited<ReturnType<typeof prepareComputerRunDiagnostics>> | null =
        null;
      try {
        await waitUntil(
          () => {
            const samples = probe.samples.slice(-20);
            const last = samples.at(-1);
            const fields = ["pid", "keyWin", "space", "focusedPid", "focused"] as const;
            return samples.length === 20 &&
              last &&
              fields.every(
                (key) => last[key] !== null && samples.every((sample) => sample[key] === last[key]),
              ) &&
              samples.some((sample) => sample.topWin !== null)
              ? true
              : null;
          },
          3000,
          "Stable focus baseline",
        );
        const baseline = probe.samples.findLast((sample) => sample.topWin !== null)!;
        expected = {
          pid: baseline.pid!,
          keyWin: baseline.keyWin!,
          topWin: baseline.topWin!,
          space: baseline.space!,
          focusedPid: baseline.focusedPid!,
          focused: baseline.focused!,
        };
        await dispatch({
          type: "thread.create",
          commandId: randomUUID(),
          threadId,
          projectId,
          title: `${task} benchmark ${index}`,
          modelSelection: model,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        });
        activeThread = threadId;
        diagnosticsPreparation = await prepareComputerRunDiagnostics(diagnostics, {
          threadId,
          runStartedAt,
        });
        const control = await owner.run(
          owner.api[COMPUTER_WS_METHODS.setControlEnabled]({ threadId, enabled: true }),
        );
        intervalStart = Date.now();
        dispatchAt = performance.now();
        budgetTimer = setTimeout(() => {
          void requestStop("turn-budget-exceeded");
        }, BROWSER_BENCHMARK_BUDGET_MS[task]);
        let checkedSamples = probe.samples.length;
        let lastSampleReceiptAt = performance.now();
        focusGuardTimer = setInterval(() => {
          if (interrupted) void requestStop("runner-interrupted");
          const fresh = probe.samples.slice(checkedSamples);
          checkedSamples = probe.samples.length;
          if (fresh.length) lastSampleReceiptAt = performance.now();
          if (
            performance.now() - lastSampleReceiptAt > 500 ||
            fresh.some((sample) =>
              Object.entries(expected!).some(
                ([key, value]) =>
                  sample[key as keyof typeof sample] !== value &&
                  (key !== "topWin" || sample.topWin !== null),
              ),
            )
          )
            void requestStop("human-focus-changed-or-unobserved");
        }, 100);
        await dispatch({
          type: "thread.turn.start",
          commandId: randomUUID(),
          threadId,
          message: { messageId: randomUUID(), role: "user", text: prompt, attachments: [] },
          runtimeMode: "full-access",
          interactionMode: "default",
          enableComputerControl: true,
          computerControlMode: "chat",
          ...(control.generation !== undefined
            ? { computerControlGeneration: control.generation }
            : {}),
          createdAt: new Date().toISOString(),
        });
        while (performance.now() - dispatchAt < BROWSER_BENCHMARK_BUDGET_MS[task] + 45_000) {
          if (interrupted) void requestStop("runner-interrupted");
          if (!stopReason) await observer.capture();
          if (observer.witnesses.length && firstWitnessAt === null)
            firstWitnessAt = performance.now();
          if (observer.witnesses.some((witness) => witness.checkoutVisible))
            void requestStop("checkout-boundary-observed");
          const snapshot = await owner.run(
            owner.api[ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot]({ threadId }),
          );
          const thread = snapshot?.thread;
          if (thread?.hasPendingApprovals || thread?.hasPendingUserInput)
            void requestStop("unexpected-approval-or-user-input");
          if (
            thread?.latestTurn &&
            thread.latestTurn.state !== "running" &&
            !thread.session?.activeTurnId &&
            thread.session?.status !== "starting" &&
            thread.session?.status !== "running"
          ) {
            terminal = thread.latestTurn;
            terminalAt = performance.now();
            finalText =
              thread.messages.find(
                (message) =>
                  message.id === terminal?.assistantMessageId &&
                  message.role === "assistant" &&
                  message.turnId === terminal?.turnId,
              )?.text ?? "";
            break;
          }
          await delay(250);
        }
        if (!terminal) {
          runFailure = "terminal-not-observed";
          await requestStop(runFailure);
        }
      } catch {
        runFailure = diagnosticsPreparation
          ? "task-or-observation-failed"
          : "setup-or-diagnostics-preflight-failed";
        if (activeThread) await requestStop(runFailure);
      } finally {
        if (budgetTimer) clearTimeout(budgetTimer);
        if (focusGuardTimer) clearInterval(focusGuardTimer);
        if (stopPromise) cleanupProven = (await stopPromise) && cleanupProven;
        if (!terminal && activeThread && dispatchAt > 0) {
          terminal = await waitUntil(
            async () => {
              const snapshot = await owner.run(
                owner.api[ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot]({ threadId }),
              );
              const thread = snapshot?.thread;
              return thread?.latestTurn &&
                thread.latestTurn.state !== "running" &&
                !thread.session?.activeTurnId &&
                thread.session?.status !== "starting" &&
                thread.session?.status !== "running"
                ? thread.latestTurn
                : null;
            },
            15_000,
            "Failed browser task terminal evidence",
          ).catch(() => null);
          if (terminal) terminalAt = performance.now();
          else cleanupProven = false;
        }
        if (terminal) {
          if (task === "newegg" && terminal.state === "completed" && !stopReason) {
            // The owner snapshot already proves the provider turn is idle.
            // Observe before revocation can close the owned browser binding.
            finalObservationStartedAtMs = Date.now();
            await observer.capture();
            await delay(250);
            await observer.capture();
            finalOutcomeReceiptMs = performance.now();
          }
          const revoked = await owner
            .run(owner.api[COMPUTER_WS_METHODS.setControlEnabled]({ threadId, enabled: false }))
            .then((value) => !value.enabled)
            .catch(() => false);
          cleanupProven &&= revoked;
          if (revoked) activeThread = undefined;
        }
        intervalEnd = Date.now();
        observer.close();
      }
      const focus = expected
        ? assessContinuousFocus(await probe.finish(), expected, {
            startEpochMs: intervalStart,
            endEpochMs: intervalEnd,
          })
        : null;
      if (!expected) await probe.finish();
      const referenceAfter =
        task === "github-isolated" ? await readGitHubReference(values.repo!) : null;
      const outcome =
        task === "github-isolated"
          ? assessGitHubCompletion({
              before: referenceBefore,
              after: referenceAfter,
              witnesses: observer.witnesses,
              finalText,
            })
          : assessNeweggCompletion({
              evidence: observer.neweggEvidence,
              finalObservationStartedAtMs: finalObservationStartedAtMs || Number.POSITIVE_INFINITY,
            });
      let audit: Awaited<ReturnType<typeof mutationAudit>> | null = null;
      let measurement: Awaited<ReturnType<typeof collectComputerRun>> | null = null;
      if (terminal) {
        audit = await mutationAudit(owner, threadId, terminal.turnId, startedAtMs).catch(
          () => null,
        );
        measurement = await collectComputerRun(diagnostics, {
          threadId,
          turnId: terminal.turnId,
          runStartedAt,
          ...(audit ? { auditEntries: audit.entries } : {}),
        }).catch(() => null);
      }
      const passed =
        !runFailure &&
        !stopReason &&
        terminal?.state === "completed" &&
        measurement?.valid === true &&
        audit?.coverage === "complete-retained-window" &&
        focus?.passed === true &&
        outcome.status === "verified";
      accepted &&= passed;
      const report = {
        index,
        requestedRuns,
        task,
        threadId,
        turnId: terminal?.turnId ?? null,
        comparison: "explicit-isolated-Chrome-comparable-not-existing-Dia-profile",
        budgetMs: BROWSER_BENCHMARK_BUDGET_MS[task],
        passed,
        runFailure,
        terminalState: terminal?.state ?? null,
        stopReason,
        outcome,
        timing: {
          basis: "monotonic-runner-receipt-includes-polling",
          dispatchToTerminalObservationMs: terminalAt === null ? null : terminalAt - dispatchAt,
          dispatchToFirstIndependentPageObservationMs:
            firstWitnessAt === null ? null : firstWitnessAt - dispatchAt,
          stopRequestToTerminalObservationMs:
            stopRequestedAt === null || terminalAt === null ? null : terminalAt - stopRequestedAt,
          firstNativeClickMs: null,
          dispatchToFinalIndependentOutcomeReceiptMs:
            finalOutcomeReceiptMs === null ? null : finalOutcomeReceiptMs - dispatchAt,
        },
        measurement,
        diagnosticsPreparation,
        mutationAuditCoverage: audit ? { coverage: audit.coverage, reason: audit.reason } : null,
        observer: observer.report(),
        focus,
        unverified: [
          "read-only-tool-refusals",
          "physical-Escape-count",
          "exact-input-delivery-timestamps",
          "Dock-or-window-flashes",
          "sustained-CPU-and-RAM",
        ],
      };
      reports.push({ index, passed, terminalState: terminal?.state ?? null, outcome });
      await save(join(runDirectory, `run-${index}.json`), report);
      console.info(
        `Run ${index}: ${passed ? "verified" : "incomplete"}; task ${outcome.status}; metrics ${measurement?.valid ? "valid" : "invalid"}`,
      );
      if (!terminal || !cleanupProven || interrupted || !focus?.passed) break;
    }
  } catch {
    failure = phase;
    accepted = false;
  } finally {
    if (activeThread) {
      await stop(activeThread);
      cleanupProven = false;
    }
    if (client)
      await client.close().catch(() => {
        cleanupProven = false;
      });
  }
  const runSummary = assessBrowserBenchmarkRuns({
    requestedRuns,
    completedRuns: reports.length,
    accepted,
    cleanupProven,
  });
  const { passed } = runSummary;
  await save(join(runDirectory, "summary.json"), {
    ...runSummary,
    task,
    failure,
    artifact,
    provider: model.provider,
    model: model.model,
    originalRunningBrowserTask: "unsupported",
    cleanupProven,
    cleanupScope: "Computer-control-revoked-and-provider-turn-terminal",
    browserProcessCleanup: "unverified; driver-owned isolated browser may remain open",
    reports,
    scope:
      requestedRuns === 1
        ? "single-isolated-Chrome-smoke-with-owner-metrics-and-continuous-focus"
        : "two-isolated-Chrome-tasks-with-owner-metrics-and-continuous-focus",
    observerReadOnly: true,
  });
  console.info(
    `${requestedRuns === 1 ? "Smoke" : "Benchmark"} ${passed ? "verified" : "incomplete"}: ${runDirectory}`,
  );
  if (!passed) process.exitCode = 2;
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof PackagedAppInstallationError
      ? error.message
      : "Browser benchmark setup failed. Verify explicit isolated paths, package identity, provider/model and task options.",
  );
  process.exitCode = 1;
});
