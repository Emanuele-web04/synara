/** Small packaged-app acceptance path. Each measured task owns a fresh thread;
 * state in two controlled AppKit processes supplies the independent oracle. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
  type OrchestrationLatestTurn,
  type ServerConfig,
} from "@synara/contracts";
import { SYNARA_DESKTOP_SMOKE_USER_DATA_ENV } from "@synara/shared/desktopIdentity";
import { Schema, type Effect } from "effect";
import {
  startFocusProbe,
  type FocusProbeExpect,
} from "../../apps/desktop/src/cuaFixtures/focusProbe.ts";
import { artifactIdentity, PackagedAppInstallationError } from "./packaged-artifact.ts";
import {
  collectComputerRun,
  prepareComputerRunDiagnostics,
  type DiagnosticToolCaller,
} from "./measurement.ts";
import {
  connectPackagedOwner,
  waitForSelectedProvider,
  type PackagedOwnerClient,
} from "./packaged-client.ts";
import {
  assessContinuousFocus,
  assessFixtureReportCoverage,
  assertPassiveComputerReady,
  fixtureReceiptTiming,
  fixtureUnchanged,
  resolveFixtureComputerWindow,
  verifyFixtureClick,
  type FixtureReportVerdict,
  type FixtureState,
} from "./packaged-evidence.ts";
import { delay, startNativeTarget, waitUntil } from "./packaged-fixture.ts";

const { values } = parseArgs({
  options: {
    bundle: { type: "string" },
    home: { type: "string" },
    "cdp-port": { type: "string" },
    "native-fixture": { type: "string" },
    "focus-probe": { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    "model-options": { type: "string" },
    runs: { type: "string", default: "2" },
    "turn-timeout-seconds": { type: "string", default: "180" },
    attach: { type: "boolean", default: false },
    "prepare-only": { type: "boolean", default: false },
    "skip-stop": { type: "boolean", default: false },
  },
  strict: true,
});

interface ActiveFixtureRun {
  index: number;
  kind: "click" | "stop";
  threadId: ThreadId;
  runStartedAt: string;
  before: { a: FixtureState; b: FixtureState };
  stage: string;
  failureCode: string | null;
  preparation: Awaited<ReturnType<typeof prepareComputerRunDiagnostics>> | null;
  window: ReturnType<typeof resolveFixtureComputerWindow> | null;
  dispatchStartedMs: number | null;
  stopRequestedMs: number | null;
  latestTurn: OrchestrationLatestTurn | null;
  terminalObservedMs: number | null;
}

let interruptionRequested = false;
process.once("SIGINT", () => {
  interruptionRequested = true;
});
process.once("SIGTERM", () => {
  interruptionRequested = true;
});

function required(name: "bundle" | "home" | "native-fixture" | "focus-probe"): string {
  const value = values[name];
  if (!value) throw new Error(`Required option: --${name}`);
  return resolve(value);
}

function integer(value: string | undefined, min: number, max: number, name: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`Invalid --${name}; expected ${min}..${max}.`);
  return number;
}

async function unusedPort(port: number, host: string) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("Desktop debugging port is already in use.")));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve()));
  });
}

async function main() {
  if (process.platform !== "darwin") throw new Error("This AppKit harness runs on macOS.");
  const prepareOnly = values["prepare-only"];
  const bundle = await realpath(required("bundle"));
  const home = required("home");
  const port = integer(values["cdp-port"], 1024, 65535, "cdp-port");
  const runs = integer(values.runs, 1, 10, "runs");
  const timeoutMs =
    integer(values["turn-timeout-seconds"], 10, 600, "turn-timeout-seconds") * 1_000;
  const acceptanceOptions = prepareOnly
    ? null
    : {
        nativeFixture: await realpath(required("native-fixture")),
        focusBinary: await realpath(required("focus-probe")),
        model: Schema.decodeUnknownSync(ModelSelection)({
          provider: values.provider,
          model: values.model,
          ...(values["model-options"] ? { options: JSON.parse(values["model-options"]) } : {}),
        }),
      };
  const artifact = await artifactIdentity(bundle);
  const markerPath = join(home, "computer-fixture-instance.json");
  const profile = join(home, "electron-profile");
  if (values.attach) {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker.bundle !== bundle || marker.cdpPort !== port)
      throw new Error("Attach requires a matching fixture-created isolated home and desktop.");
  } else {
    await unusedPort(port, "127.0.0.1");
    await unusedPort(port, "::1");
    // Fail if anything exists; never reset or clone the user's live database.
    await mkdir(home, { mode: 0o700 });
    await mkdir(profile, { mode: 0o700 });
    await writeFile(markerPath, JSON.stringify({ bundle, cdpPort: port }), {
      mode: 0o600,
      flag: "wx",
    });
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      SYNARA_HOME: home,
      SYNARA_DESKTOP_FLAVOR: "cua",
      [SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]: profile,
    };
    for (const key of [
      "ELECTRON_RUN_AS_NODE",
      "SYNARA_DESKTOP_WS_URL",
      "SYNARA_AUTH_TOKEN",
      "SYNARA_AGENT_GATEWAY_TOKEN",
      "SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN",
      "SYNARA_SOURCE_DESKTOP_BUILD_MARKER",
    ]) {
      delete environment[key];
    }
    const launch = spawn(
      "/usr/bin/open",
      [
        "-g",
        "-n",
        "-a",
        bundle,
        "--env",
        `SYNARA_HOME=${home}`,
        "--env",
        `${SYNARA_DESKTOP_SMOKE_USER_DATA_ENV}=${profile}`,
        "--env",
        "SYNARA_DESKTOP_FLAVOR=cua",
        "--args",
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
      ],
      { env: environment, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      launch.once("error", () => reject(new Error("Isolated app launch failed.")));
      launch.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Isolated app launch failed.")),
      );
    });
  }
  const runDirectory = join(home, `evidence-${Date.now()}`);
  const workspace = join(runDirectory, "workspace");
  await mkdir(prepareOnly ? runDirectory : workspace, { recursive: true, mode: 0o700 });
  let owner: PackagedOwnerClient | undefined;
  let target: Awaited<ReturnType<typeof startNativeTarget>> | undefined;
  let human: Awaited<ReturnType<typeof startNativeTarget>> | undefined;
  let probe: NonNullable<Awaited<ReturnType<typeof startFocusProbe>>> | undefined;
  let activeThread: ThreadId | undefined;
  let activeRun: ActiveFixtureRun | undefined;
  let diagnostics: DiagnosticToolCaller | undefined;
  let intervalStart = Date.now();
  let intervalEnd = intervalStart;
  const reports: FixtureReportVerdict[] = [];
  let readiness: { computer: string; provider: string } | null = null;
  let verifiedHome: string | null = null;
  let preparationSucceeded = false;
  let focus: ReturnType<typeof assessContinuousFocus> | null = null;
  let phase = "desktop-owner-connection";
  let failure: string | null = null;
  let failureDetail: { stage: string; code: string; threadId: string } | null = null;
  let taskRunsPassed = true;
  let measurementsValid = true;
  let stopPassed = false;
  const cleanup = {
    target: false,
    human: false,
    owner: false,
    controlRevoked: false,
    activeTurnStopped: false,
  };
  let expectedFocus: FocusProbeExpect | undefined;
  const dispatch = async (command: unknown) => {
    if (!owner) throw new Error("Owner connection missing.");
    return owner.run(
      owner.api[ORCHESTRATION_WS_METHODS.dispatchCommand](
        Schema.decodeUnknownSync(ClientOrchestrationCommand)(command),
      ),
    );
  };
  const interrupt = async (threadId: ThreadId) => {
    await dispatch({
      type: "thread.turn.interrupt",
      commandId: randomUUID(),
      threadId,
      createdAt: new Date().toISOString(),
    });
  };
  try {
    owner = await waitUntil(
      async () => {
        try {
          return await connectPackagedOwner(port);
        } catch {
          return null;
        }
      },
      45_000,
      "Isolated desktop owner connection",
    );
    const client = owner;
    phase = "instance-isolation";
    // This response's keybindings declaration widens its decode context to
    // unknown. The generated RPC client owns decoding; no app service is used.
    const config = await client.run(
      client.api[WS_METHODS.serverGetConfig]({}) as Effect.Effect<ServerConfig, unknown>,
    );
    const actualHome = await realpath(dirname(config.worktreesDir));
    if (actualHome !== (await realpath(home)))
      throw new Error("Desktop server does not belong to the supplied isolated home.");
    verifiedHome = actualHome;
    phase = "computer-readiness";
    const status = await client.run(client.api[COMPUTER_WS_METHODS.getStatus]({}));
    readiness = { computer: status.availability.kind, provider: "unchecked" };
    if (prepareOnly) {
      // A new bundle may still need TCC setup. Passive availability never proves
      // those grants; preparation ends before provider discovery or native input.
      preparationSucceeded = !interruptionRequested;
      if (!preparationSucceeded) failure = "preparation-interrupted";
      return;
    }
    if (!acceptanceOptions) throw new Error("Acceptance options are required.");
    const { model, nativeFixture, focusBinary } = acceptanceOptions;
    assertPassiveComputerReady(status);
    phase = "provider-readiness";
    const providerStatus = await waitForSelectedProvider({
      provider: model.provider,
      initial: config.providers,
      read: async () =>
        (
          await client.run(
            client.api[WS_METHODS.serverGetConfig]({}) as Effect.Effect<ServerConfig, unknown>,
          )
        ).providers,
    });
    readiness.provider = providerStatus?.authStatus ?? "unavailable";
    if (!providerStatus?.available || providerStatus.authStatus === "unauthenticated")
      throw new Error("Requested provider is unavailable or unauthenticated.");
    phase = "native-fixture-setup";
    target = await startNativeTarget(nativeFixture);
    human = await startNativeTarget(nativeFixture);
    human.activateHuman();
    await delay(300);
    const humanBaseline = await human.snapshot();
    const targetBaseline = await target.snapshot();
    expectedFocus = {
      pid: humanBaseline.a.pid,
      keyWin: humanBaseline.a.windowId,
      focusedPid: humanBaseline.a.pid,
    };
    phase = "focus-observation-preflight";
    probe =
      (await startFocusProbe({
        binaryPath: focusBinary,
        hz: 50,
        expect: expectedFocus,
        strictFocus: true,
        maxDurationSeconds: (timeoutMs * (runs + 2)) / 1_000 + 60,
      })) ?? undefined;
    if (!probe) throw new Error("Focus sampler is unavailable.");
    const focusProbe = probe;
    await waitUntil(
      () => {
        const recent = focusProbe.samples.slice(-20);
        return recent.length === 20 &&
          recent.every(
            (sample) =>
              sample.pid === humanBaseline.a.pid &&
              sample.keyWin === humanBaseline.a.windowId &&
              sample.focusedPid === humanBaseline.a.pid &&
              sample.space !== null &&
              sample.focused !== null,
          ) &&
          recent.some((sample) => sample.topWin !== null)
          ? true
          : null;
      },
      3_000,
      "Complete focus observation",
    );
    const baseline = focusProbe.samples.findLast((sample) => sample.topWin !== null);
    if (
      !baseline ||
      baseline.space === null ||
      baseline.topWin === null ||
      baseline.focused === null
    )
      throw new Error("Complete focus baseline missing.");
    expectedFocus = {
      ...expectedFocus,
      space: baseline.space,
      topWin: baseline.topWin,
      focused: baseline.focused,
    };
    const projectId = ProjectId.makeUnsafe(randomUUID());
    await dispatch({
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title: "Computer fixture benchmark",
      workspaceRoot: workspace,
      createdAt: new Date().toISOString(),
    });
    diagnostics = (name, args) =>
      client.run(
        client.api[WS_METHODS.serverReadThreadDiagnostics]({
          ...args,
          source: name === "synara_read_thread_events" ? "events" : "runtime",
          threadId: ThreadId.makeUnsafe(String(args.threadId)),
        }),
      );
    intervalStart = Date.now();
    const runTask = async (index: number, stop: boolean) => {
      if (!target || !human) throw new Error("Fixture targets missing.");
      const before = await target.snapshot();
      const startedAt = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe(randomUUID());
      activeThread = threadId;
      const run: ActiveFixtureRun = {
        index,
        kind: stop ? "stop" : "click",
        threadId,
        runStartedAt: startedAt,
        before,
        stage: "thread-create",
        failureCode: null,
        preparation: null,
        window: null,
        dispatchStartedMs: null,
        stopRequestedMs: null,
        latestTurn: null,
        terminalObservedMs: null,
      };
      activeRun = run;
      await dispatch({
        type: "thread.create",
        commandId: randomUUID(),
        threadId,
        projectId,
        title: `Computer fixture ${stop ? "stop" : "click"} ${index}`,
        modelSelection: model,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      });
      run.stage = "diagnostics-preflight";
      run.preparation = await prepareComputerRunDiagnostics(diagnostics!, {
        threadId,
        runStartedAt: startedAt,
      });
      run.stage = "control-enable";
      const control = await client.run(
        client.api[COMPUTER_WS_METHODS.setControlEnabled]({ threadId, enabled: true }),
      );
      run.stage = "fixture-window-binding";
      const listing = await client.run(client.api[COMPUTER_WS_METHODS.listWindows]({}));
      if (listing.availability.kind !== "available")
        throw new Error("Computer window enumeration is unavailable.");
      run.window = resolveFixtureComputerWindow(listing.windows, before.a);
      const count = stop ? 30 : 1;
      const prompt = [
        "Use Synara native Computer Use for this authorized, harmless fixture task.",
        `In app ${JSON.stringify(run.window.appName)}, window ${JSON.stringify(run.window.title)},`,
        `use the exact string windowId ${JSON.stringify(run.window.id)} returned by Computer.`,
        `click the Counter button ${count} time${count === 1 ? "" : "s"} in the background.`,
        stop
          ? "Make separate clicks and read the counter between each click."
          : "Click exactly once, then verify the counter.",
        "Keep the human's current foreground app, key window and Space unchanged.",
        "Touch only this fixture window. Do not use a shell, code execution, AppleScript, or a browser to perform the task.",
        "Do not activate another app or switch Spaces. Stop honestly if native control refuses.",
      ].join(" ");
      run.stage = "turn-dispatch";
      const dispatchStartedMs = performance.now();
      run.dispatchStartedMs = dispatchStartedMs;
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
      let stopRequestedAt: string | null = null;
      let stopRequestedMs: number | null = null;
      run.stage = "provider-task";
      const terminal = await waitUntil<OrchestrationLatestTurn>(
        async () => {
          if (interruptionRequested) {
            run.failureCode = "runner-interrupted";
            throw new Error("Fixture runner was interrupted.");
          }
          const observed = focusProbe.samples.at(-1);
          if (
            !observed ||
            observed.pid !== humanBaseline.a.pid ||
            observed.keyWin !== humanBaseline.a.windowId ||
            observed.focusedPid !== humanBaseline.a.pid ||
            observed.space !== baseline.space ||
            observed.focused !== baseline.focused
          ) {
            run.failureCode = "human-focus-changed-or-unobserved";
            throw new Error("Human focus changed during the fixture task.");
          }
          const snapshot = await client.run(
            client.api[ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot]({ threadId }),
          );
          const thread = snapshot?.thread;
          const turn = thread?.latestTurn;
          run.latestTurn = turn ?? null;
          if (thread?.hasPendingApprovals || thread?.hasPendingUserInput) {
            run.failureCode = "unexpected-approval-or-user-input";
            throw new Error("Fixture task requires user input or repeated approval.");
          }
          if (
            stop &&
            !stopRequestedAt &&
            turn?.state === "running" &&
            target!.current().clicks > before.a.clicks
          ) {
            stopRequestedAt = new Date().toISOString();
            stopRequestedMs = performance.now();
            run.stopRequestedMs = stopRequestedMs;
            await interrupt(threadId);
          }
          return turn && turn.state !== "running" && !thread?.session?.activeTurnId ? turn : null;
        },
        timeoutMs,
        "Provider task completion",
      );
      const terminalObservedMs = performance.now();
      run.latestTurn = terminal;
      run.terminalObservedMs = terminalObservedMs;
      run.stage = "control-revoke";
      const revoked = await client.run(
        client.api[COMPUTER_WS_METHODS.setControlEnabled]({ threadId, enabled: false }),
      );
      if (revoked.enabled) throw new Error("Fixture task control was not revoked.");
      activeThread = undefined;
      run.stage = "outcome-observation";
      const settled = await target.snapshot();
      await delay(700);
      const after = await target.snapshot();
      const humanAfter = await human.snapshot();
      const untouched =
        fixtureUnchanged(before.b, after.b) &&
        fixtureUnchanged(humanBaseline.a, humanAfter.a) &&
        fixtureUnchanged(humanBaseline.b, humanAfter.b);
      const outcome = stop
        ? {
            passed:
              Boolean(stopRequestedAt) &&
              terminal.state === "interrupted" &&
              after.a.clicks > before.a.clicks &&
              after.a.clicks <= before.a.clicks + count &&
              after.a.text === before.a.text &&
              after.a.edits === before.a.edits &&
              fixtureUnchanged(settled.a, after.a) &&
              untouched,
            stopRequestedAt,
            clickDelta: after.a.clicks - before.a.clicks,
            quietAfterTerminalMs: 700,
            unchangedAfterTerminal: fixtureUnchanged(settled.a, after.a),
          }
        : { ...verifyFixtureClick(before.a, after.a), untouched };
      const passed = outcome.passed && untouched && (stop || terminal.state === "completed");
      if (stop) stopPassed = passed;
      else taskRunsPassed &&= passed;
      let measurement: Awaited<ReturnType<typeof collectComputerRun>> | null = null;
      let measurementFailure: string | null = null;
      try {
        measurement = await collectComputerRun(diagnostics!, {
          threadId,
          turnId: terminal.turnId,
          runStartedAt: startedAt,
        });
      } catch {
        measurementFailure = "diagnostics-collection-failed";
        if (!stop) measurementsValid = false;
      }
      // An intentional interruption is not a completed-task benchmark. Keep
      // its diagnostic verdict intact without folding it into completed runs.
      if (!stop && !measurement?.valid) measurementsValid = false;
      const report = {
        index,
        kind: run.kind,
        threadId,
        turnId: terminal.turnId,
        terminalState: terminal.state,
        taskPassed: passed,
        outcome,
        diagnosticsPreparation: run.preparation,
        target: { windowId: run.window.id, pid: run.window.pid, appName: run.window.appName },
        measurement,
        measurementFailure,
        benchmarkEligible: !stop,
        receiptTiming: fixtureReceiptTiming({
          dispatchStartedMs,
          beforeClicks: before.a.clicks,
          changes: target.counterChanges,
          lastObservedMs: target.lastCounterObservation(),
          stopRequestedMs,
          terminalObservedMs,
        }),
      };
      await writeFile(join(runDirectory, `task-${index}.json`), JSON.stringify(report, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      reports.push(report);
      activeRun = undefined;
      console.info(
        `Task ${index}: ${passed ? "passed" : "failed"}; measurement ${measurement?.valid ? "valid" : "invalid"}`,
      );
      if (!passed) throw new Error("Independent fixture task proof failed.");
    };
    for (let index = 1; index <= runs; index++) {
      phase = `task-${index}`;
      await runTask(index, false);
    }
    if (!values["skip-stop"]) {
      phase = "stop";
      await runTask(runs + 1, true);
      phase = "recovery";
      await runTask(runs + 2, false);
    }
    phase = "final-fixture-proof";
    const targetAfter = await target.snapshot();
    if (!fixtureUnchanged(targetBaseline.b, targetAfter.b)) taskRunsPassed = false;
  } catch {
    // Do not serialize arbitrary RPC exceptions, URLs or provider payloads.
    failure = phase;
    if (activeRun) {
      activeRun.failureCode ??= `${activeRun.stage}-failed`;
      failureDetail = {
        stage: activeRun.stage,
        code: activeRun.failureCode,
        threadId: activeRun.threadId,
      };
    }
  } finally {
    if (activeThread && owner) {
      await owner
        .run(
          owner.api[COMPUTER_WS_METHODS.setControlEnabled]({
            threadId: activeThread,
            enabled: false,
          }),
        )
        .then((result) => {
          cleanup.controlRevoked = !result.enabled;
        })
        .catch(() => undefined);
      if (activeRun?.dispatchStartedMs === null) {
        cleanup.activeTurnStopped = true;
      } else {
        await interrupt(activeThread).catch(() => undefined);
        const threadId = activeThread;
        await waitUntil(
          async () => {
            const snapshot = await owner!.run(
              owner!.api[ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot]({ threadId }),
            );
            const thread = snapshot?.thread;
            if (activeRun && thread?.latestTurn) activeRun.latestTurn = thread.latestTurn;
            const terminal =
              thread?.latestTurn &&
              thread.latestTurn.state !== "running" &&
              !thread.session?.activeTurnId &&
              thread.session?.status !== "starting" &&
              thread.session?.status !== "running";
            if (terminal && activeRun) activeRun.terminalObservedMs = performance.now();
            return terminal ? true : null;
          },
          15_000,
          "Fixture cleanup cancellation",
        )
          .then(() => {
            cleanup.activeTurnStopped = true;
          })
          .catch(() => undefined);
      }
    } else {
      cleanup.activeTurnStopped = true;
      cleanup.controlRevoked = true;
    }
    if (activeRun) {
      const run = activeRun;
      let measurement: Awaited<ReturnType<typeof collectComputerRun>> | null = null;
      let measurementFailure = "turn-not-observed";
      if (diagnostics && run.latestTurn) {
        measurement = await collectComputerRun(diagnostics, {
          threadId: run.threadId,
          turnId: run.latestTurn.turnId,
          runStartedAt: run.runStartedAt,
        }).catch(() => null);
        measurementFailure = measurement ? "" : "diagnostics-collection-failed";
      }
      const after = await target?.snapshot().catch(() => null);
      const report = {
        index: run.index,
        kind: run.kind,
        threadId: run.threadId,
        turnId: run.latestTurn?.turnId ?? null,
        terminalState: run.latestTurn?.state ?? null,
        taskPassed: false,
        failure: failureDetail,
        dispatchAttempted: run.dispatchStartedMs !== null,
        diagnosticsPreparation: run.preparation,
        target: run.window
          ? { windowId: run.window.id, pid: run.window.pid, appName: run.window.appName }
          : null,
        measurement,
        measurementFailure: measurementFailure || null,
        outcome: {
          passed: false,
          status: "unverified-after-early-failure",
          counterDelta: after ? after.a.clicks - run.before.a.clicks : null,
          textUnchanged: after ? after.a.text === run.before.a.text : null,
          editsUnchanged: after ? after.a.edits === run.before.a.edits : null,
          otherTargetWindowUnchanged: after ? fixtureUnchanged(run.before.b, after.b) : null,
        },
        receiptTiming:
          target && run.dispatchStartedMs !== null
            ? fixtureReceiptTiming({
                dispatchStartedMs: run.dispatchStartedMs,
                beforeClicks: run.before.a.clicks,
                changes: target.counterChanges,
                lastObservedMs: target.lastCounterObservation(),
                stopRequestedMs: run.stopRequestedMs,
                terminalObservedMs: run.terminalObservedMs ?? NaN,
              })
            : null,
      };
      await writeFile(
        join(runDirectory, `task-${run.index}.json`),
        JSON.stringify(report, null, 2),
        { mode: 0o600, flag: "wx" },
      )
        .then(() => reports.push(report))
        .catch(() => {
          failure = "failure-report-save-failed";
        });
    }
    intervalEnd = Date.now();
    await delay(100);
    if (probe && expectedFocus) {
      const result = await probe.finish();
      focus = assessContinuousFocus(result, expectedFocus, {
        startEpochMs: intervalStart,
        endEpochMs: intervalEnd,
      });
    }
    if (target) cleanup.target = await target.close().catch(() => false);
    if (human) cleanup.human = await human.close().catch(() => false);
    if (owner) {
      await owner
        .close()
        .then(() => {
          cleanup.owner = true;
        })
        .catch(() => undefined);
    }
    if (prepareOnly) {
      const prepared = preparationSucceeded && cleanup.owner;
      await writeFile(
        join(runDirectory, "summary.json"),
        JSON.stringify(
          {
            mode: "permission-preparation",
            prepared,
            passed: false,
            acceptance: "not-run",
            nativePermissions: "not-verified",
            failure: failure ?? (cleanup.owner ? null : "owner-cleanup"),
            artifact,
            home: verifiedHome,
            cdpPort: port,
            serverPort: owner?.serverPort ?? null,
            readiness,
            providerTasksStarted: 0,
            fixtureProcessesStarted: 0,
            reports: 0,
            cleanup: { owner: cleanup.owner },
          },
          null,
          2,
        ),
        { mode: 0o600, flag: "wx" },
      );
      console.info(
        `${prepared ? "Prepared for permission setup" : "Permission preparation incomplete"}; acceptance not run: ${runDirectory}`,
      );
      console.info(
        "The isolated Synara Cua app remains open. Grant its permissions, then rerun with --attach and the acceptance options.",
      );
      if (!prepared) process.exitCode = 2;
    }
  }
  if (prepareOnly) return;
  const reportCoverage = assessFixtureReportCoverage(reports, runs + (values["skip-stop"] ? 0 : 1));
  taskRunsPassed &&= reportCoverage.taskRunsPassed;
  measurementsValid &&= reportCoverage.measurementsValid;
  const accepted =
    !failure &&
    taskRunsPassed &&
    measurementsValid &&
    stopPassed &&
    focus?.passed === true &&
    Object.values(cleanup).every(Boolean);
  const summary = {
    passed: accepted,
    scope: "macos-controlled-background-click-stop-and-recovery",
    failure,
    failureDetail,
    artifact,
    readiness,
    provider: acceptanceOptions?.model.provider,
    model: acceptanceOptions?.model.model,
    serverPort: owner?.serverPort ?? null,
    cdpPort: port,
    taskRunsPassed,
    measurementsValid,
    reportCoverage,
    stop:
      values["skip-stop"] || !reports.some((report) => report.kind === "stop")
        ? "unverified"
        : stopPassed
          ? "passed"
          : "failed",
    recovery: !values["skip-stop"] && reports.length === runs + 2 ? "attempted" : "unverified",
    focus,
    cleanup,
    unverified: [
      "physical-Escape",
      "Dock-and-window-flashes",
      "sustained-CPU-and-RAM",
      "other-providers",
      "other-platforms",
    ],
    reports: reports.length,
  };
  await writeFile(join(runDirectory, "summary.json"), JSON.stringify(summary, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  console.info(
    `${accepted ? "Fixture subset passed" : "Fixture subset incomplete"}: ${runDirectory}`,
  );
  console.info(
    cleanup.target && cleanup.human
      ? "Fixture targets closed; the isolated Synara Cua app is left open for inspection."
      : "Native fixture cleanup is incomplete; inspect summary.json before another run.",
  );
  if (!accepted) process.exitCode = 2;
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof PackagedAppInstallationError
      ? error.message
      : "Packaged fixture setup failed. Check explicit paths, bundle revision, unused port and a new isolated home.",
  );
  process.exitCode = 1;
});
