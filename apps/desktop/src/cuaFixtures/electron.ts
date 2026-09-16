/** Fixture-only native integration runner. It never targets a window until
 * title + WindowServer PID + native id identify this process's own fixture. */
import { app, BrowserWindow, ipcMain } from "electron";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import type { ComputerUiNode } from "@synara/contracts";
import { cuaRequest, CUA_ACTION_TOOLS, type CuaReply } from "@synara/shared/cuaDriverProtocol";
import { CuaDriverHost } from "../cuaDriverHost";
import {
  CuaActionError,
  CuaComputerBackend,
} from "../../../server/src/computer/CuaComputerBackend";
import { runNativeFixture } from "./native";
import { runGatewayFixture } from "./gateway";
import { runCancellationFixture } from "./cancellation";
import { withDesktopDeliveryMode } from "../../../server/src/computer/DesktopOperationQueue";
import { runLiveFixture } from "./live";

const directory =
  process.env.SYNARA_CUA_FIXTURE_DIR ??
  `/private/tmp/synara-cua-implementation/fixture-${Date.now()}`;
const binaryPath =
  process.env.SYNARA_CUA_FIXTURE_DRIVER || join(process.resourcesPath, "cua-driver", "cua-driver");
if (
  !directory?.startsWith("/private/tmp/synara-cua-implementation/") ||
  !binaryPath?.endsWith("/cua-driver")
)
  throw new Error("An explicit temporary fixture directory and driver binary are required.");
