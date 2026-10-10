import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_TOOL_NAMES, type ThreadBrowserState, type ThreadId } from "@synara/contracts";
import type { WebContents } from "electron";
import { _electron as electron, expect, test, type ElectronApplication } from "playwright/test";
import type { DesktopBrowserManager } from "../../desktop/src/browserManager";

import { createBrowserMcpHarness } from "./fixtures/mcpBrowserHarness";
import { startVisibleBrowserFixtureSite } from "./fixtures/siteServer";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_DIR, "../..");
const DESKTOP_DIR = resolve(REPO_ROOT, "apps/desktop");
const requireFromDesktop = createRequire(resolve(DESKTOP_DIR, "package.json"));

function key(): string {
  return crypto.randomUUID();
}

function waitForSettlement(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    void promise.finally(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function closeElectronApplication(application: ElectronApplication): Promise<void> {
  let closeError: unknown;
  const closing = application.close().catch((error: unknown) => {
    closeError = error;
  });
  if (!(await waitForSettlement(closing, 5_000))) {
    // A failed browser command must not obscure its own assertion by leaving a
    // wedged Electron process in Playwright teardown forever.
    application.process().kill("SIGKILL");
    await waitForSettlement(closing, 2_000);
  }
  if (closeError) throw closeError;
}

async function launchVisibleBrowserFixture() {
  const mainPath = process.env.SYNARA_E2E_ELECTRON_MAIN;
  if (!mainPath) throw new Error("Electron E2E main bundle was not prepared.");
  const site = await startVisibleBrowserFixtureSite();
  const home = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "synara-mcp-"));
  const workspaceRoot = join(home, "workspace");
  mkdirSync(workspaceRoot);
  const pipePath = join(home, "browser-host.sock");
  const capability = `visible-browser-e2e-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const threadId = `thread-visible-browser-${crypto.randomUUID()}`;
  const shellPath = resolve(WEB_DIR, "e2e/fixtures/visibleBrowserShell.html");
  const executablePath = requireFromDesktop("electron") as string;
  const electronApp = await electron
    .launch({
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
      },
    })
    .catch(async (error: unknown) => {
      await site.close();
      rmSync(home, { recursive: true, force: true });
      throw error;
    });

  return {
    electronApp,
    site,
    home,
    workspaceRoot,
    pipePath,
    capability,
    threadId,
    async close() {
      try {
        await closeElectronApplication(electronApp);
      } finally {
        await site.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

test("production MCP controls one persistent Electron page across visibility changes", async () => {
  const fixture = await launchVisibleBrowserFixture();
  const { electronApp, site, home, workspaceRoot, pipePath, capability, threadId } = fixture;
  try {
    writeFileSync(join(workspaceRoot, "fixture-upload.txt"), "visible-browser-upload\n", "utf8");
    writeFileSync(join(home, "outside-workspace.txt"), "must-not-upload\n", "utf8");
    symlinkSync(join(home, "outside-workspace.txt"), join(workspaceRoot, "outside-link.txt"));

    const page = await electronApp.firstWindow();
    await expect(page.locator("html")).toHaveAttribute("data-shell-ready", "true");
    const runtimeDetails = (scopedTabId: string) =>
      electronApp.evaluate(
        (_electron, input) => {
          const state = (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: {
                browserManager: {
                  runtimes: Map<string, { webContents: { id: number; getURL(): string } }>;
                };
              };
            }
          ).__synaraVisibleBrowserE2E;
          const runtime = state.browserManager.runtimes.get(`${input.threadId}:${input.tabId}`);
          if (!runtime) throw new Error("Expected the native browser runtime to be live.");
          return { id: runtime.webContents.id, url: runtime.webContents.getURL() };
        },
        { threadId, tabId: scopedTabId },
      );
    const sendNativeInput = (scopedTabId: string, event: Record<string, unknown>) =>
      electronApp.evaluate(
        (_electron, input) => {
          const state = (
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
          ).__synaraVisibleBrowserE2E;
          const runtime = state.browserManager.runtimes.get(`${input.threadId}:${input.tabId}`);
          if (!runtime) throw new Error("Expected the native browser runtime to be live.");
          runtime.webContents.sendInputEvent(input.event);
        },
        { threadId, tabId: scopedTabId, event },
      );

    const mcp = createBrowserMcpHarness({
      pipePath,
      capability,
      threadId,
      workspaceRoot,
    });

    const initialized = await mcp.initialize();
    expect(initialized.protocolVersion).toBe("2025-06-18");
    expect((await mcp.listTools()).map((tool) => tool.name)).toEqual([
      ...BROWSER_TOOL_NAMES,
      "synara_e2e_review",
    ]);
    const guidance = await mcp.call("synara_e2e_review");
    expect(JSON.stringify(guidance.content)).toMatch(/subagent/i);
    expect(JSON.stringify(guidance.content)).toContain("proof");

    const run = (code: string, timeoutMs = 10_000) =>
      mcp.call("browser_run", { code, timeoutMs, idempotencyKey: key() });
    const read = async (expression: string) =>
      (await run(`return await page.evaluate(() => (${expression}));`)).structuredContent.value;
    const waitForText = (value: string) =>
      run(
        `await page.getByText(${JSON.stringify(value)}).waitFor({state:"visible"}); return true;`,
      );
    const click = (name: string) =>
      run(
        `await human.click(page.getByRole("button", {name:${JSON.stringify(name)},exact:true})); return true;`,
      );

    expect((await mcp.call("browser_status")).structuredContent).toMatchObject({
      available: true,
      physicalScope: "visible-shared-electron-webview",
      authorization: "not-required",
    });
    const opened = await mcp.call("browser_open", {
      url: site.initialUrl,
      show: true,
      reuse: true,
    });
    const tabId = String(opened.structuredContent.tabId);
    await expect(page.locator("html")).toHaveAttribute("data-native-runtime-tab-id", tabId);
    const initialRuntime = await runtimeDetails(tabId);
    expect(initialRuntime.url).toBe(site.initialUrl);

    await test.step("keeps the same native page while hidden and navigating", async () => {
      await electronApp.evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: { setPanelRevealEnabled(enabled: boolean): void };
          }
        ).__synaraVisibleBrowserE2E.setPanelRevealEnabled(false);
      });
      await run(
        'return await page.evaluate(() => document.body.dataset.backgroundAgent = "continued");',
      );
      expect(await read("document.body.dataset.backgroundAgent")).toBe("continued");
      expect((await runtimeDetails(tabId)).id).toBe(initialRuntime.id);
      await electronApp.evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: { setPanelRevealEnabled(enabled: boolean): void };
          }
        ).__synaraVisibleBrowserE2E.setPanelRevealEnabled(true);
      });
      const navigated = await mcp.call("browser_navigate", { url: site.appUrl });
      expect(navigated.structuredContent).toMatchObject({ tabId, finalUrl: site.appUrl });
      await run(
        `return await page.evaluate(() => { location.href = ${JSON.stringify(site.nextUrl)}; return true; });`,
      );
      await run(`await page.waitForURL(${JSON.stringify(site.nextUrl)}); return true;`);
      expect((await runtimeDetails(tabId)).url).toBe(site.nextUrl);
      expect((await runtimeDetails(tabId)).id).toBe(initialRuntime.id);
      await mcp.call("browser_navigate", { tabId, url: site.appUrl });
      expect(await read("document.body.dataset.agentClicks")).toBe("0");
    });

    await test.step("returns bounded observations and durable screenshot proof", async () => {
      const resized = await mcp.call("browser_resize", { width: 760, height: 520 });
      expect(resized.structuredContent).toMatchObject({
        tabId,
        requested: { width: 760, height: 520 },
        observed: { height: 520 },
      });
      expect(
        (resized.structuredContent.observed as { width: number }).width,
      ).toBeGreaterThanOrEqual(740);
      await waitForText("Delayed fixture ready");
      const observed = await run("return await snapshot({interactive:true});");
      expect(observed.content.some((item) => item.type === "image")).toBe(false);
      expect(JSON.stringify(observed.structuredContent.value)).toContain("Shared input");
      for (const fullPage of [false, true]) {
        const screenshot = await mcp.call("browser_screenshot", { fullPage, kind: "proof" });
        expect(screenshot.structuredContent).toMatchObject({
          tabId,
          mode: fullPage ? "fullPage" : "viewport",
          image: { mimeType: "image/png" },
        });
        const png = screenshot.content.find((item) => item.type === "image");
        const bytes = Buffer.from(String(png?.data), "base64");
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const artifactPath = String(screenshot.structuredContent.artifactPath);
        expect(artifactPath.startsWith(join(workspaceRoot, "proof"))).toBe(true);
        expect(readFileSync(artifactPath)).toEqual(bytes);
        if (fullPage)
          expect((screenshot.structuredContent.image as { height: number }).height).toBeGreaterThan(
            2000,
          );
      }
    });

    await test.step("performs trusted hover, select, workspace upload and drag", async () => {
      await run(
        'await page.getByRole("button",{name:"Reveal hover state",exact:true}).hover(); return true;',
      );
      expect(
        await read(
          '({visibility:getComputedStyle(document.querySelector("#hover-result")).visibility,trusted:document.querySelector("#hover-result").dataset.trusted})',
        ),
      ).toEqual({ visibility: "visible", trusted: "true" });
      await run(
        'await page.getByLabel("Fixture choice",{exact:true}).selectOption("beta"); return true;',
      );
      await waitForText("Selected: beta");
      const target = { locator: { kind: "label", text: "Fixture upload", exact: true } };
      const uploaded = await mcp.call("browser_upload", { target, paths: ["fixture-upload.txt"] });
      expect(uploaded.structuredContent.files).toEqual([
        { name: "fixture-upload.txt", byteLength: 23 },
      ]);
      await waitForText("Uploaded: fixture-upload.txt:23");
      await expect(
        mcp.call("browser_upload", { target, paths: ["outside-link.txt"] }),
      ).rejects.toThrow(/BrowserUploadPathOutsideWorkspace/);
      await run('await page.locator("#drop-target").scrollIntoViewIfNeeded(); return true;');
      await run(
        'await page.locator("#drag-source").dragTo(page.locator("#drop-target"), {steps:8}); return true;',
      );
      const dragState = await read(
        '({state:document.querySelector("#drag-state").textContent,start:document.body.dataset.dragstart,end:document.body.dataset.dragend,drop:document.body.dataset.drop,down:document.body.dataset.dragMousedown,move:document.body.dataset.dragMousemove,buttons:document.body.dataset.dragButtons,focused:document.hasFocus(),source:document.querySelector("#drag-source").getBoundingClientRect().toJSON(),target:document.querySelector("#drop-target").getBoundingClientRect().toJSON()})',
      );
      expect(dragState, JSON.stringify(dragState)).toMatchObject({ state: "Dragged: yes" });
      await waitForText("Dragged: yes");
    });

    await test.step("handles dialogs, excludes network secrets and blocks downloads", async () => {
      for (const [name, kind, action, result] of [
        ["Open alert dialog", "alert", "accepted", "alert-continued"],
        ["Open confirm dialog", "confirm", "dismissed", "confirm-false"],
        ["Open prompt dialog", "prompt", "dismissed", "prompt-null"],
      ]) {
        const clicked = await click(name!);
        expect(clicked.structuredContent.dialogs).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind, action })]),
        );
        await waitForText(`Dialog result: ${result}`);
      }
      await click("Emit fixture logs");
      await run(
        'await page.locator("body[data-logs-emitted=true]").waitFor({state:"attached"}); return true;',
      );
      const logs = JSON.stringify(
        (await mcp.call("browser_logs", { limit: 200 })).structuredContent,
      );
      expect(logs).toContain("Fixture console warning");
      expect(logs).toContain("/api/fixture");
      expect(logs).not.toContain("SECRET_HEADER_MUST_NOT_LEAK");
      expect(logs).not.toContain("SECRET_BODY_MUST_NOT_LEAK");
      await expect(
        run(
          'await human.click(page.getByRole("link",{name:"Download fixture",exact:true})); return true;',
        ),
      ).rejects.toThrow(/BrowserDownloadApprovalRequired/);
      // Give a broken block time to write the file before asserting it never
      // appeared; an immediate check would pass a regression that downloads
      // slightly late.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(join(home, "Downloads", "fixture-download.txt"))).toBe(false);
    });

    await test.step("keeps OAuth and target-blank popups inside the app", async () => {
      for (const [name, url, role] of [
        ["Open OAuth popup", "/oauth", "button"],
        ["Open fixture tab", "/popup", "link"],
      ]) {
        await run(
          `await human.click(page.getByRole(${JSON.stringify(role)},{name:${JSON.stringify(name)},exact:true})); return true;`,
        );
        const tabs = (await mcp.call("browser_tabs")).structuredContent;
        expect(tabs.tabs).toHaveLength(2);
        const popupTab = (tabs.tabs as { tabId: string; url: string }[]).find(
          (tab) => tab.tabId !== tabId,
        );
        expect(popupTab).toBeDefined();
        const popupTabId = popupTab!.tabId;
        await mcp.call("browser_run", { tabId: popupTabId, code: "return page.url();" });
        await expect
          .poll(async () => (await runtimeDetails(popupTabId)).url)
          .toBe(new URL(url!, site.appUrl).href);
        expect(
          await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        ).toBe(1);
        expect(tabs.activeTabId).toBe(popupTabId);
        const closed = await mcp.call("browser_close", { tabId: popupTabId });
        expect(closed.structuredContent).toMatchObject({
          closedTabId: popupTabId,
          activeTabId: tabId,
        });
        await expect(page.locator("html")).toHaveAttribute("data-native-runtime-tab-id", tabId);
      }
    });

    await test.step("preserves history and rejects unsupported navigation", async () => {
      await mcp.call("browser_navigate", { tabId, url: site.nextUrl, waitUntil: "load" });
      expect((await mcp.call("browser_back", { tabId })).structuredContent.finalUrl).toBe(
        site.appUrl,
      );
      expect((await mcp.call("browser_forward", { tabId })).structuredContent.finalUrl).toBe(
        site.nextUrl,
      );
      expect(
        (await mcp.call("browser_reload", { tabId, ignoreCache: true })).structuredContent.finalUrl,
      ).toBe(site.nextUrl);
      const redirected = await mcp.call("browser_navigate", { tabId, url: site.redirectUrl });
      expect(redirected.structuredContent.finalUrl).toBe(site.nextUrl);
      expect(redirected.structuredContent.redirects).toContain(site.redirectUrl);
      await expect(
        mcp.call("browser_navigate", { tabId, url: "file:///etc/passwd" }),
      ).rejects.toThrow(/BrowserNavigationBlocked/);
      await mcp.call("browser_navigate", { tabId, url: site.appUrl });
      // Locator clicks enforce actionability; human.click is a lower-level pointer operation.
      for (const name of ["Disabled action", "Covered action"]) {
        await expect(
          run(
            `await page.getByRole("button",{name:${JSON.stringify(name)},exact:true}).click({timeout:500}); return true;`,
          ),
        ).rejects.toThrow(/BrowserEvaluationFailed|BrowserTimeout/);
      }
      expect(await read("document.body.dataset.agentClicks")).toBe("0");
    });

    await test.step("keeps native input in the guest and returns compact observations", async () => {
      await run(
        'return await page.evaluate(() => { document.querySelector("#state").setAttribute("data-unrelated-mutation","true"); return true; });',
      );
      await click("Commit agent action");
      const point = (await read(
        '(() => {const r=document.querySelector("#point").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()',
      )) as { x: number; y: number };
      await run(`await page.mouse.click(${point.x},${point.y}); return true;`);
      await waitForText("Point clicks: 1");
      await run(
        'return await page.evaluate(() => {const fragment=document.createDocumentFragment();for(let i=0;i<300;i++){const button=document.createElement("button");button.textContent="Offscreen action "+i;button.style.cssText="position:absolute;top:"+(1000+i*36)+"px";fragment.append(button);}document.body.append(fragment);return true;});',
      );
      const compact = await run('return await snapshot({interactive:true,selector:"main"});');
      expect(Buffer.byteLength(JSON.stringify(compact.structuredContent))).toBeLessThan(36_000);
      const hostComposer = page.getByLabel("Host composer");
      await electronApp.evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: { setPreviewEnabled(enabled: boolean): void };
          }
        ).__synaraVisibleBrowserE2E.setPreviewEnabled(true);
      });
      await hostComposer.fill("HOST_SENTINEL");
      await hostComposer.focus();
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.focus(),
      );
      await run(
        'await page.getByLabel("Shared input",{exact:true}).fill("direct-filled"); return true;',
      );
      await expect(hostComposer).toHaveValue("HOST_SENTINEL");
      expect(await read('document.querySelector("input").value')).toBe("direct-filled");
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
      try {
        const hiddenProof = await mcp.call("browser_screenshot", {
          kind: "proof",
          fullPage: false,
          timeoutMs: 3000,
        });
        expect(hiddenProof.content.some((block) => block.type === "image")).toBe(true);
      } finally {
        await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show());
      }
      await electronApp.evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: { setPreviewEnabled(enabled: boolean): void };
          }
        ).__synaraVisibleBrowserE2E.setPreviewEnabled(false);
      });
      await hostComposer.focus();
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.focus(),
      );
      await run(
        'await human.type(page.getByLabel("Shared input",{exact:true}),"shared-through-mcp",{clear:true}); return true;',
      );
      await expect(hostComposer).toHaveValue("HOST_SENTINEL");
      await run('await page.keyboard.press("ControlOrMeta+A"); return true;');
      await run('await page.keyboard.press("Backspace"); return true;');
      await run('await page.keyboard.press("x"); return true;');
      expect(await read('document.querySelector("input").value')).toBe("x");
      await run(
        'await human.type(page.getByLabel("Shared input",{exact:true}),"shared-through-mcp",{clear:true}); return true;',
      );
      await run('await page.keyboard.press("Enter"); return true;');
      await expect(hostComposer).toHaveValue("HOST_SENTINEL");
      await expect(page.locator("html")).toHaveAttribute("data-host-submits", "0");
      await run("await human.scroll({deltaY:1000,deltaX:0}); return true;");
      await expect.poll(() => read("scrollY")).toBeGreaterThan(0);
    });

    await test.step("shares the system clipboard without granting website reads", async () => {
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
      await run('await page.getByRole("button",{name:"Copy synthetic text",exact:true}).click();');
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show());
      await expect.poll(() => read('document.querySelector("#copy").dataset.copied')).toBe("true");
      expect(
        await electronApp.evaluate(
          ({ clipboard }) => clipboard.readText() === "synthetic-browser-copy",
        ),
      ).toBe(true);
      if (process.platform === "darwin")
        expect(
          execFileSync("/usr/bin/pbpaste", { encoding: "utf8" }) === "synthetic-browser-copy",
        ).toBe(true);
      await electronApp.evaluate(({ clipboard }) => clipboard.writeText("synthetic-shell-copy"));
      await run('await page.getByLabel("Shared input",{exact:true}).fill("");');
      await run('await page.keyboard.press("ControlOrMeta+V");');
      expect(await read('document.querySelector("input").value')).toBe("synthetic-shell-copy");
      await run('await page.keyboard.press("ControlOrMeta+A");');
      await run('await page.keyboard.press("ControlOrMeta+X");');
      expect(await read('document.querySelector("input").value')).toBe("");
      expect(
        await electronApp.evaluate(
          ({ clipboard }) => clipboard.readText() === "synthetic-shell-copy",
        ),
      ).toBe(true);
      expect(await read("navigator.clipboard.readText().then(() => false, () => true)")).toBe(true);
      await electronApp.evaluate(({ clipboard }) => clipboard.clear());
      await run('await page.getByLabel("Shared input",{exact:true}).fill("shared-through-mcp");');
    });

    await test.step("does not mistake zoomed automated clicks for human input", async () => {
      for (const factor of [0.5, 1.25, 1]) {
        await electronApp.evaluate((_, value) => {
          (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: { setPageZoomFactor(value: number): void };
            }
          ).__synaraVisibleBrowserE2E.setPageZoomFactor(value);
        }, factor);
        await run(
          'await human.click(page.getByRole("button",{name:"Commit point action",exact:true}));',
        );
      }
    });

    await test.step("yields to human input and recovers after MCP cancellation", async () => {
      await sendNativeInput(tabId, { type: "mouseMove", x: 30, y: 30 });
      for (let step = 0; step < 32; step++)
        await sendNativeInput(tabId, {
          type: "mouseWheel",
          x: 30,
          y: 30,
          deltaY: 1000,
          canScroll: true,
        });
      await expect.poll(() => read("scrollY"), { timeout: 3000 }).toBe(0);
      const rect = (await read(
        '(() => {const r=document.querySelector("#manual").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()',
      )) as { x: number; y: number };
      const interrupted = run(
        'await page.getByText("Human takeover sentinel never appears").waitFor(); return true;',
        5000,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const point = { x: Math.round(rect.x), y: Math.round(rect.y) };
      await sendNativeInput(tabId, { type: "mouseMove", ...point });
      await sendNativeInput(tabId, { type: "mouseDown", ...point, button: "left", clickCount: 1 });
      await sendNativeInput(tabId, { type: "mouseUp", ...point, button: "left", clickCount: 1 });
      expect(String(await interrupted)).toContain("BrowserInterruptedByHuman");
      await waitForText("Manual clicks: 1");
      expect(
        await read(
          '({value:document.querySelector("input").value,agentClicks:document.body.dataset.agentClicks,pointClicks:document.body.dataset.pointClicks,manualClicks:document.body.dataset.manualClicks,presses:document.body.dataset.presses,cookie:document.cookie})',
        ),
      ).toEqual({
        value: "shared-through-mcp",
        agentClicks: "1",
        pointClicks: "4",
        manualClicks: "1",
        presses: "1",
        cookie: expect.stringContaining("shared_cookie=agent"),
      });
      await mcp.cancelCall("browser_run", {
        code: 'await page.getByText("Cancellation sentinel never appears").waitFor(); return true;',
        timeoutMs: 10_000,
      });
      expect(await read("document.title")).toBe("Visible browser fixture");
      const tabs = (await mcp.call("browser_tabs")).structuredContent;
      expect(tabs).toMatchObject({ activeTabId: tabId, assignedTabId: tabId });
      expect(tabs.tabs).toEqual([
        expect.objectContaining({ tabId, active: true, routable: true, state: "live" }),
      ]);
      expect((await mcp.call("browser_close")).structuredContent).toEqual({
        closedTabId: tabId,
        activeTabId: null,
      });
      expect((await mcp.call("browser_tabs")).structuredContent).toMatchObject({
        assignedTabId: null,
        activeTabId: null,
        tabs: [],
      });
      expect(
        await electronApp.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __synaraVisibleBrowserE2E: { browserManager: { runtimes: Map<string, unknown> } };
              }
            ).__synaraVisibleBrowserE2E.browserManager.runtimes.size,
        ),
      ).toBe(0);
    });
    await test.step("captures proof before the renderer mounts the browser panel", async () => {
      await electronApp.evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: { setPanelRevealEnabled(enabled: boolean): void };
          }
        ).__synaraVisibleBrowserE2E.setPanelRevealEnabled(false);
      });
      try {
        await mcp.call("browser_open", { url: site.appUrl, show: true });
        const previewPixels = await electronApp.evaluate(async ({ nativeImage }) => {
          const state = (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: {
                threadId: string;
                setPreviewEnabled(enabled: boolean): void;
                setPanelRevealEnabled(enabled: boolean): void;
                browserManager: {
                  getState(input: { threadId: string }): { activeTabId: string };
                  capturePreview(input: {
                    threadId: string;
                    tabId: string;
                  }): Promise<string | null>;
                };
              };
            }
          ).__synaraVisibleBrowserE2E;
          state.setPreviewEnabled(true);
          try {
            const { activeTabId } = state.browserManager.getState({ threadId: state.threadId });
            const data = await state.browserManager.capturePreview({
              threadId: state.threadId,
              tabId: activeTabId,
            });
            const image = nativeImage.createFromDataURL(data ?? "");
            const bitmap = image.toBitmap();
            let varied = false;
            for (let offset = 4; offset < bitmap.length; offset += 4) {
              if (!bitmap.subarray(offset, offset + 4).equals(bitmap.subarray(0, 4))) {
                varied = true;
                break;
              }
            }
            return { empty: image.isEmpty(), width: image.getSize().width, varied };
          } finally {
            state.setPreviewEnabled(false);
            state.setPanelRevealEnabled(false);
          }
        });
        expect(previewPixels).toEqual({ empty: false, width: 640, varied: true });
        await mcp.call("browser_close");
        for (const fullPage of [true, false]) {
          await mcp.call("browser_open", { url: site.appUrl, show: true });
          const layerOrder = await electronApp.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0]!;
            return {
              count: window.contentView.children.length,
              backgroundVisible: window.contentView.children[0]!.getVisible(),
              backgroundBounds: window.contentView.children[0]!.getBounds(),
            };
          });
          expect(layerOrder.count).toBe(1);
          expect(layerOrder.backgroundVisible).toBe(false);
          expect(layerOrder.backgroundBounds).toMatchObject({ x: 0, y: 0 });
          const viewport = (await read(
            "({width:innerWidth,height:innerHeight,scale:devicePixelRatio})",
          )) as { width: number; height: number; scale: number };
          expect(viewport).toMatchObject({ width: 1280, height: 800 });
          await run(
            'await human.click(page.getByRole("button",{name:"Commit agent action",exact:true})); return true;',
            3000,
          );
          expect(await read("document.body.dataset.agentClicks")).toBe("1");
          const proof = await mcp.call("browser_screenshot", {
            kind: "proof",
            fullPage,
            timeoutMs: 3000,
          });
          expect(proof.content.some((block) => block.type === "image")).toBe(true);
          expect(proof.structuredContent.image).toMatchObject({
            width: 1280 * viewport.scale,
            height: (fullPage ? 2600 : 800) * viewport.scale,
          });
          const pixels = await electronApp.evaluate(({ nativeImage }, artifactPath) => {
            const image = nativeImage.createFromPath(artifactPath);
            const bitmap = image.toBitmap();
            let varied = false;
            for (let offset = 4; offset < bitmap.length; offset += 4) {
              if (!bitmap.subarray(offset, offset + 4).equals(bitmap.subarray(0, 4))) {
                varied = true;
                break;
              }
            }
            return { empty: image.isEmpty(), varied };
          }, String(proof.structuredContent.artifactPath));
          expect(pixels).toEqual({ empty: false, varied: true });
          expect(
            await electronApp.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0]!.contentView.children[0]!.getVisible(),
            ),
          ).toBe(false);
          await page.getByLabel("Host composer").click();
          await page.keyboard.type("hidden-page-safe");
          await expect(page.getByLabel("Host composer")).toHaveValue(
            "HOST_SENTINELhidden-page-safe",
          );
          await page.getByLabel("Host composer").fill("HOST_SENTINEL");
          expect(await read('document.querySelector("input").value')).toBe("");
          await mcp.call("browser_close");
        }
      } finally {
        await electronApp.evaluate(() => {
          (
            globalThis as typeof globalThis & {
              __synaraVisibleBrowserE2E: { setPanelRevealEnabled(enabled: boolean): void };
            }
          ).__synaraVisibleBrowserE2E.setPanelRevealEnabled(true);
        });
      }
    });

    await test.step("isolates renderer webview input from the host composer", async () => {
      await electronApp.evaluate((_electron, url) => {
        const fixture = (
          globalThis as typeof globalThis & {
            __synaraVisibleBrowserE2E: {
              threadId: string;
              browserManager: {
                open(input: { threadId: string }): unknown;
                newTab(input: { threadId: string; url: string }): unknown;
              };
              setSurface(value: "native" | "renderer"): void;
            };
          }
        ).__synaraVisibleBrowserE2E;
        fixture.browserManager.open({ threadId: fixture.threadId });
        fixture.browserManager.newTab({ threadId: fixture.threadId, url });
        fixture.setSurface("native");
        fixture.setSurface("renderer");
      }, site.appUrl);
      await expect(page.locator("html")).toHaveAttribute("data-webview-attached", "true");
      await mcp.call("browser_open", { url: site.appUrl, show: true });
      const composer = page.getByLabel("Host composer");
      await composer.fill("HOST_SENTINEL");
      await composer.focus();
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.focus(),
      );
      await run(
        'await page.getByLabel("Shared input",{exact:true}).fill("guest-only"); return true;',
      );
      await expect(composer).toHaveValue("HOST_SENTINEL");
      expect(await read('document.querySelector("input").value')).toBe("guest-only");
      expect(await read("document.body.dataset.inputTrusted")).toBe("true");
      await run(
        'await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.press("Backspace"); await page.keyboard.press("x"); return true;',
      );
      await expect(composer).toHaveValue("HOST_SENTINEL");
      expect(await read('document.querySelector("input").value')).toBe("x");
      await run('await page.keyboard.press("Enter"); return true;');
      await expect(page.locator("html")).toHaveAttribute("data-host-submits", "0");
    });

    await test.step("explains invalid sandbox APIs and recovers sign-in button clicks", async () => {
      const signinUrl = new URL("/signin", site.initialUrl).href;
      await mcp.call("browser_navigate", { url: signinUrl });
      for (const code of [
        'await human.click(getByRole("button",{name:"Log In",exact:true}));',
        'await getByRole("button",{name:"Log In",exact:true}).click();',
        'await human.click(getByRole("button",{name:"Continue with Google"}));',
        "return await page.snapshot({interactive:true});",
        'return Array.from(document.querySelectorAll("button"));',
        "await waitForTimeout(400);",
      ]) {
        await expect(run(code)).rejects.toThrow("BrowserScriptApiUnavailable");
      }
      expect(
        (await run('return await page.locator("#mode").innerText();')).structuredContent.value,
      ).toBe("Sign Up selected");
      await run('await human.click(page.getByRole("button",{name:"Log In",exact:true}));');
      expect(
        (await run('return await page.locator("#mode").innerText();')).structuredContent.value,
      ).toBe("Log In selected");
      const partial = await run(
        'await page.getByRole("button",{name:"Continue with Google"}).click(); return location.href;',
      ).catch((error: unknown) => error);
      expect(String(partial)).toContain("BrowserScriptApiUnavailable");
      expect(String(partial)).toContain('\\"effectMayHaveCommitted\\":true');
      expect(
        (await run('return await page.locator("#mode").innerText();')).structuredContent.value,
      ).toBe("Google selected");
      expect((await run("return await page.url();")).structuredContent.value).toBe(signinUrl);
      expect(
        (await run("return await page.evaluate(() => document.title);")).structuredContent.value,
      ).toBe("Sign-in fixture");
      await expect(page.getByLabel("Host composer")).toHaveValue("HOST_SENTINEL");
    });

    await test.step("preserves empty and falsy browser results", async () => {
      for (const value of [[], {}, null, false, 0, "", { accounts: [], next: null }]) {
        const result = await run(`return ${JSON.stringify(value)};`);
        expect(result.structuredContent.value).toEqual(value);
      }
      const emptyLocators = await run(
        'return await page.getByRole("link",{name:"No such fixture link"}).allTextContents();',
      );
      expect(emptyLocators.structuredContent.value).toEqual([]);
    });
    await test.step("follows a client redirect before the first document finishes loading", async () => {
      const result = await mcp.call("browser_open", {
        url: new URL("/client-redirect", site.appUrl).href,
        reuse: false,
        timeoutMs: 3000,
      });
      expect(result.structuredContent.finalUrl).toBe(site.nextUrl);
      expect(result.structuredContent.loadState).not.toBe("commit");
    });
    await test.step("rejects a stale renderer handoff without replacing the agent's native page", async () => {
      const result = await page.evaluate(async (url) => {
        const { ipcRenderer } = (
          window as unknown as {
            require(name: string): {
              ipcRenderer: { invoke(channel: string, input: unknown): Promise<ThreadBrowserState> };
            };
          }
        ).require("electron");
        const guest = document.createElement("webview") as HTMLElement & {
          getWebContentsId(): number;
        };
        guest.setAttribute("partition", "persist:synara-browser");
        guest.setAttribute("src", url);
        const ready = new Promise<void>((resolve) =>
          guest.addEventListener("dom-ready", () => resolve(), { once: true }),
        );
        document.body.append(guest);
        try {
          await ready;
          const tabId = document.documentElement.dataset.nativeRuntimeTabId;
          return await ipcRenderer.invoke("synara-e2e:attach-webview", {
            tabId,
            webContentsId: guest.getWebContentsId(),
          });
        } finally {
          guest.remove();
        }
      }, site.appUrl);
      expect(result.tabs.find((tab) => tab.id === result.activeTabId)?.runtimeSurface).toBe(
        "native",
      );
      expect((await run("return await page.url();")).structuredContent.value).toBe(site.nextUrl);
    });
  } finally {
    await fixture.close();
  }
});

type FocusFixtureGlobals = typeof globalThis & {
  __synaraVisibleBrowserE2E: {
    browserManager: DesktopBrowserManager;
    threadId: ThreadId;
    setPreviewEnabled(enabled: boolean): void;
    setSurface(surface: "native" | "renderer"): void;
  };
};

test("preserves composer keyboard ownership during browser navigation", async () => {
  const fixture = await launchVisibleBrowserFixture();
  const { electronApp, site } = fixture;
  try {
    const page = await electronApp.firstWindow();
    await expect(page.locator("html")).toHaveAttribute("data-shell-ready", "true");
    // Playwright otherwise emulates focus, masking document.hasFocus() regressions.
    const hostSession = await page.context().newCDPSession(page);
    await hostSession.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    const result = await electronApp.evaluate(
      async ({ app, BrowserWindow, webContents }, origin) => {
        const { strict: assert } = process.getBuiltinModule("node:assert");
        const f = (globalThis as FocusFixtureGlobals).__synaraVisibleBrowserE2E;
        const manager = f.browserManager;
        const host = BrowserWindow.getAllWindows()[0]!.webContents;
        const passed: string[] = [];
        const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
          const deadline = Date.now() + 5_000;
          while (!(await predicate())) {
            assert.ok(Date.now() < deadline, `Timed out: ${label}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        };
        const readComposer = () =>
          host.executeJavaScript(`(() => {
        const input = document.querySelector('#host-composer');
        return { focus: document.hasFocus(), active: document.activeElement === input,
          value: input.value, start: input.selectionStart, end: input.selectionEnd };
      })()`);
        const expected = { focus: true, active: true, value: "draft text", start: 3, end: 6 };
        const focusComposer = async (label: string, native = true) => {
          if (process.platform === "darwin") app.focus({ steal: true });
          BrowserWindow.getAllWindows()[0]!.focus();
          await waitFor(
            () => BrowserWindow.getAllWindows()[0]!.isFocused(),
            `${label}: initial window focus`,
          );
          host.focus();
          await host.executeJavaScript(`(() => {
          const input = document.querySelector('#host-composer');
          input.value = 'draft text'; input.focus(); input.setSelectionRange(3, 6);
        })()`);
          await waitFor(async () => (await readComposer()).focus, `${label}: initial host focus`);
          await waitFor(() => host.isFocused(), `${label}: initial native host focus`);
          // Electron's global helper prefers webviews when both an embedder and
          // its guest report focus. The host's real DOM focus distinguishes them.
          if (native)
            await waitFor(
              () => webContents.getFocusedWebContents()?.id === host.id,
              `${label}: initial native focus owner`,
            );
          assert.deepEqual(await readComposer(), expected);
        };
        const assertComposer = async (label: string, native: boolean) => {
          const state = await readComposer();
          assert.deepEqual(state, expected, `${label}: composer focus/draft/selection`);
          assert.equal(host.isFocused(), true, `${label}: native host focus`);
          if (native) assert.equal(webContents.getFocusedWebContents()?.id, host.id, label);
        };
        const verifyTyping = async (label: string, native: boolean) => {
          await assertComposer(label, native);
          // Synthetic dispatch, without focus(), click(), or locator typing. Native
          // views route through the actual focus owner; webview reporting varies by OS,
          // so that path requires host DOM focus before sending to its existing input.
          const recipient = native ? webContents.getFocusedWebContents()! : host;
          recipient.sendInputEvent({ type: "char", keyCode: "Z" });
          await waitFor(
            async () => (await readComposer()).value === "draZtext",
            `${label}: typing`,
          );
          assert.deepEqual(await readComposer(), {
            ...expected,
            value: "draZtext",
            start: 4,
            end: 4,
          });
          passed.push(label);
        };
        const navigate = async (contents: WebContents, action: () => unknown, url: string) => {
          let loaded = false;
          const onLoad = () => {
            loaded = true;
          };
          contents.once("did-finish-load", onLoad);
          try {
            await action();
            await waitFor(() => loaded && contents.getURL() === url && !contents.isLoading(), url);
          } finally {
            contents.removeListener("did-finish-load", onLoad);
          }
        };
        const url = (path: string) => new URL(path, origin).href;
        await focusComposer("preview/open");
        const state = manager.prepareAutomationTab({
          threadId: f.threadId,
          url: url("/focus?initial"),
          reuse: true,
        });
        f.setPreviewEnabled(true);
        let input = { threadId: f.threadId, tabId: state.activeTabId! };
        let contents = (await manager.getAutomationRuntime(input)).webContents;
        await waitFor(
          () => !contents.isLoading() && contents.getURL() === url("/focus?initial"),
          "preview initial navigation",
        );
        await verifyTyping("preview/open", true);
        for (const surface of ["preview", "visible", "renderer"] as const) {
          if (surface === "visible") f.setPreviewEnabled(false);
          if (surface === "renderer") {
            // Agent-owned tabs stay native. Use a separate human browser tab for
            // the renderer path, as the existing MCP compatibility scenario does.
            const rendererState = manager.newTab({
              threadId: f.threadId,
              url: url("/focus?renderer-initial"),
            });
            input = { threadId: f.threadId, tabId: rendererState.activeTabId! };
            f.setSurface("renderer");
            await waitFor(() => {
              try {
                return (
                  manager.getVisibleAutomationRuntime(input).webContents.getType() === "webview"
                );
              } catch {
                return false;
              }
            }, "renderer guest adoption");
            contents = manager.getVisibleAutomationRuntime(input).webContents;
            await waitFor(
              () => !contents.isLoading() && contents.getURL() === url("/focus?renderer-initial"),
              "renderer initial navigation",
            );
          }
          const native = surface !== "renderer";
          for (const operation of [
            "navigate",
            "reload",
            "autofocus",
            "redirect",
            "cdp",
            "delayed",
          ] as const) {
            const target = url(`/focus?case=${surface}-${operation}`);
            const label = `${surface}/${operation}`;
            await focusComposer(label, native);
            await navigate(
              contents,
              async () => {
                if (operation === "reload") {
                  manager.reload(input);
                  return;
                }
                if (operation === "cdp") {
                  const attached = contents.debugger.isAttached();
                  if (!attached) contents.debugger.attach("1.3");
                  try {
                    await contents.debugger.sendCommand("Page.navigate", { url: target });
                  } finally {
                    if (!attached) contents.debugger.detach();
                  }
                  return;
                }
                if (operation === "delayed") {
                  // The page navigates only after the initiating call has returned.
                  // A separate page message releases the armed navigation, without focus.
                  await contents.executeJavaScript(
                    `window.addEventListener('message', () => location.assign(${JSON.stringify(target)}), {once:true}); true;`,
                  );
                  await assertComposer(`${label}/armed`, native);
                  await contents.executeJavaScript("window.postMessage('navigate', '*'); true;");
                  return;
                }
                manager.navigate({
                  ...input,
                  url:
                    operation === "redirect"
                      ? url("/focus-redirect")
                      : operation === "autofocus"
                        ? url("/focus-autofocus")
                        : target,
                });
              },
              operation === "reload"
                ? contents.getURL()
                : operation === "redirect"
                  ? url("/focus")
                  : operation === "autofocus"
                    ? url("/focus-autofocus")
                    : target,
            );
            await assertComposer(label, native);
            // A second renderer round trip samples after the completed load.
            await host.executeJavaScript(
              "new Promise(resolve => requestAnimationFrame(() => resolve(true)))",
            );
            await verifyTyping(label, native);
            assert.equal(
              await contents.executeJavaScript("document.querySelector('input').value"),
              "",
            );
          }

          if (surface === "preview") continue;
          await focusComposer(`${surface}/intentional input`, native);
          // Deliberately transfer both native and DOM focus into the browser.
          // The existing MCP scenario separately exercises trusted browser clicks.
          if (!native) await host.executeJavaScript("document.querySelector('webview').focus()");
          contents.focus();
          await contents.executeJavaScript(`(() => {
            const input = document.querySelector('input');
            input.focus();
            input.addEventListener('input', event => {
              input.dataset.inputTrusted = String(event.isTrusted);
            }, { once: true });
          })()`);
          if (native)
            await waitFor(
              () => webContents.getFocusedWebContents()?.id === contents.id,
              `${surface}/intentional native focus`,
            );
          assert.equal(await contents.executeJavaScript("document.hasFocus()"), true);
          const attached = contents.debugger.isAttached();
          if (!attached) contents.debugger.attach("1.3");
          try {
            // CDP text insertion exercises the existing focused input without
            // platform-specific virtual key codes. Native ownership is asserted
            // separately; the app smoke covers physical keyboard/IME delivery.
            await contents.debugger.sendCommand("Input.insertText", { text: "b" });
            await waitFor(
              async () =>
                (await contents.executeJavaScript("document.querySelector('input').value")) === "b",
              `${surface}/browser typing`,
            );
          } finally {
            if (!attached) contents.debugger.detach();
          }
          assert.deepEqual(
            await contents.executeJavaScript(`(() => {
              const input = document.querySelector('input');
              return { active: document.activeElement === input,
                value: input.value, start: input.selectionStart, end: input.selectionEnd,
                trusted: input.dataset.inputTrusted };
            })()`),
            { active: true, value: "b", start: 1, end: 1, trusted: "true" },
          );
          await navigate(
            contents,
            () => manager.navigate({ ...input, url: url("/focus-autofocus") }),
            url("/focus-autofocus"),
          );
          assert.equal(await contents.executeJavaScript("document.hasFocus()"), true);
          if (native)
            assert.equal(
              webContents.getFocusedWebContents()?.id,
              contents.id,
              `${surface}/intentional focus after navigation`,
            );
          else
            assert.equal(
              await host.executeJavaScript(
                "document.activeElement === document.querySelector('webview')",
              ),
              true,
            );
          assert.equal((await readComposer()).value, "draft text");
          passed.push(`${surface}/intentional input`);

          for (const popupKind of ["direct", "blank", "post"] as const) {
            const label = `${surface}/popup-${popupKind}`;
            await focusComposer(label, native);
            const beforeIds = manager.getState({ threadId: f.threadId }).tabs.map((tab) => tab.id);
            const popupUrl = url("/focus-popup");
            await contents.executeJavaScript(
              popupKind === "post"
                ? `(() => { window.open('about:blank', 'focus-auth', 'width=480,height=640'); const form = document.createElement('form'); form.method='POST'; form.action=${JSON.stringify(popupUrl)}; form.target='focus-auth'; form.innerHTML='<input name="proof" value="retained">'; document.body.append(form); form.submit(); })(); true;`
                : `window.open(${JSON.stringify(popupKind === "blank" ? "about:blank" : popupUrl)}, 'focus-auth', 'width=480,height=640'); true;`,
              true,
            );
            await waitFor(
              () =>
                manager
                  .getState({ threadId: f.threadId })
                  .tabs.some((tab) => !beforeIds.includes(tab.id)),
              "popup creation",
            );
            const childTab = manager
              .getState({ threadId: f.threadId })
              .tabs.find((tab) => !beforeIds.includes(tab.id))!;
            await waitFor(
              () => manager.getState({ threadId: f.threadId }).activeTabId === childTab.id,
              "popup activation",
            );
            const child = manager.getVisibleAutomationRuntime({
              threadId: f.threadId,
              tabId: childTab.id,
            }).webContents;
            if (popupKind === "blank") {
              await assertComposer(`${label}/created`, native);
              await navigate(
                child,
                () =>
                  child.executeJavaScript(`location.assign(${JSON.stringify(popupUrl)}); true;`),
                popupUrl,
              );
            } else {
              await waitFor(() => child.getURL() === popupUrl && !child.isLoading(), label);
            }
            await assertComposer(`${label}/loaded`, native);
            assert.equal(child.session, contents.session);
            assert.equal(await child.executeJavaScript("Boolean(window.opener)"), true);
            if (popupKind === "post")
              assert.equal(
                await child.executeJavaScript("document.body.dataset.post"),
                "proof=retained",
              );
            await navigate(
              child,
              () =>
                child.executeJavaScript(
                  `location.assign(${JSON.stringify(url("/focus-popup?next"))}); true;`,
                ),
              url("/focus-popup?next"),
            );
            await verifyTyping(label, native);
            await contents.executeJavaScript(
              `window.popupResult = null;
              window.addEventListener('message', function onPopupResult(event) {
                if (event.origin !== location.origin || event.data !== 'complete') return;
                window.popupResult = event.data;
                window.removeEventListener('message', onPopupResult);
              }); true;`,
            );
            await child
              .executeJavaScript(
                "window.opener.postMessage('complete', location.origin); window.close(); true;",
              )
              .catch(() => {});
            await waitFor(
              () => manager.getState({ threadId: f.threadId }).activeTabId === input.tabId,
              "popup close restores opener",
            );
            await waitFor(
              async () => (await contents.executeJavaScript("window.popupResult")) === "complete",
              `${label}/opener message`,
            );
            assert.equal(BrowserWindow.getAllWindows().length, 1);
          }
        }
        return { platform: process.platform, electron: process.versions.electron, passed };
      },
      site.initialUrl,
    );
    console.log(JSON.stringify(result));
  } finally {
    await fixture.close();
  }
});
