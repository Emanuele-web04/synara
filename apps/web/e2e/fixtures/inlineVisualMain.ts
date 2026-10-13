// FILE: inlineVisualMain.ts
// Purpose: Electron main process for the inline-visual isolation E2E. It opens one window with
//          the app window's own webPreferences, webview hardening, and subframe navigation
//          guard, then hosts agent-style pages exactly as the transcript does (sandboxed srcdoc).
// Layer: Desktop E2E fixture (not shipped)

import { writeFileSync } from "node:fs";
import * as path from "node:path";

import { app, BrowserWindow } from "electron";

import { buildInlineVisualDocument } from "@synara/shared/inlineVisual";

import { hardenBrowserAnnotationWebviewPreferences } from "../../../desktop/src/browserAnnotations/webviewSecurity";
import { BROWSER_SESSION_PARTITION } from "../../../desktop/src/browserSessionPolicy";
import { attachAppSubframeNavigationGuard } from "../../../desktop/src/subframeNavigationGuard";

const synaraHome = process.env.SYNARA_HOME;
const annotationPreloadPath = process.env.SYNARA_E2E_BROWSER_ANNOTATION_PRELOAD;
const recorderOrigin = process.env.SYNARA_E2E_RECORDER_ORIGIN;
if (!synaraHome || !annotationPreloadPath || !recorderOrigin) {
  throw new Error("The inline-visual Electron fixture requires its isolated E2E environment.");
}
app.setPath("userData", path.join(synaraHome, "electron-userdata"));

interface FixtureRecords {
  webviewAttachAttempts: string[];
  webviewGuests: string[];
  subframeNavigations: Array<{ url: string; isMainFrame: boolean }>;
}
const records: FixtureRecords = {
  webviewAttachAttempts: [],
  webviewGuests: [],
  subframeNavigations: [],
};
(globalThis as { inlineVisualRecords?: FixtureRecords }).inlineVisualRecords = records;

const theme = {
  appearance: "dark" as const,
  variables: { "--foreground": "#fafafa", "--background": "#18181b", "--font-size": "14px" },
};
const leak = (label: string) => `${recorderOrigin}/leak?via=${label}`;

// Each page is what an agent could publish; each reports back to the host page.
const pages = {
  webview: `<script>
    const before = { definedInFrame: typeof customElements.get("webview") };
    const guest = document.createElement("webview");
    guest.setAttribute("partition", ${JSON.stringify(BROWSER_SESSION_PARTITION)});
    guest.setAttribute("src", ${JSON.stringify(leak("webview"))});
    document.documentElement.appendChild(guest);
    setTimeout(() => parent.postMessage({ probe: "webview", ...before,
      hasGuestApi: typeof guest.getWebContentsId }, "*"), 1500);
  </script>`,
  scriptNavigation: `<p>script navigation</p><script>
    setTimeout(() => { location.href = ${JSON.stringify(leak("location"))}; }, 50);
    setTimeout(() => parent.postMessage({ probe: "script-navigation", stillHere: location.href }, "*"), 1500);
  </script>`,
  metaRefresh: `<meta http-equiv="refresh" content="0;url=${leak("refresh")}"><p>meta refresh</p><script>
    setTimeout(() => parent.postMessage({ probe: "meta-refresh", stillHere: location.href }, "*"), 1500);
  </script>`,
  fetch: `<script>
    fetch(${JSON.stringify(leak("fetch"))}, { mode: "no-cors" }).then(() => "loaded", (error) => error.name)
      .then((fetched) => parent.postMessage({ probe: "fetch", fetched }, "*"));
  </script>`,
  busy: `<p>busy</p><script>
    addEventListener("load", () => {
      parent.postMessage({ probe: "busy-start" }, "*");
      setTimeout(() => {
        const end = Date.now() + 3000;
        while (Date.now() < end) {}
        parent.postMessage({ probe: "busy-end" }, "*");
      }, 100);
    });
  </script>`,
};

const documents = Object.fromEntries(
  Object.entries(pages).map(([name, html]) => [name, buildInlineVisualDocument(html, theme)]),
);

// The host page: the frame attributes InlineVisualFrame renders, plus a
// control <webview> in the app's own document and a heartbeat that shows
// whether the app's main thread keeps running.
const shell = `<!doctype html><html><body><script>
  window.probes = [];
  window.beats = [];
  setInterval(() => window.beats.push(Date.now()), 20);
  addEventListener("message", (event) => { if (event.data && event.data.probe) window.probes.push({ ...event.data, at: Date.now() }); });
  const documents = ${JSON.stringify(documents).replaceAll("<", "\\u003c")};
  window.showVisual = (name) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.dataset.visual = name;
    frame.srcdoc = documents[name];
    document.body.appendChild(frame);
  };
  window.showControlWebview = () => {
    const guest = document.createElement("webview");
    guest.setAttribute("partition", ${JSON.stringify(BROWSER_SESSION_PARTITION)});
    guest.setAttribute("src", "about:blank");
    document.body.appendChild(guest);
  };
</script></body></html>`;

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() === "webview") records.webviewGuests.push(contents.getURL());
});

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 900,
    height: 700,
    show: true,
    // The app window's own preferences (apps/desktop/src/main.ts).
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    records.webviewAttachAttempts.push(params.src);
    if (
      !hardenBrowserAnnotationWebviewPreferences({
        partition: params.partition,
        expectedPartition: BROWSER_SESSION_PARTITION,
        preloadPath: annotationPreloadPath,
        webPreferences,
      })
    ) {
      event.preventDefault();
    }
  });
  attachAppSubframeNavigationGuard(window.webContents);
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) {
      records.subframeNavigations.push({ url: event.url, isMainFrame: event.isMainFrame });
    }
  });
  const shellPath = path.join(synaraHome, "inline-visual-shell.html");
  writeFileSync(shellPath, shell);
  await window.loadFile(shellPath);
});
