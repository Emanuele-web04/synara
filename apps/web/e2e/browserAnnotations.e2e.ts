import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserAnnotationEvent, BrowserAnnotationTheme } from "@synara/contracts";
import { _electron as electron, expect, test, type ElectronApplication } from "playwright/test";

import { createBrowserMcpHarness } from "./fixtures/mcpBrowserHarness";
import { startVisibleBrowserFixtureSite } from "./fixtures/siteServer";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = resolve(WEB_DIR, "../desktop");
const requireFromDesktop = createRequire(resolve(DESKTOP_DIR, "package.json"));
const DARK_ANNOTATION_THEME: BrowserAnnotationTheme = {
  mode: "dark",
  accent: "rgb(96, 115, 204)",
  surface: "rgb(27, 27, 29)",
  text: "rgb(250, 250, 250)",
  mutedText: "rgb(161, 161, 170)",
  border: "rgb(63, 63, 70)",
  focusBorder: "rgb(96, 115, 204)",
  primary: "rgb(250, 250, 250)",
  primaryText: "rgb(24, 24, 27)",
};

function waitForSettlement(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    timer.unref();
    void promise.finally(() => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

async function closeElectronApplication(application: ElectronApplication): Promise<void> {
  let closeError: unknown;
  const closing = application.close().catch((error: unknown) => {
    closeError = error;
  });
  if (!(await waitForSettlement(closing, 5_000))) {
    application.process().kill("SIGKILL");
    await waitForSettlement(closing, 2_000);
  }
  if (closeError) throw closeError;
}

test("a real Electron guest commits and reprojects a continuous annotation session", async () => {
  const mainPath = process.env.SYNARA_E2E_ELECTRON_MAIN;
  const annotationPreloadPath = process.env.SYNARA_E2E_BROWSER_ANNOTATION_PRELOAD;
  if (!mainPath || !annotationPreloadPath) {
    throw new Error("Electron annotation E2E bundles were not prepared.");
  }

  const site = await startVisibleBrowserFixtureSite();
  const home = mkdtempSync(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "synara-annotations-"),
  );
  const workspaceRoot = join(home, "workspace");
  mkdirSync(workspaceRoot);
  const pipePath = join(home, "browser-host.sock");
  const capability = `browser-annotations-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const threadId = `thread-browser-annotations-${crypto.randomUUID()}`;
  const shellPath = resolve(WEB_DIR, "e2e/fixtures/visibleBrowserShell.html");
  const executablePath = requireFromDesktop("electron") as string;
  const electronApp = await electron.launch({
    executablePath,
    args: [mainPath],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      HOME: home,
      SYNARA_HOME: home,
      SYNARA_BROWSER_HOST_PIPE_PATH: pipePath,
      SYNARA_BROWSER_HOST_CAPABILITY: capability,
      SYNARA_E2E_SHELL_PATH: shellPath,
      SYNARA_E2E_THREAD_ID: threadId,
      SYNARA_E2E_BROWSER_ANNOTATION_PRELOAD: annotationPreloadPath,
    },
  });

  try {
    const page = await electronApp.firstWindow();
    await expect(page.locator("html")).toHaveAttribute("data-shell-ready", "true");
    const mcp = createBrowserMcpHarness({
      pipePath,
      capability,
      threadId,
      workspaceRoot,
    });
    await mcp.initialize();
    await expect
      .poll(
        async () => {
          try {
            const status = await mcp.call("browser_status");
            return status.structuredContent.available === true;
          } catch {
            return false;
          }
        },
        { timeout: 5_000, intervals: [25, 50, 100, 200] },
      )
      .toBe(true);
    const annotatedLiveUrl = `${site.appUrl}?token=private-annotation`;
    const opened = await mcp.call("browser_open", {
      url: annotatedLiveUrl,
      show: true,
      reuse: true,
    });
    const tabId = String(opened.structuredContent.tabId);
    await expect(page.locator("html")).toHaveAttribute("data-native-runtime-tab-id", tabId);

    const sendNativeInput = (event: Record<string, unknown>) =>
      electronApp.evaluate(
        (_electron, input) => {
          const manager = (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: {
                browserManager: {
                  runtimes: Map<
                    string,
                    { webContents: { sendInputEvent(event: Record<string, unknown>): void } }
                  >;
                };
              };
            }
          ).__synaraVisibleBrowserE2E.browserManager;
          const runtime = manager.runtimes.get(`${input.threadId}:${input.tabId}`);
          if (!runtime) throw new Error("Expected the native annotation runtime to be live.");
          runtime.webContents.sendInputEvent(input.event);
        },
        { threadId, tabId, event },
      );
    const insertNativeText = (text: string) =>
      electronApp.evaluate(
        (_electron, input) => {
          const manager = (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: {
                browserManager: {
                  runtimes: Map<
                    string,
                    { webContents: { insertText(text: string): Promise<void> } }
                  >;
                };
              };
            }
          ).__synaraVisibleBrowserE2E.browserManager;
          const runtime = manager.runtimes.get(`${input.threadId}:${input.tabId}`);
          if (!runtime) throw new Error("Expected the native annotation runtime to be live.");
          return runtime.webContents.insertText(input.text);
        },
        { threadId, tabId, text },
      );
    const clickNativePoint = async (x: number, y: number): Promise<void> => {
      const point = { x: Math.round(x), y: Math.round(y) };
      await sendNativeInput({ type: "mouseMove", ...point });
      await sendNativeInput({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      await sendNativeInput({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    };
    const pressNativeKey = async (
      keyCode: string,
      modifiers: readonly string[] = [],
    ): Promise<void> => {
      await sendNativeInput({ type: "keyDown", keyCode, modifiers });
      await sendNativeInput({ type: "keyUp", keyCode, modifiers });
    };

    const targetGeometry = await mcp.call("browser_run", {
      code: "return await page.evaluate(() => { const r = document.querySelector('#manual').getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; });",
      idempotencyKey: crypto.randomUUID(),
    });
    const targetRect = targetGeometry.structuredContent.value as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const sensitiveContainerGeometry = await mcp.call("browser_run", {
      code: "return await page.evaluate(() => { const r = document.querySelector('#private-editor-wrap').getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; });",
      idempotencyKey: crypto.randomUUID(),
    });
    const sensitiveContainerRect = sensitiveContainerGeometry.structuredContent.value as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    /** MCP browser tools refuse to act while an annotation session holds the page — page-side setup goes through the main process */
    const runInGuest = async (script: string): Promise<unknown> =>
      electronApp.evaluate(
        (_electron, input) => {
          const fixture = (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: {
                browserManager: {
                  getVisibleAutomationRuntime(value: { threadId: string; tabId: string }): {
                    webContents: { executeJavaScript(script: string): Promise<unknown> };
                  };
                };
              };
            }
          ).__synaraVisibleBrowserE2E;
          return fixture.browserManager
            .getVisibleAutomationRuntime({ threadId: input.threadId, tabId: input.tabId })
            .webContents.executeJavaScript(input.script);
        },
        { threadId, tabId, script },
      );
    /** calls a main-process browser-manager method; rejects on throw, so an expected not-ready failure must be explicit */
    const callBrowserManager = async (
      method: "startAnnotation" | "cancelAnnotation" | "syncAnnotationMarkers",
      payload: unknown,
    ): Promise<unknown> =>
      electronApp.evaluate(
        (_electron, input) => {
          const fixture = (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: {
                browserManager: Record<string, (value: unknown) => unknown>;
              };
            }
          ).__synaraVisibleBrowserE2E;
          return fixture.browserManager[input.method]?.(input.payload) ?? null;
        },
        { method, payload },
      );
    const annotationEvents = async (): Promise<BrowserAnnotationEvent[]> =>
      electronApp.evaluate(() => {
        const fixture = (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: { annotationEvents: BrowserAnnotationEvent[] };
          }
        ).__synaraVisibleBrowserE2E;
        return fixture.annotationEvents;
      });
    const annotationEventKinds = async (): Promise<string[]> =>
      (await annotationEvents()).map((event) => event.kind);
    const committedAnnotations = async (): Promise<
      Extract<BrowserAnnotationEvent, { kind: "committed" }>[]
    > =>
      (await annotationEvents()).filter(
        (event): event is Extract<BrowserAnnotationEvent, { kind: "committed" }> =>
          event.kind === "committed",
      );

    await expect
      .poll(
        () =>
          // the guest refuses until its preload attaches — a throw here is a retry signal
          callBrowserManager("startAnnotation", {
            threadId,
            tabId,
            theme: DARK_ANNOTATION_THEME,
          }).catch(() => null),
        { timeout: 5_000, intervals: [25, 50, 100, 200] },
      )
      .not.toBeNull();

    // the overlay host lives in the page DOM — synthetic events from a hostile page must never steer the picker
    const spoofingReachedOverlayHost = await runInGuest(
      "(() => { const host = document.querySelector('[data-synara-browser-annotations]'); document.dispatchEvent(new PointerEvent('pointermove', { clientX: 3, clientY: 3, bubbles: true })); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); host?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return host !== null; })()",
    );
    expect(spoofingReachedOverlayHost).toBe(true);
    const kindsAfterSpoofing = await annotationEventKinds();
    expect(kindsAfterSpoofing).not.toContain("cancelled");
    expect(kindsAfterSpoofing).not.toContain("committed");

    // an element too deep for the selector bound can never commit — refuse up front instead of losing the typed comment
    const unanchorableRect = (await runInGuest(
      "(() => { const root = document.createElement('div'); root.setAttribute('data-unanchorable', ''); root.style.cssText = 'position:fixed;left:8px;top:8px;z-index:999;background:rgb(230,230,230)'; let node = root; for (let index = 0; index < 90; index += 1) { const child = document.createElement('div'); node.append(child); node = child; } node.style.cssText = 'padding:14px'; node.textContent = 'deep'; document.body.append(root); const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()",
    )) as { x: number; y: number; width: number; height: number };
    await clickNativePoint(
      unanchorableRect.x + unanchorableRect.width / 2,
      unanchorableRect.y + unanchorableRect.height / 2,
    );
    await insertNativeText("Never reaches a composer");
    await pressNativeKey("Enter");
    const kindsAfterUnanchorable = await annotationEventKinds();
    expect(kindsAfterUnanchorable).not.toContain("cancelled");
    expect(kindsAfterUnanchorable).not.toContain("committed");
    await runInGuest(
      "(() => { document.querySelector('[data-unanchorable]')?.remove(); return true; })()",
    );

    await clickNativePoint(
      targetRect.x + targetRect.width / 2,
      targetRect.y + targetRect.height / 2,
    );
    await insertNativeText("Make this action clearer");
    await pressNativeKey("Tab");
    await pressNativeKey("Enter");

    await expect
      .poll(async () => (await committedAnnotations()).length, {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe(1);

    const committedEvent = (await committedAnnotations())[0];
    expect(committedEvent?.annotation).toMatchObject({
      selector: "#manual",
      name: "Manual Playwright action",
      comment: "Make this action clearer",
      source: { url: site.appUrl },
    });
    expect(JSON.stringify(committedEvent)).not.toContain("private-annotation");

    await clickNativePoint(
      sensitiveContainerRect.x + 6,
      sensitiveContainerRect.y + sensitiveContainerRect.height / 2,
    );
    await pressNativeKey("Tab");
    await pressNativeKey("Enter");
    await expect
      .poll(async () => (await committedAnnotations()).length, {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe(2);
    const sensitiveContainerEvent = (await committedAnnotations())[1];
    expect(sensitiveContainerEvent?.annotation).toMatchObject({
      selector: "#private-editor-wrap",
      name: null,
      text: null,
    });
    expect(JSON.stringify(sensitiveContainerEvent)).not.toContain(
      "Private draft must not be captured",
    );

    // a target can become unaddressable between pick and save — must not end as cancel; the typed comment survives
    const staleRect = (await runInGuest(
      "(() => { const root = document.createElement('div'); root.setAttribute('data-stale-chain', ''); root.style.cssText = 'position:fixed;left:8px;top:8px;z-index:999;background:rgb(230,230,230)'; let node = root; for (let index = 0; index < 90; index += 1) { const child = document.createElement('div'); node.append(child); node = child; } node.id = 'stale-leaf'; node.style.cssText = 'padding:14px'; node.textContent = 'stale'; document.body.append(root); const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()",
    )) as { x: number; y: number; width: number; height: number };
    const clickStaleTarget = async (): Promise<void> => {
      await clickNativePoint(staleRect.x + staleRect.width / 2, staleRect.y + staleRect.height / 2);
    };
    await clickStaleTarget();
    await insertNativeText("Kept through a stale target");
    // dropping the id leaves a structural selector too deep for the contract's bound
    await runInGuest(
      "(() => { document.getElementById('stale-leaf')?.removeAttribute('id'); return true; })()",
    );
    await pressNativeKey("Enter");
    const kindsAfterStaleSave = await annotationEventKinds();
    expect(kindsAfterStaleSave).not.toContain("cancelled");
    expect(kindsAfterStaleSave.filter((kind) => kind === "committed")).toHaveLength(2);

    await runInGuest(
      "(() => { document.querySelector('[data-stale-chain] div:not(:has(div))').id = 'stale-leaf'; return true; })()",
    );
    await clickStaleTarget();
    await pressNativeKey("Enter");
    await expect
      .poll(async () => (await committedAnnotations()).length, {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe(3);
    const recoveredEvent = (await committedAnnotations())[2];
    expect(recoveredEvent?.annotation).toMatchObject({
      selector: "#stale-leaf",
      comment: "Kept through a stale target",
    });
    await runInGuest(
      "(() => { document.querySelector('[data-stale-chain]')?.remove(); return true; })()",
    );

    // collapsed-without-disconnect: release the element without letting Enter publish an invisible annotation
    const collapsingRect = (await runInGuest(
      "(() => { const target = document.createElement('button'); target.id = 'collapsing-target'; target.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:999;padding:14px'; target.textContent = 'collapse'; document.body.append(target); const rect = target.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()",
    )) as { x: number; y: number; width: number; height: number };
    const clickCollapsingTarget = async (): Promise<void> => {
      await clickNativePoint(
        collapsingRect.x + collapsingRect.width / 2,
        collapsingRect.y + collapsingRect.height / 2,
      );
    };
    await clickCollapsingTarget();
    await insertNativeText("Kept through a collapsed target");
    await runInGuest(
      "(() => { document.getElementById('collapsing-target').style.display = 'none'; return true; })()",
    );
    // submit immediately rather than relying on the next overlay animation frame
    await pressNativeKey("Enter");
    expect(await committedAnnotations()).toHaveLength(3);
    await runInGuest(
      "(() => { document.getElementById('collapsing-target').style.display = 'block'; return true; })()",
    );
    await clickCollapsingTarget();
    await pressNativeKey("Enter");
    await expect
      .poll(async () => (await committedAnnotations()).length, {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe(4);
    expect((await committedAnnotations())[3]?.annotation.comment).toBe(
      "Kept through a collapsed target",
    );
    await runInGuest(
      "(() => { document.getElementById('collapsing-target')?.remove(); return true; })()",
    );

    // a long ancestor id can overflow the bound while the structural path stays short — keep walking
    const fallbackSelectorRect = (await runInGuest(
      "(() => { const root = document.createElement('div'); root.id = `anchor-${'x'.repeat(490)}`; root.setAttribute('data-long-anchor', ''); root.style.cssText = 'position:fixed;right:8px;top:8px;z-index:999;background:rgb(230,230,230)'; const target = document.createElement('button'); target.style.cssText = 'padding:14px'; target.textContent = 'fallback'; root.append(target); document.body.append(root); const rect = target.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()",
    )) as { x: number; y: number; width: number; height: number };
    await clickNativePoint(
      fallbackSelectorRect.x + fallbackSelectorRect.width / 2,
      fallbackSelectorRect.y + fallbackSelectorRect.height / 2,
    );
    await insertNativeText("Fallback selector and shortcut");
    await pressNativeKey("Enter", [process.platform === "darwin" ? "meta" : "control"]);
    await expect
      .poll(async () => (await committedAnnotations()).length, {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe(5);
    const fallbackSelectorEvent = (await committedAnnotations())[4];
    expect(fallbackSelectorEvent?.annotation.comment).toBe("Fallback selector and shortcut");
    expect(fallbackSelectorEvent?.annotation.selector).not.toContain("anchor-");
    await runInGuest(
      "(() => { document.querySelector('[data-long-anchor]')?.remove(); return true; })()",
    );

    const manualClicks = await runInGuest("document.body.dataset.manualClicks");
    expect(manualClicks).toBe("0");
    const hostileCapture = await runInGuest(
      "({ capture: globalThis.__annotationHostileCapture, unexpectedKeyups: globalThis.__annotationUnexpectedKeyups })",
    );
    expect(hostileCapture).toEqual({ capture: [], unexpectedKeyups: [] });

    if (!committedEvent) throw new Error("Annotation commit event was not captured.");
    await callBrowserManager("cancelAnnotation", { threadId, tabId });
    const awayFromAnnotation = await mcp.call("browser_navigate", {
      tabId,
      url: site.nextUrl,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(awayFromAnnotation.structuredContent.finalUrl).toBe(site.nextUrl);
    const returnedToAnnotation = await mcp.call("browser_navigate", {
      tabId,
      annotationId: committedEvent.annotation.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(returnedToAnnotation.structuredContent.finalUrl).toBe(annotatedLiveUrl);

    await callBrowserManager("syncAnnotationMarkers", {
      threadId,
      tabId,
      version: 1,
      markers: [
        {
          id: committedEvent.annotation.id,
          ordinal: 1,
          documentKey: committedEvent.document.key,
          source: committedEvent.annotation.source,
          selector: committedEvent.annotation.selector,
          fingerprint: committedEvent.annotation.fingerprint,
        },
      ],
    });
    await expect
      .poll(
        async () =>
          (await annotationEvents()).some(
            (event) =>
              event.kind === "markers-synced" &&
              event.projectedMarkerIds.includes(committedEvent.annotation.id),
          ),
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .toBe(true);

    await callBrowserManager("startAnnotation", {
      threadId,
      tabId,
      theme: DARK_ANNOTATION_THEME,
    });
    const markerSyncCountBeforeHash = (await annotationEvents()).filter(
      (event) => event.kind === "markers-synced",
    ).length;
    await runInGuest(
      "history.pushState({}, '', location.pathname + location.search + '#annotation-cancelled')",
    );
    await expect
      .poll(
        async () =>
          (await annotationEvents()).some(
            (event) => event.kind === "cancelled" && event.reason === "navigation",
          ),
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .toBe(true);
    await expect
      .poll(
        async () => {
          const markerSyncs = (await annotationEvents()).filter(
            (event): event is Extract<BrowserAnnotationEvent, { kind: "markers-synced" }> =>
              event.kind === "markers-synced",
          );
          const latest = markerSyncs.at(-1);
          return (
            markerSyncs.length > markerSyncCountBeforeHash &&
            latest?.projectedMarkerIds.includes(committedEvent.annotation.id) === true
          );
        },
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .toBe(true);
    await clickNativePoint(
      targetRect.x + targetRect.width / 2,
      targetRect.y + targetRect.height / 2,
    );
    await expect
      .poll(() => runInGuest("document.body.dataset.manualClicks"), {
        timeout: 5_000,
        intervals: [25, 50, 100],
      })
      .toBe("1");
  } finally {
    await closeElectronApplication(electronApp);
    await site.close();
    rmSync(home, { recursive: true, force: true });
  }
});
