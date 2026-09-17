/**
 * Belief canary main-process entry. It is the probe sibling of the desktop
 * fixture runner (apps/desktop/src/cuaFixtures/electron.ts): same driver host
 * and backend mechanics, different flow. A belief-probe helper posts one
 * candidate focus-belief phase, then the backend types a unique string into a
 * background target window of this same process. Each phase records an
 * Electron readback and an AX readback; the first phase whose exact text lands
 * ends the ladder. The only artifact is report.json under
 * SYNARA_CUA_CANARY_DIR; the app prints nothing user-facing.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import type { ComputerUiNode, ComputerUiPoint } from "@synara/contracts";
import { cuaRequest, type CuaReply } from "@synara/shared/cuaDriverProtocol";
import { CuaDriverHost } from "../../apps/desktop/src/cuaDriverHost";
import { CuaComputerBackend } from "../../apps/server/src/computer/CuaComputerBackend";

// Electron adds resourcesPath to the main process; the Node type does not.
const resourcesPath = (process as unknown as { resourcesPath: string }).resourcesPath;
const directory = process.env.SYNARA_CUA_CANARY_DIR ?? "";
const directoryValid = directory.startsWith("/private/tmp/synara-cua-implementation/");
if (directoryValid) app.setPath("userData", join(directory, "electron-profile"));
app.setName("Synara Cua Canary");
// Closing the last window is never the end of a canary run; keep the app alive
// until the report has been written.
app.on("window-all-closed", () => undefined);

const nonce = `Synara Cua Canary ${process.pid}`;
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const findNode = (root: ComputerUiNode | undefined, label: string): ComputerUiNode | undefined => {
  if (root?.role === "AXTextField" && root.label === label) return root;
  for (const child of root?.children ?? []) {
    const found = findNode(child, label);
    if (found) return found;
  }
  return undefined;
};
const countNodes = (root: ComputerUiNode | undefined): number =>
  root === undefined ? 0 : 1 + root.children.reduce((total, child) => total + countNodes(child), 0);

interface HelperRecord {
  exitCode: number | null;
  report: unknown;
}

interface PhaseRecord {
  phase: string;
  stage: number | null;
  typed: string;
  electronReadback: string | null;
  axReadback: string | null;
  helper: HelperRecord | null;
  typeResult: unknown;
  sentinelFocusedBefore: boolean;
  focusAfterType: number | null;
  readbackError: string | null;
  clickResult: unknown;
  axElementCount: number | null;
  axTreeError: string | null;
}

/** One exact AX field resolution, shaped like the desktop fixture's resolved
 * semantic target. The backend consumes this object to run the accessibility
 * rung instead of refusing process-scoped synthetic keys. */
interface ResolvedCanaryTarget {
  target: { windowId: string; label: string };
  node: ComputerUiNode;
  point: ComputerUiPoint;
}

const report: Record<string, unknown> = {
  probe: "belief-canary",
  nonce,
  pid: process.pid,
  directory,
  runtime: process.versions,
  phases: [],
  nativeActions: [],
  windows: null,
  nativeBuild: null,
  nativePermissions: null,
  summary: null,
};
const phaseRecords = report.phases as PhaseRecord[];
let host: CuaDriverHost | undefined;
let backend: CuaComputerBackend | undefined;

/** One helper run per phase. Its own JSON report is the record of what it
 * posted; a missing or unreadable report is preserved as `{ error }` so the
 * phase record never invents a result. */
const runHelper = (stage: number, nativeWindowId: number): Promise<HelperRecord> =>
  new Promise((resolve) => {
    const helperReportPath = join(directory, `helper-stage-${stage}.json`);
    const child = spawn(
      join(resourcesPath, "belief-probe"),
      [
        "--pid",
        String(process.pid),
        "--window",
        String(nativeWindowId),
        "--stage",
        String(stage),
        "--report",
        helperReportPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString("utf8");
    });
    let settled = false;
    const finish = async (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      try {
        const parsed: unknown = JSON.parse(await readFile(helperReportPath, "utf8"));
        resolve({ exitCode, report: parsed });
      } catch (error) {
        const detail = [String(error), spawnError, stderr.trim()].filter(Boolean).join("; ");
        resolve({ exitCode, report: { error: detail } });
      }
    };
    child.once("error", (error) => void finish(null, String(error)));
    child.once("exit", (code) => void finish(code));
  });