app.setPath("userData", join(directory, "electron-profile"));
app.setName("Synara Cua Fixture");
// Closing the last target is itself a test case; keep its runner alive until
// the refused action, native target and report teardown have completed.
app.on("window-all-closed", () => undefined);
const nonce = `Synara Cua Fixture ${process.pid}`;
const report: Record<string, unknown> = {
  fixtureRevision: 11,
  fixture: nonce,
  pid: process.pid,
  runtime: process.versions,
  cases: [],
  measurements: [],
  nativeActions: [],
  nativeObservations: [],
};
const cases = report.cases as unknown[];
const state = { clicks: 0, text: "abc", changes: 0 };
let host: CuaDriverHost | undefined;
let backend: CuaComputerBackend | undefined;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const measured = async <T>(name: string, run: () => Promise<T>) => {
  const started = performance.now();
  try {
    return await run();
  } finally {
    (report.measurements as unknown[]).push({ name, milliseconds: performance.now() - started });
  }
};
const findNode = (root: ComputerUiNode | undefined, label: string): ComputerUiNode | undefined => {
  if (root?.role === "AXTextField" && root.label === label) return root;
  for (const child of root?.children ?? []) {
    const found = findNode(child, label);
    if (found) return found;
  }
  return undefined;
};
async function main() {
  await mkdir(directory!, { recursive: true });
  report.nativeBuild = JSON.parse(
    await readFile(join(process.resourcesPath, "fixture-native.json"), "utf8"),
  );
  await app.whenReady();
  ipcMain.on("fixture-state", (_event, value) => {
    Object.assign(state, value);
  });
  const first = new BrowserWindow({
    title: `${nonce} A`,
    width: 640,
    height: 420,
    x: 80,
    y: 80,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  const sibling = new BrowserWindow({
    title: `${nonce} B`,
    width: 420,
    height: 220,
    x: 700,
    y: 80,
    show: false,
  });
  const third = new BrowserWindow({
    title: `${nonce} C`,
    width: 420,
    height: 220,
    x: 700,
    y: 330,
    show: false,
  });
  const html = `<!doctype html><title>${nonce} A</title><style>body{font:18px system-ui;padding:24px}button,input{font:20px system-ui;margin:14px;padding:12px}</style><h1>Synara controlled fixture</h1><button id="counter">Click counter: 0</button><input id="text" aria-label="Fixture text" value="abc"><p id="state"></p><script>const {ipcRenderer}=require('electron'); let clicks=0,changes=0; const button=document.querySelector('#counter'),input=document.querySelector('#text'); function emit(){const value={clicks,text:input.value,changes};document.querySelector('#state').textContent=JSON.stringify(value);ipcRenderer.send('fixture-state',value)} button.onclick=()=>{clicks++;button.textContent='Click counter: '+clicks;emit()};input.oninput=()=>{changes++;emit()};emit();</script>`;
  await first.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const targetHtml = (label: "B" | "C") =>
    `<!doctype html><title>${nonce} ${label}</title><style>body{font:18px system-ui;padding:24px}input{font:20px system-ui;padding:12px;width:90%}</style><h1>Background target ${label}</h1><input id="text" aria-label="Fixture text ${label}" value=""><p>Exact semantic target ${label}</p>`;
  await sibling.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(targetHtml("B"))}`);
  await third.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(targetHtml("C"))}`);
  sibling.showInactive();
  third.showInactive();
  first.webContents.on("will-navigate", (event) => event.preventDefault());
  first.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const capability = randomBytes(32).toString("base64url");
  host = new CuaDriverHost({
    binaryPath: binaryPath!,
    capability,
    bundleId: "com.synara.cua-fixture",
    setup: async () => {
      throw new Error("Fixture runner never requests permissions.");
    },
  });
  const endpoint = await host.listen();
  const permissionReply = await cuaRequest<{ result?: { structuredContent?: unknown } }>(endpoint, {
    method: "call",
    name: "check_permissions",
    args: { prompt: false },
    capability,
  });
  report.nativePermissions = permissionReply.result?.structuredContent;
  const windowReply = await cuaRequest<{
    result?: { structuredContent?: { windows?: Array<{ pid?: number }> } };
  }>(endpoint, { method: "call", name: "list_windows", args: { pid: process.pid }, capability });
  report.nativeFixtureWindows = windowReply.result?.structuredContent?.windows?.filter(
    (window) => window.pid === process.pid,
  );
  const captureTargets = new Set<string>();
  const recordedRequest: typeof cuaRequest = async <T>(
    path: string,
    request: unknown,
    options?: Parameters<typeof cuaRequest>[2],
  ): Promise<T> => {
    const name = (request as { name?: string }).name;
    const args = (request as { args?: { pid?: number; window_id?: number } }).args;
    if (
      name === "get_desktop_state" ||
      (name === "get_window_state" && !captureTargets.has(`cua:${args?.pid}:${args?.window_id}`))
    ) {
      throw new Error("Fixture capture is restricted to independently identified owned windows.");
    }
    const reply = await cuaRequest<T>(path, request, options);
    if (name && CUA_ACTION_TOOLS.has(name)) {
      (report.nativeActions as unknown[]).push({
        name,
        result: (reply as CuaReply).result?.structuredContent,
      });
    }
    const result = (reply as CuaReply).result?.structuredContent;
    if (name === "get_window_state" && result) {
      (report.nativeObservations as unknown[]).push({
        name,
        pid: result.pid,
        windowId: result.window_id,
        bounds: result.window_bounds,
      });
    }
    if (name === "list_windows" && Array.isArray(result?.windows)) {
      const windows = result.windows.filter(
        (window) =>
          typeof window?.title === "string" &&
          /^Synara (Cua|Native) Fixture \d+ [ABC]$/.test(window.title),
      );
      (report.nativeObservations as unknown[]).push({ name, windows });
    }
    return reply;
  };
  backend = new CuaComputerBackend({ endpoint, capability, request: recordedRequest });
  report.availability = await backend.availability();
  if ((report.availability as { kind: string }).kind !== "available") {
    cases.push({
      name: "native-input",
      status: "not-run",
      reason: "Host is missing required macOS grants; no input sent.",
    });
    return;
  }
  const windows = await backend.listWindows();
  const exact = windows.filter(
    (window) => window.pid === process.pid && window.title === `${nonce} A`,
  );
  const other = windows.filter(
    (window) => window.pid === process.pid && window.title === `${nonce} B`,
  );
  const thirdWindow = windows.filter(
    (window) => window.pid === process.pid && window.title === `${nonce} C`,
  );
  if (exact.length !== 1 || other.length !== 1 || thirdWindow.length !== 1)
    throw new Error("Fixture window identity/isolation verification failed; no input permitted.");
  const window = exact[0]!;
  captureTargets.add(window.id);
  captureTargets.add(other[0]!.id);
  captureTargets.add(thirdWindow[0]!.id);
  report.target = {
    id: window.id,
    pid: window.pid,
    title: window.title,
    siblingId: other[0]!.id,
    thirdId: thirdWindow[0]!.id,
  };
  const observation = await measured("window-observation", () =>
    backend!.getState({ windowId: window.id, includeTree: true, includeScreenshot: true }),
  );
  if (observation.screenshot)
    await writeFile(
      join(directory!, "fixture-before.png"),
      Buffer.from(observation.screenshot.bytesBase64, "base64"),
    );
  const button = await first.webContents.executeJavaScript(
    "(()=>{const r=document.querySelector('#counter').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
  );
  const content = first.getContentBounds();
  try {
    const clickResult = await measured("click", () =>
      backend!.click({ x: content.x + button.x, y: content.y + button.y }, window.id),
    );
    await pause(500);
    cases.push({
      name: "one-click-one-effect",
      result: clickResult,
      appState: { ...state },
      status: state.clicks === 1 ? "passed" : "failed",
    });
  } catch (error) {
    cases.push({
      name: "one-click-one-effect",
      status: "refused",
      error: String(error),
      appState: { ...state },
    });
  }
  // The fixture itself selects its text; Cua must deliver only one replacement.
  await first.webContents.executeJavaScript(
    "document.querySelector('#text').focus();document.querySelector('#text').select()",
  );
  try {
    const result = await measured("identical-text", () => backend!.typeText("abc", window.id));
    await pause(500);
    cases.push({
      name: "identical-text-replacement",
      result,
      appState: { ...state },
      status: state.text === "abc" && state.changes > 0 ? "passed" : "failed",
    });
  } catch (error) {
    cases.push({
      name: "identical-text-replacement",
      status: "refused",
      error: String(error),
      appState: { ...state },
    });
  }
  const semanticWindows = [
    { browser: first, window, label: "Fixture text", text: "agent-a-background" },
    { browser: sibling, window: other[0]!, label: "Fixture text B", text: "agent-b-background" },
    {
      browser: third,
      window: thirdWindow[0]!,
      label: "Fixture text C",
      text: "agent-c-background",
    },
  ];
  const semanticTargets = await Promise.all(
    semanticWindows.map(async (target) => {
      await target.browser.webContents.executeJavaScript(
        "(()=>{const input=document.querySelector('#text');input.value='';input.setSelectionRange(0,0)})()",
      );
      const observed = await backend!.getState({
        windowId: target.window.id,
        includeTree: true,
      });
      const node = findNode(observed.root, target.label);
      if (!node?.activationPoint)
        throw new Error(`Exact semantic fixture target ${target.label} is unavailable.`);
      return {
        ...target,
        resolved: {
          target: { windowId: target.window.id, label: target.label },
          node,
          point: node.activationPoint,
        },
      };
    }),
  );
  const sentinel = new BrowserWindow({
    title: `${nonce} Focus Guard`,
    width: 520,
    height: 180,
    x: 100,
    y: 540,
  });
  await sentinel.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><title>${nonce} Focus Guard</title><style>body{font:22px system-ui;padding:24px}</style><h1>Foreground focus guard</h1><p>The traffic lights must stay active while A, B and C receive text.</p>`,
    )}`,
  );
  sentinel.focus();
  await pause(300);
  const focusSamples: Array<number | null> = [];
  const sampleFocus = () => focusSamples.push(BrowserWindow.getFocusedWindow()?.id ?? null);
  sampleFocus();
  const focusSampler = setInterval(sampleFocus, 1);
  let semanticResults: unknown[] = [];
  let semanticError: unknown;
  const spans: Array<{ label: string; started: number; finished: number }> = [];
  try {
    semanticResults = await Promise.all(
      semanticTargets.map(async (target) => {
        const started = performance.now();
        try {
          return await backend!.typeText(target.text, target.window.id, target.resolved);
        } finally {
          spans.push({ label: target.label, started, finished: performance.now() });
        }
      }),
    );
  } catch (error) {
    semanticError = error;
  } finally {
    clearInterval(focusSampler);
    sampleFocus();
  }
  const semanticValues = await Promise.all(
    semanticTargets.map((target) =>
      target.browser.webContents.executeJavaScript("document.querySelector('#text').value"),
    ),
  );
  const overlap =
    spans.length === semanticTargets.length &&
    Math.max(...spans.map((span) => span.started)) <
      Math.min(...spans.map((span) => span.finished));
  cases.push({
    name: "three-window-focus-neutral-semantic-text",
    status:
      !semanticError &&
      semanticValues.every((value, index) => value === semanticTargets[index]!.text) &&
      focusSamples.length > 1 &&
      focusSamples.every((id) => id === sentinel.id) &&
      overlap
        ? "passed"
        : "failed",
    results: semanticResults,
    error: semanticError ? String(semanticError) : undefined,
    expected: semanticTargets.map((target) => target.text),
    actual: semanticValues,
    sentinelWindowId: sentinel.id,
    focusSamples,
    spans,
    overlap,
  });
  // Removing the sibling changes the admission condition. This is a distinct
  // single-window case, never an automatic foreground replay of the refusal.
  sibling.close();
  third.close();
  sentinel.close();
  await pause(300);
  await first.webContents.executeJavaScript(
    "document.querySelector('#text').focus();document.querySelector('#text').select()",
  );
  try {
    const result = await measured("single-window-identical-text", () =>
      backend!.typeText("abc", window.id),
    );
    await pause(300);
    const appField = await first.webContents.executeJavaScript(
      "(()=>{const input=document.querySelector('#text');return {text:input.value,selectionStart:input.selectionStart,selectionEnd:input.selectionEnd}})()",
    );
    cases.push({
      name: "single-window-identical-text",
      result,
      appState: { ...state, ...appField },
      status: appField.text === "abc" && state.changes > 0 ? "passed" : "failed",
    });
  } catch (error) {
    cases.push({
      name: "single-window-identical-text",
      status: "refused",
      error: String(error),
      appState: { ...state },
    });
  }

  // Operator opt-in for exactly one explicitly authorized foreground action.
  // Reset this owned field first: this is a separate test, not a replay of the
  // uncertain background insertion. No personal clipboard is read or changed.
  if (process.env.SYNARA_CUA_FIXTURE_FOREGROUND === "approved-once") {
    await first.webContents.executeJavaScript(
      "(()=>{const input=document.querySelector('#text');input.value='foreground seed';input.focus();input.select()})()",
    );
    try {
      const result = await measured("foreground-text", () =>
        withDesktopDeliveryMode("foreground", () => backend!.typeText("foreground-ok", window.id)),
      );
      const actualText = await first.webContents.executeJavaScript(
        "document.querySelector('#text').value",
      );
      cases.push({
        name: "explicit-foreground-text",
        result,
        actualText,
        status: actualText === "foreground-ok" ? "passed" : "failed",
      });
    } catch (error) {
      cases.push({ name: "explicit-foreground-text", status: "refused", error: String(error) });
    }
  } else
    cases.push({
      name: "explicit-foreground-text",
      status: "not-run",
      reason: "Requires explicit authorization for this one foreground action.",
    });

  const semanticState = await measured("semantic-observation", () =>
    backend!.getState({ windowId: window.id, includeTree: true, includeScreenshot: true }),
  );
  const textNode = findNode(semanticState.root, "Fixture text");
  if (textNode?.activationPoint) {
    try {
      const result = await measured("set-value", () =>
        backend!.setValue(
          {
            target: { windowId: window.id, label: "Fixture text" },
            node: textNode,
            point: textNode.activationPoint!,
          },
          "fixture-value",
        ),
      );
      const appText = await first.webContents.executeJavaScript(
        "document.querySelector('#text').value",
      );
      cases.push({
        name: "ax-set-value",
        result,
        actualText: appText,
        status: appText === "fixture-value" ? "passed" : "failed",
      });
    } catch (error) {
      cases.push({ name: "ax-set-value", status: "refused", error: String(error) });
    }
  } else
    cases.push({
      name: "ax-set-value",
      status: "not-run",
      reason: "The native tree did not expose the exact fixture field.",
    });

  const clicksBeforeMove = state.clicks;
  first.setPosition(180, 80);
  await pause(300);
  try {
    await backend.click({ x: content.x + button.x, y: content.y + button.y }, window.id);
    cases.push({ name: "moved-target", status: "failed", reason: "A stale point was admitted." });
  } catch (error) {
    cases.push({
      name: "moved-target",
      status:
        error instanceof CuaActionError &&
        error.effect === "not-dispatched" &&
        state.clicks === clicksBeforeMove
          ? "passed"
          : "failed",
      error: String(error),
      appState: { ...state },
    });
  }
  const capture = await backend.captureScreenshot({ kind: "window", windowId: window.id });
  await writeFile(
    join(directory!, "fixture-after.png"),
    Buffer.from(capture.bytesBase64, "base64"),
  );
  first.close();
  await pause(150);
  try {
    await backend.typeText("must not arrive", window.id);
    cases.push({ name: "closed-target", status: "failed" });
  } catch (error) {
    cases.push({
      name: "closed-target",
      status:
        error instanceof CuaActionError && error.effect === "not-dispatched" ? "passed" : "failed",
      error: String(error),
    });
  }
  const approveCapture = (windowId: string) => {
    captureTargets.add(windowId);
  };
  report.native = await runNativeFixture(
    backend,
    directory,
    join(process.resourcesPath, "native-fixture"),
    approveCapture,
  );
  report.cancellation = await runCancellationFixture(backend, host, approveCapture);
  report.gateway = await runGatewayFixture(
    backend,
    directory,
    () => (report.nativeActions as unknown[]).length,
    approveCapture,
  );
  report.processMemory = process.memoryUsage();
}
const run =
  process.env.SYNARA_CUA_FIXTURE_LIVE === "1"
    ? runLiveFixture(directory, binaryPath).then((result) => {
        report.live = result;
      })
    : main();
run
  .catch((error) => {
    report.error = String(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await backend?.dispose().catch((error) => {
      report.backendTeardownError = String(error);
    });
    await host?.dispose().catch((error) => {
      report.hostTeardownError = String(error);
    });
    await mkdir(directory!, { recursive: true });
    await writeFile(join(directory!, "report.json"), JSON.stringify(report, null, 2));
    app.exit(Number(process.exitCode ?? 0));
  });
