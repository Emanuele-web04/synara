// A separate opaque window placed exactly over the app's window, so the app is measured
// while occluded (not minimized or hidden). It covers only that rectangle, stays below
// the Dock and menu bar, never takes focus, and is killed by the harness after the window.
const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.BENCH_COVER_PROFILE);
if (app.dock) app.dock.hide();
app.whenReady().then(() => {
  const bounds = JSON.parse(process.env.BENCH_COVER_BOUNDS);
  const window = new BrowserWindow({
    ...bounds,
    frame: false,
    backgroundColor: "#202020",
    hasShadow: false,
    focusable: false,
    show: false,
    resizable: false,
    movable: false,
  });
  window.setAlwaysOnTop(true, "floating");
  window.loadURL(
    "data:text/html,<body style='background:%23202020;color:%23999;font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0'>Synara benchmark: covered-window measurement, closes by itself</body>",
  );
  window.showInactive();
  process.stdout.write("cover-ready\n");
  // Safety net: never outlive the measurement, even if the harness dies.
  setTimeout(() => app.exit(0), Number(process.env.BENCH_COVER_MAX_MS ?? 120000));
});