async function main(): Promise<void> {
  if (!directoryValid)
    throw new Error(
      "SYNARA_CUA_CANARY_DIR must be set to a directory under /private/tmp/synara-cua-implementation/.",
    );
  await mkdir(directory, { recursive: true });
  await app.whenReady();

  // show:false + showInactive(): under an `open -g` launch, `show: true` calls
  // orderFront, which a never-activated app defers — the window reads
  // isVisible() in-process but never enters WindowServer's on-screen list.
  // showInactive() uses orderFrontRegardless, which registers the window with
  // WindowServer immediately without activating the app.
  const sentinel = new BrowserWindow({
    title: `${nonce} Canary Sentinel`,
    width: 400,
    height: 200,
    x: 80,
    y: 80,
    show: false,
  });
  sentinel.once("ready-to-show", () => sentinel.showInactive());
  await sentinel.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><title>${nonce} Canary Sentinel</title><style>body{font:18px system-ui;padding:24px}</style><h1>Canary sentinel</h1><p>No canary window may hold focus; the app must never become frontmost while the target receives text.</p>`,
    )}`,
  );
  // Never call focus(): BrowserWindow.focus() activates the app even under an
  // `open -g` launch — the exact focus theft the canary must not cause. The
  // phase records below report that every canary window stayed unfocused.

  const target = new BrowserWindow({
    title: `${nonce} Canary Target`,
    width: 640,
    height: 420,
    x: 80,
    y: 320,
    show: false,
  });
  target.once("ready-to-show", () => target.showInactive());
  await target.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><title>${nonce} Canary Target</title><style>body{font:18px system-ui;padding:24px}input{font:20px system-ui;padding:12px;width:90%}</style><h1>Canary target</h1><input id="text" aria-label="Canary text" value=""><p>Exact semantic target</p>`,
    )}`,
  );

  // SYNARA_CUA_CANARY_ENDPOINT/CAPABILITY: connect to an externally hosted
  // driver instead of embedding one. The adhoc canary bundle holds no TCC
  // grants of its own, so an embedded driver is attributed to it and every AX
  // surface comes back empty. An external host spawned under a trusted
  // ancestry (the operator terminal) serves the same protocol with grants —
  // the semantic path being certified is identical; only the TCC provisioning
  // differs, and the report records which mode ran.
  const externalEndpoint = process.env.SYNARA_CUA_CANARY_ENDPOINT ?? "";
  const capability =
    externalEndpoint.length > 0
      ? (process.env.SYNARA_CUA_CANARY_CAPABILITY ?? "")
      : randomBytes(32).toString("base64url");
  if (externalEndpoint.length > 0 && capability.length === 0)
    throw new Error("SYNARA_CUA_CANARY_ENDPOINT requires SYNARA_CUA_CANARY_CAPABILITY.");
  report.driverMode = externalEndpoint.length > 0 ? "external" : "embedded";
  let endpoint: string;
  if (externalEndpoint.length > 0) {
    endpoint = externalEndpoint;
  } else {
    host = new CuaDriverHost({
      binaryPath: join(resourcesPath, "cua-driver", "cua-driver"),
      capability,
      bundleId: "com.synara.cua-canary",
      setup: async () => {
        throw new Error("The canary probe never requests permissions.");
      },
    });
    endpoint = await host.listen();
  }
  const recordedRequest: typeof cuaRequest = async <T>(
    path: string,
    request: unknown,
    options?: Parameters<typeof cuaRequest>[2],
  ): Promise<T> => {
    const reply = await cuaRequest<T>(path, request, options);
    if ((request as { name?: string }).name === "type_text")
      (report.nativeActions as unknown[]).push({
        name: "type_text",
        result: (reply as CuaReply).result?.structuredContent,
      });
    return reply;
  };
  backend = new CuaComputerBackend({
    endpoint,
    capability,
    request: recordedRequest,
  });

  // Capture the raw permission probe up front: the backend gates enumeration
  // behind it, and an early identity failure must not hide which grant the
  // embedded driver reports missing under this bundle.
  try {
    const permissionReply = await cuaRequest<{
      result?: { structuredContent?: unknown };
    }>(endpoint, {
      method: "call",
      name: "check_permissions",
      args: { prompt: false },
      capability,
    });
    report.nativePermissions = permissionReply.result?.structuredContent;
  } catch (error) {
    report.nativePermissions = { error: String(error) };
  }

  // `open -g` launches keep the app invisible to LaunchServices activation but
  // the windows still take a beat to register with WindowServer — the same lag
  // `launch_app`'s retry loop absorbs. Poll instead of racing the first read.
  // Identity is by exact geometry, not title: the embedded driver is a child
  // of this adhoc bundle, so WindowServer strips kCGWindowTitle for it (no
  // screen-capture grant) — titles arrive as "".
  const boundsMatch = (
    window: {
      pid: number;
      bounds: { x: number; y: number; width: number; height: number };
    },
    rect: { x: number; y: number; width: number; height: number },
  ) =>
    window.pid === process.pid &&
    window.bounds.x === rect.x &&
    window.bounds.y === rect.y &&
    window.bounds.width === rect.width &&
    window.bounds.height === rect.height;
  const targetRect = { x: 80, y: 320, width: 640, height: 420 };
  const sentinelRect = { x: 80, y: 80, width: 400, height: 200 };
  let windows: Awaited<ReturnType<typeof backend.listWindows>> = [];
  let targetMatches: typeof windows = [];
  let sentinelMatches: typeof windows = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    windows = await backend.listWindows();
    targetMatches = windows.filter((window) => boundsMatch(window, targetRect));
    sentinelMatches = windows.filter((window) => boundsMatch(window, sentinelRect));
    if (targetMatches.length === 1 && sentinelMatches.length === 1) break;
    await pause(250);
  }
  if (targetMatches.length !== 1 || sentinelMatches.length !== 1) {
    const raw: unknown = await cuaRequest<CuaReply>(endpoint, {
      method: "call",
      name: "list_windows",
      args: {},
      capability,
    }).catch((error: unknown) => ({ error: String(error) }));
    // Self-target probe: does the embedded driver hold enough AX trust to
    // inspect and mutate windows owned by its own responsible host even when
    // check_permissions reports accessibility:false? The answer decides whether
    // the canary can drive itself or whether TCC must grant the bundle first.
    const selfProbe: Record<string, unknown> = {};
    const rawWindows = ((
      raw as {
        result?: {
          structuredContent?: {
            windows?: { window_id?: number; pid?: number }[];
          };
        };
      }
    )?.result?.structuredContent?.windows ?? []) as {
      window_id?: number;
      pid?: number;
    }[];
    const selfWindow = rawWindows.find(
      (w) => w.pid === process.pid && typeof w.window_id === "number",
    );
    if (selfWindow?.window_id) {
      selfProbe.get_window_state = await cuaRequest<CuaReply>(endpoint, {
        method: "call",
        name: "get_window_state",
        args: { pid: process.pid, window_id: selfWindow.window_id },
        capability,
      }).catch((error: unknown) => ({ error: String(error) }));
    } else {
      selfProbe.skipped = "no raw window for own pid";
    }
    throw new Error(
      `Canary window identity check failed: ${targetMatches.length} target window(s), ` +
        `${sentinelMatches.length} sentinel window(s). ` +
        `Backend list: ${JSON.stringify(
          windows.map((w) => ({
            id: w.id,
            pid: w.pid,
            app: w.appName,
            title: w.title,
            bounds: w.bounds,
            visible: w.visible,
          })),
        ).slice(0, 3000)} in-process: ${JSON.stringify(
          BrowserWindow.getAllWindows().map((w) => ({
            id: w.id,
            title: w.getTitle(),
            visible: w.isVisible(),
          })),
        )} self-probe: ${JSON.stringify(selfProbe).slice(0, 1500)} raw driver: ${JSON.stringify(raw).slice(0, 2500)}`,
    );
  }
  const targetWindow = targetMatches[0]!;
  const sentinelWindow = sentinelMatches[0]!;
  const nativeWindowId = Number(targetWindow.id.split(":")[2]);
  if (!Number.isSafeInteger(nativeWindowId) || nativeWindowId <= 0)
    throw new Error(`Canary target window id is not a native window number: ${targetWindow.id}`);

  // The renderer's AX tree lags window ordering by a beat; baseline must not
  // fail on warmup. Poll the semantic target once before the ladder starts.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const observation = await backend.getState({
        windowId: targetWindow.id,
        includeTree: true,
      });
      if (findNode(observation.root, "Canary text")) break;
    } catch {
      // Keep polling: the window is real, only the AX tree is still empty.
    }
    await pause(250);
  }

  const phases = ["baseline", "stage-1", "stage-2", "stage-3", "stage-4", "stage-5", "stage-6"];
  for (const phase of phases) {
    const stage = phase === "baseline" ? null : Number(phase.slice("stage-".length));
    const typed = `canary-${phase}`;
    const helper = stage === null ? null : await runHelper(stage, nativeWindowId);
    // Belief posts are asynchronous; give the target time to process the
    // signal before any input is sent.
    if (stage !== null) await pause(1500);

    // Never re-focus the sentinel: activating the app would steal the
    // operator's focus. The field records whether any canary window holds OS
    // focus — the expectation is that none ever does.
    await pause(300);
    const sentinelFocusedBefore = BrowserWindow.getFocusedWindow()?.id === sentinel.id;

    // Resolve the exact AX field once per phase, fresh from a new observation.
    // A stale or unresolved node would send the backend down the process-scoped
    // keyboard route, which it refuses while sibling windows exist.
    let resolved: ResolvedCanaryTarget | undefined;
    let resolveError: string | null = null;
    try {
      const observation = await backend.getState({
        windowId: targetWindow.id,
        includeTree: true,
      });
      const node = findNode(observation.root, "Canary text");
      if (node?.activationPoint)
        resolved = {
          target: { windowId: targetWindow.id, label: "Canary text" },
          node,
          point: node.activationPoint,
        };
    } catch (error) {
      resolveError = String(error);
    }
    if (!resolved) {
      phaseRecords.push({
        phase,
        stage,
        typed,
        electronReadback: null,
        axReadback: null,
        helper,
        typeResult: null,
        sentinelFocusedBefore,
        focusAfterType: null,
        readbackError: "semantic target unavailable",
        clickResult: null,
        axElementCount: null,
        axTreeError: resolveError,
      });
      continue;
    }

    // Background click on the exact element before typing. A refused click is
    // recorded, never fatal.
    let clickResult: unknown = null;
    try {
      clickResult = await backend.click(
        { x: resolved.point.x, y: resolved.point.y },
        targetWindow.id,
      );
    } catch (error) {
      clickResult = String(error);
    }

    let typeResult: unknown;
    try {
      typeResult = await backend.typeText(typed, targetWindow.id, resolved);
    } catch (error) {
      typeResult = String(error);
    }
    await pause(300);
    const focusAfterType = BrowserWindow.getFocusedWindow()?.id ?? null;

    let electronReadback: string | null = null;
    let readbackError: string | null = null;
    try {
      electronReadback = (await target.webContents.executeJavaScript(
        "document.querySelector('#text').value",
      )) as string | null;
    } catch (error) {
      readbackError = `electron: ${String(error)}`;
    }
    let axReadback: string | null = null;
    let axElementCount: number | null = null;
    let axTreeError: string | null = null;
    try {
      const observation = await backend.getState({
        windowId: targetWindow.id,
        includeTree: true,
      });
      axReadback = findNode(observation.root, "Canary text")?.value ?? null;
      axElementCount = countNodes(observation.root);
    } catch (error) {
      axTreeError = String(error);
    }

    phaseRecords.push({
      phase,
      stage,
      typed,
      electronReadback,
      axReadback,
      helper,
      typeResult,
      sentinelFocusedBefore,
      focusAfterType,
      readbackError,
      clickResult,
      axElementCount,
      axTreeError,
    });
    // Never retry or replay a phase: the first exact readback ends the ladder.
    if (electronReadback === typed) break;
  }

  const passing = phaseRecords.find((record) => record.electronReadback === record.typed);
  report.summary = passing?.phase ?? "none-passed";
  report.windows = {
    target: {
      backendId: targetWindow.id,
      nativeId: nativeWindowId,
      title: targetWindow.title,
      bounds: targetWindow.bounds,
    },
    sentinel: {
      backendId: sentinelWindow.id,
      nativeId: Number(sentinelWindow.id.split(":")[2]),
      title: sentinelWindow.title,
      bounds: sentinelWindow.bounds,
    },
    listed: windows.filter((window) => window.pid === process.pid),
  };

  try {
    report.nativeBuild = JSON.parse(
      await readFile(join(resourcesPath, "fixture-native.json"), "utf8"),
    );
  } catch {
    report.nativeBuild = {};
  }

  const permissionReply = await cuaRequest<{
    result?: { structuredContent?: unknown };
  }>(endpoint, {
    method: "call",
    name: "check_permissions",
    args: { prompt: false },
    capability,
  });
  report.nativePermissions = permissionReply.result?.structuredContent;
}

main()
  .catch((error) => {
    report.error = String(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await backend?.dispose().catch((error: unknown) => {
      report.backendTeardownError = String(error);
    });
    await host?.dispose().catch((error: unknown) => {
      report.hostTeardownError = String(error);
    });
    if (directoryValid) {
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
      } catch (error) {
        report.writeError = String(error);
      }
    }
    app.exit(Number(process.exitCode ?? 0));
  });
