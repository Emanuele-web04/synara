// Real Electron/BetterWright input with an independent synthetic chat renderer.
// --interactive opens the fixture for physical typing and voluntary browser takeover.
import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { configureElectronNetwork } from "betterwright/electron";
import { ThreadId } from "@synara/contracts";
import { DesktopBrowserManager } from "../src/browserManager";
import { DesktopBrowserAutomationHost } from "../src/browserAutomation/desktopBrowserAutomationHost";

configureElectronNetwork();
const home = await mkdtemp(join(tmpdir(), "synara-browser-background-"));
app.setPath("userData", join(home, "electron"));
const interactive = process.argv.includes("--interactive");
const deadline = setTimeout(() => app.exit(1), interactive ? 180_000 : 90_000);
const agentThread = ThreadId.makeUnsafe("background-agent");
const otherThread = ThreadId.makeUnsafe("background-human");
const bounds = { x: 440, y: 0, width: 550, height: 600 };

async function smoke() {
  await app.whenReady();
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<label>Agent input <input id="agent"></label><button id="click">Click</button>
      <script>window.clicks=0;window.trusted=true;window.sentinel='preserved';
      click.onclick=e=>{clicks++;trusted&&=e.isTrusted};</script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const window = new BrowserWindow({ show: interactive, width: 1000, height: 700 });
  const manager = new DesktopBrowserManager();
  manager.setWindow(window);
  const host = new DesktopBrowserAutomationHost(manager);
  const command = (
    name: "browser_open" | "browser_run" | "browser_close",
    args: object,
    signal?: AbortSignal,
  ) =>
    host.executeTool({
      sessionId: "background-smoke",
      provider: "codex",
      threadId: agentThread,
      name,
      arguments: args,
      ...(signal ? { signal } : {}),
    });
  try {
    await window.loadURL(
      `data:text/html,${encodeURIComponent(`<style>body{font:18px system-ui;background:#222;color:white}textarea{display:block;width:360px;height:180px}</style>
      <p>Type in either chat while the agent fills and clicks its page.</p>
      <button onclick="selectChat('one')">Chat one</button><button onclick="selectChat('two')">Chat two</button>
      <textarea id="one"></textarea><textarea id="two"></textarea><output id="status"></output>
      <script>window.unexpectedBlurs=0;window.selecting=false;window.selected='one';
      window.selectChat=id=>{selecting=true;selected=id;document.getElementById(id).focus();selecting=false};
      for(const el of [one,two])el.onblur=()=>{if(!selecting)unexpectedBlurs++};selectChat('one');</script>`)}`,
    );
    // Only fixture setup may choose initial native focus. Automation never does.
    if (interactive) window.webContents.focus();
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
    const opened = (await command("browser_open", {
      url: `http://127.0.0.1:${port}/`,
      idempotencyKey: "open",
    })) as { tabId: string };
    const runtime = await manager.getAutomationRuntime({
      threadId: agentThread,
      tabId: opened.tabId,
    });
    let nativeFocusCalls = 0;
    const nativeFocus = runtime.webContents.focus.bind(runtime.webContents);
    runtime.webContents.focus = () => {
      nativeFocusCalls++;
      nativeFocus();
    };
    if (interactive) {
      const until = Date.now() + 60_000;
      let iteration = 0;
      while (Date.now() < until && !window.isDestroyed()) {
        const chat = await window.webContents.executeJavaScript("selected");
        if (chat === "one")
          manager.setPanelBounds({ threadId: agentThread, surface: "native", bounds });
        else manager.hide({ threadId: agentThread });
        try {
          await command("browser_run", {
            idempotencyKey: `interactive-${iteration++}`,
            timeoutMs: 10_000,
            code: "await page.getByLabel('Agent input').fill('background');await page.getByRole('button',{name:'Click',exact:true}).click();return 'done';",
          });
          await window.webContents.executeJavaScript(
            "status.textContent='Agent active: keep typing or click its page to take over.'",
          );
        } catch (error) {
          const code = (error as { browserError?: { code: string } }).browserError?.code;
          if (code !== "BrowserInterruptedByHuman") throw error;
          await window.webContents.executeJavaScript(
            "status.textContent='Manual browser control: agent paused. Click a composer to let the next action run.'",
          );
        }
        assert.equal(nativeFocusCalls, 0);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      console.log(
        "Interactive fixture ended. Confirm physical input and focus behavior manually; no automatic keyboard verdict.",
      );
      return;
    }
    const expected = { one: "", two: "" };
    let expectedClicks = 0;
    for (const mode of ["visible", "hidden", "switch-chat", "other-tab"] as const) {
      const manualTabId =
        mode === "other-tab"
          ? manager.newTab({ threadId: agentThread, url: `http://127.0.0.1:${port}/manual` })
              .activeTabId
          : null;
      manager.setPanelBounds({ threadId: agentThread, surface: "native", bounds });
      if (mode === "hidden") manager.hide({ threadId: agentThread });
      let active: "one" | "two" = "one";
      await window.webContents.executeJavaScript("selectChat('one')");
      let done = false;
      const operation = command("browser_run", {
        idempotencyKey: mode,
        timeoutMs: 30_000,
        code: `for(let i=0;i<8;i++){await page.getByLabel('Agent input').fill('agent-'+i);await page.getByRole('button',{name:'Click',exact:true}).click();}return await page.evaluate(()=>({value:agent.value,clicks,trusted,sentinel}));`,
      }).finally(() => {
        done = true;
      });
      let writes = 0;
      while (!done) {
        if (manualTabId && writes === 5) {
          manager.selectTab({ threadId: agentThread, tabId: manualTabId });
          manager.hide({ threadId: agentThread });
        }
        if (mode === "switch-chat" && writes === 5) {
          active = "two";
          await window.webContents.executeJavaScript("selectChat('two')");
          manager.hide({ threadId: agentThread });
          manager.open({ threadId: otherThread });
          manager.setPanelBounds({ threadId: otherThread, surface: "native", bounds });
        }
        if (!interactive) {
          await window.webContents.debugger.sendCommand("Input.insertText", { text: "u" });
          expected[active] += "u";
        }
        writes++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const result = (await operation) as {
        value: { value: string; clicks: number; trusted: boolean; sentinel: string };
      };
      assert.equal(result.value.value, "agent-7");
      expectedClicks += 8;
      assert.equal(result.value.clicks, expectedClicks);
      assert.equal(result.value.trusted, true);
      assert.equal(result.value.sentinel, "preserved");
      const human = await window.webContents.executeJavaScript(
        "({one:one.value,two:two.value,active:document.activeElement.id,unexpectedBlurs})",
      );
      assert.equal(human.active, active);
      assert.equal(human.unexpectedBlurs, 0);
      if (!interactive) {
        assert.equal(human.one, expected.one);
        assert.equal(human.two, expected.two);
      }
      assert.equal(nativeFocusCalls, 0);
      assert.equal(
        (await manager.getAutomationRuntime({ threadId: agentThread, tabId: opened.tabId }))
          .webContents,
        runtime.webContents,
      );
      console.log(
        JSON.stringify({
          mode,
          writes,
          result,
          human: { ...human, one: human.one.length, two: human.two.length },
          nativeFocusCalls,
        }),
      );
    }
    await window.webContents.executeJavaScript("selectChat('two')");
    const selected = manager.getState({ threadId: agentThread }).activeTabId;
    const popup = (await command("browser_run", {
      idempotencyKey: "popup",
      code: "await page.evaluate(()=>{window.open('/child','signin','width=400,height=500')});return 'opened';",
    })) as { humanActionRequired?: { kind: string } };
    assert.equal(popup.humanActionRequired?.kind, "oauth_popup");
    assert.equal(manager.getState({ threadId: agentThread }).activeTabId, selected);
    const child = manager
      .getState({ threadId: agentThread })
      .tabs.find((tab) => tab.openerTabId === opened.tabId);
    assert.ok(child);
    const childRuntime = await manager.getAutomationRuntime({
      threadId: agentThread,
      tabId: child.id,
    });
    assert.equal(await childRuntime.webContents.executeJavaScript("window.opener !== null"), true);
    manager.closeAutomationTab({ threadId: agentThread, tabId: child.id });
    assert.equal(manager.getState({ threadId: agentThread }).activeTabId, selected);
    await assert.rejects(
      command("browser_run", {
        idempotencyKey: "failed-action",
        code: "throw new Error('synthetic failure')",
      }),
      (error: unknown) =>
        (error as { browserError: { code: string } }).browserError.code ===
        "BrowserEvaluationFailed",
    );
    for (const interruption of ["cancel", "human"] as const) {
      const controller = new AbortController();
      const operation = command(
        "browser_run",
        {
          idempotencyKey: interruption,
          timeoutMs: 30_000,
          code: "await page.evaluate(()=>{window.waiting=true;return new Promise(()=>{})});return 'unreachable';",
        },
        controller.signal,
      );
      // Attach the rejection assertion before triggering interruption.
      const rejected = assert.rejects(operation, (error: unknown) => {
        assert.equal(
          (error as { browserError: { code: string } }).browserError.code,
          interruption === "cancel" ? "BrowserCancelled" : "BrowserInterruptedByHuman",
        );
        return true;
      });
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await runtime.webContents.executeJavaScript("window.waiting===true")) break;
        if (attempt === 199) {
          controller.abort();
          throw new Error("worker did not reach waiting fixture");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (interruption === "cancel") controller.abort();
      else manager.selectTab({ threadId: agentThread, tabId: opened.tabId });
      await rejected;
      await runtime.webContents.executeJavaScript("window.waiting=false");
      assert.equal(await runtime.webContents.executeJavaScript("sentinel"), "preserved");
      assert.equal(nativeFocusCalls, 0);
      console.log(`${interruption}: rejected, same page preserved, zero native focus calls`);
    }
    if (selected) manager.selectTab({ threadId: agentThread, tabId: selected });
    const linked = (await command("browser_run", {
      idempotencyKey: "link-popup",
      code: "await page.evaluate(()=>{window.open('/next','_blank')});return 'opened';",
    })) as { openedTabId?: string };
    assert.ok(linked.openedTabId);
    assert.equal(manager.getState({ threadId: agentThread }).activeTabId, selected);
    await command("browser_close", {
      tabId: linked.openedTabId,
      idempotencyKey: "close-link-popup",
    });
    assert.equal(manager.getState({ threadId: agentThread }).activeTabId, selected);
    await command("browser_run", {
      idempotencyKey: "page-focus-request",
      code: "await page.evaluate(()=>window.focus());return 'done';",
    });
    assert.equal(window.isVisible(), false);
    const finalHuman = await window.webContents.executeJavaScript(
      "({one:one.value,two:two.value,active:document.activeElement.id,unexpectedBlurs})",
    );
    assert.equal(finalHuman.one, expected.one);
    assert.equal(finalHuman.two, expected.two);
    assert.equal(finalHuman.active, "two");
    assert.equal(finalHuman.unexpectedBlurs, 0);
    assert.equal(nativeFocusCalls, 0);
    console.log(
      "Popups, close, failure, cancellation and page focus request preserved composer and UI selection.",
    );
  } finally {
    await host.dispose();
    manager.dispose();
    window.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
void smoke().then(
  async () => {
    clearTimeout(deadline);
    await rm(home, { recursive: true, force: true });
    app.exit(0);
  },
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
