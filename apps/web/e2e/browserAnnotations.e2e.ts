import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BrowserAnnotationEvent,
  BrowserAnnotationSession,
  BrowserAnnotationTheme,
} from "@synara/contracts";
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
  const home = mkdtempSync(join(tmpdir(), "synara-browser-annotations-e2e-"));
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
    await expect(page.locator("webview")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-webview-attached", "true");

    const targetGeometry = await mcp.call("browser_evaluate", {
      expression:
        "(() => { const r = document.querySelector('#manual').getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; })()",
      idempotencyKey: crypto.randomUUID(),
    });
    const targetRect = targetGeometry.structuredContent.value as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const webviewRect = await page.locator("webview").boundingBox();
    if (!webviewRect) throw new Error("Visible annotation guest lost its bounds.");

    await expect
      .poll(
        () =>
          electronApp.evaluate(
            (_electron, input) => {
              const fixture = (
                globalThis as typeof globalThis & {
                  __synaraVisibleBrowserE2E: {
                    browserManager: {
                      startAnnotation(value: {
                        threadId: string;
                        tabId: string;
                        theme: BrowserAnnotationTheme;
                      }): BrowserAnnotationSession;
                    };
                  };
                }
              ).__synaraVisibleBrowserE2E;
              try {
                return fixture.browserManager.startAnnotation(input);
              } catch {
                return null;
              }
            },
            { threadId, tabId, theme: DARK_ANNOTATION_THEME },
          ),
        { timeout: 5_000, intervals: [25, 50, 100, 200] },
      )
      .not.toBeNull();

    await page.mouse.click(
      webviewRect.x + targetRect.x + targetRect.width / 2,
      webviewRect.y + targetRect.y + targetRect.height / 2,
    );
    await page.keyboard.type("Make this action clearer");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");

    await expect
      .poll(
        () =>
          electronApp.evaluate(() => {
            const fixture = (
              globalThis as typeof globalThis & {
                __synaraVisibleBrowserE2E: {
                  annotationEvents: BrowserAnnotationEvent[];
                };
              }
            ).__synaraVisibleBrowserE2E;
            return fixture.annotationEvents.find((event) => event.kind === "committed") ?? null;
          }),
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .not.toBeNull();

    const committedEvent = await electronApp.evaluate(() => {
      const fixture = (
        globalThis as typeof globalThis & {
          __synaraVisibleBrowserE2E: {
            annotationEvents: BrowserAnnotationEvent[];
          };
        }
      ).__synaraVisibleBrowserE2E;
      return fixture.annotationEvents.find(
        (event): event is Extract<BrowserAnnotationEvent, { kind: "committed" }> =>
          event.kind === "committed",
      );
    });
    expect(committedEvent?.annotation).toMatchObject({
      selector: "#manual",
      name: "Manual Playwright action",
      comment: "Make this action clearer",
      source: { url: site.appUrl },
    });
    expect(JSON.stringify(committedEvent)).not.toContain("private-annotation");

    const manualClicks = await electronApp.evaluate(
      (_electron, input) => {
        const fixture = (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: {
              browserManager: {
                getVisibleAutomationRuntime(value: { threadId: string; tabId: string }): {
                  webContents: {
                    executeJavaScript(script: string): Promise<string | undefined>;
                  };
                };
              };
            };
          }
        ).__synaraVisibleBrowserE2E;
        return fixture.browserManager
          .getVisibleAutomationRuntime(input)
          .webContents.executeJavaScript("document.body.dataset.manualClicks");
      },
      { threadId, tabId },
    );
    expect(manualClicks).toBe("0");
    const hostileCapture = await electronApp.evaluate(
      (_electron, input) => {
        const fixture = (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: {
              browserManager: {
                getVisibleAutomationRuntime(value: { threadId: string; tabId: string }): {
                  webContents: {
                    executeJavaScript(script: string): Promise<unknown>;
                  };
                };
              };
            };
          }
        ).__synaraVisibleBrowserE2E;
        return fixture.browserManager
          .getVisibleAutomationRuntime(input)
          .webContents.executeJavaScript(
            "({ capture: globalThis.__annotationHostileCapture, unexpectedKeyups: globalThis.__annotationUnexpectedKeyups })",
          );
      },
      { threadId, tabId },
    );
    expect(hostileCapture).toEqual({ capture: [], unexpectedKeyups: [] });

    if (!committedEvent) throw new Error("Annotation commit event was not captured.");
    await electronApp.evaluate(
      (_electron, input) => {
        const fixture = (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: {
              browserManager: {
                cancelAnnotation(value: typeof input): void;
              };
            };
          }
        ).__synaraVisibleBrowserE2E;
        fixture.browserManager.cancelAnnotation(input);
      },
      { threadId, tabId },
    );
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

    await electronApp.evaluate(
      (_electron, input) => {
        const fixture = (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: {
              browserManager: {
                syncAnnotationMarkers(value: typeof input): void;
              };
            };
          }
        ).__synaraVisibleBrowserE2E;
        fixture.browserManager.syncAnnotationMarkers(input);
      },
      {
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
      },
    );
    await expect
      .poll(
        () =>
          electronApp.evaluate((_, annotationId) => {
            const fixture = (
              globalThis as typeof globalThis & {
                __synaraVisibleBrowserE2E: {
                  annotationEvents: BrowserAnnotationEvent[];
                };
              }
            ).__synaraVisibleBrowserE2E;
            return fixture.annotationEvents.some(
              (event) =>
                event.kind === "markers-synced" && event.projectedMarkerIds.includes(annotationId),
            );
          }, committedEvent.annotation.id),
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .toBe(true);

    await electronApp.evaluate(
      (_electron, input) => {
        const fixture = (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: {
              browserManager: {
                startAnnotation(value: {
                  threadId: string;
                  tabId: string;
                  theme: BrowserAnnotationTheme;
                }): BrowserAnnotationSession;
              };
            };
          }
        ).__synaraVisibleBrowserE2E;
        fixture.browserManager.startAnnotation(input);
      },
      { threadId, tabId, theme: DARK_ANNOTATION_THEME },
    );
    await electronApp.evaluate(
      (_electron, input) => {
        const fixture = (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: {
              browserManager: {
                getVisibleAutomationRuntime(value: { threadId: string; tabId: string }): {
                  webContents: {
                    executeJavaScript(script: string): Promise<unknown>;
                  };
                };
              };
            };
          }
        ).__synaraVisibleBrowserE2E;
        return fixture.browserManager
          .getVisibleAutomationRuntime(input)
          .webContents.executeJavaScript("history.pushState({}, '', '/app#annotation-cancelled')");
      },
      { threadId, tabId },
    );
    await expect
      .poll(
        () =>
          electronApp.evaluate(() => {
            const fixture = (
              globalThis as typeof globalThis & {
                __synaraVisibleBrowserE2E: {
                  annotationEvents: BrowserAnnotationEvent[];
                };
              }
            ).__synaraVisibleBrowserE2E;
            return fixture.annotationEvents.some(
              (event) => event.kind === "cancelled" && event.reason === "navigation",
            );
          }),
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .toBe(true);
    await page.mouse.click(
      webviewRect.x + targetRect.x + targetRect.width / 2,
      webviewRect.y + targetRect.y + targetRect.height / 2,
    );
    await expect
      .poll(
        () =>
          electronApp.evaluate(
            (_electron, input) => {
              const fixture = (
                globalThis as typeof globalThis & {
                  __synaraVisibleBrowserE2E: {
                    browserManager: {
                      getVisibleAutomationRuntime(value: { threadId: string; tabId: string }): {
                        webContents: {
                          executeJavaScript(script: string): Promise<string | undefined>;
                        };
                      };
                    };
                  };
                }
              ).__synaraVisibleBrowserE2E;
              return fixture.browserManager
                .getVisibleAutomationRuntime(input)
                .webContents.executeJavaScript("document.body.dataset.manualClicks");
            },
            { threadId, tabId },
          ),
        { timeout: 5_000, intervals: [25, 50, 100] },
      )
      .toBe("1");
  } finally {
    await closeElectronApplication(electronApp);
    await site.close();
    rmSync(home, { recursive: true, force: true });
  }
});
