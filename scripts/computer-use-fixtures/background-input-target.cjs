// Owned target only for background-input-regression.mjs. Input is supplied by the external native driver.
const { app, BrowserWindow } = require("electron");
const readline = require("node:readline");
const path = require("node:path");
const fixtureDirectory = process.env.SYNARA_BACKGROUND_FIXTURE_DIRECTORY;
if (!fixtureDirectory || !path.isAbsolute(fixtureDirectory))
  throw new Error("An explicit fixture directory is required.");
app.setPath("userData", path.join(fixtureDirectory, "target-profile"));
app.setName("Synara Background Regression Fixture");
app.commandLine.appendSwitch("force-renderer-accessibility");
const windows = new Map();
const keyboardEvents = new Map();
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
function markup(label) {
  return `<!doctype html><title>Synara Background Fixture ${process.pid} ${label}</title>
<style>body{font:18px system-ui;margin:24px;height:1600px}input{font:20px system-ui;width:380px;padding:8px}#nested{height:150px;width:380px;overflow:auto;border:2px solid #888;margin-top:24px}#inside{height:1500px;background:linear-gradient(#ddeeff,#334477)}h1{font-size:22px}</style>
<h1>Owned test target ${label}</h1><form id="form"><input id="query" aria-label="Fixture query ${label}" value="initial-${label}"></form>
<div id="nested" role="region" aria-label="Nested scroll ${label}"><div id="inside">Nested scroll content ${label}</div></div>
<p>Only the native driver supplies tested input.</p>
<script>window.fixture={submits:0,enters:0,changes:0,clicks:0};document.querySelector('#form').addEventListener('submit',e=>{e.preventDefault();fixture.submits++});document.querySelector('#query').addEventListener('keydown',e=>{if(e.key==='Enter')fixture.enters++});document.querySelector('#query').addEventListener('input',()=>fixture.changes++);document.addEventListener('click',()=>fixture.clicks++);document.querySelector('#query').focus();</script>`;
}
app.on("window-all-closed", () => app.quit());
app
  .whenReady()
  .then(async () => {
    for (const [i, label] of ["A", "B"].entries()) {
      const window = new BrowserWindow({
        title: `Synara Background Fixture ${process.pid} ${label}`,
        width: 500,
        height: 460,
        x: 30 + i * 520,
        y: 100,
        show: false,
        webPreferences: { backgroundThrottling: false },
      });
      windows.set(label, window);
      keyboardEvents.set(label, { enterDown: 0, enterUp: 0 });
      window.webContents.on("before-input-event", (_event, input) => {
        if (input.key !== "Enter") return;
        const counts = keyboardEvents.get(label);
        if (input.type === "keyDown") counts.enterDown++;
        if (input.type === "keyUp") counts.enterUp++;
      });
      await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(markup(label)));
      window.showInactive();
    }
    emit({
      event: "ready",
      pid: process.pid,
      titles: [...windows.values()].map((w) => w.getTitle()),
    });
    readline
      .createInterface({ input: process.stdin })
      .on("line", async (line) => {
        try {
          const message = JSON.parse(line);
          if (message.command === "quit") return app.quit();
          if (message.command === "state") {
            const states = {};
            for (const [label, window] of windows)
              states[label] = {
                ...(await window.webContents.executeJavaScript(
                  '({ ...fixture, value: document.querySelector("#query").value, documentScroll: window.scrollY, nestedScroll: document.querySelector("#nested").scrollTop, active: document.activeElement.id, nestedRect: document.querySelector("#nested").getBoundingClientRect().toJSON() })',
                )),
                visible: window.isVisible(),
                focused: window.isFocused(),
                keyboardEvents: keyboardEvents.get(label),
                bounds: window.getBounds(),
                contentBounds: window.getContentBounds(),
              };
            emit({ id: message.id, pid: process.pid, states });
          }
          if (message.command === "reset") {
            // Reset only fixture DOM as an independent test precondition.
            for (const [label, window] of windows)
              await window.webContents.executeJavaScript(
                `fixture={submits:0,enters:0,changes:0,clicks:0};document.querySelector('#query').value='initial-${label}';window.scrollTo(0,0);document.querySelector('#nested').scrollTop=0;document.querySelector('#query').focus();`,
              );
            emit({ id: message.id, reset: true });
          }
          if (message.command === "controlled-focus-a") {
            // Explicit --owned-sentinel setup only. Measurement begins after
            // that separate owned app becomes frontmost; passive runs skip it.
            windows.get("A").focus();
            await windows
              .get("A")
              .webContents.executeJavaScript('document.querySelector("#query").focus()');
            emit({ id: message.id, focused: "A" });
          }
        } catch (error) {
          emit({ error: String(error) });
        }
      })
      .on("close", () => app.quit());
  })
  .catch((error) => {
    emit({ error: String(error) });
    app.quit();
  });
