import {
  app,
  BrowserWindow,
  session,
  webContents,
  WebContentsView,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { encode } from "uqr";
import { BROWSER_SESSION_PARTITION } from "./browserSessionPolicy";

interface HybridRequest {
  requestId: string;
  origin: string;
  relyingPartyId: string;
  frame: WebFrameMain | null;
}
interface HybridQr extends HybridRequest {
  qr: string;
}
const instructions = {
  qr: "Scan the code with your phone’s camera.",
  "bluetooth-permission-requested": "Allow Bluetooth access on your Mac to connect your phone.",
  "bluetooth-permission-denied":
    "Allow Bluetooth access for Synara in System Settings, then try again.",
  "bluetooth-off": "Turn on Bluetooth on your Mac and phone.",
  "bluetooth-on": "Scan the code with your phone’s camera.",
  "phone-connected": "Your phone is connected. Follow the instructions on your phone.",
  "ble-advert-received": "Phone detected. Keep it near your Mac.",
  ready: "The secure connection is ready. Continue on your phone.",
};
type TransportStatus = keyof typeof instructions;
const TITLE = "Use a phone passkey";
const DIALOG_WORLD = 1001;
// The document URL is constant. Neither the QR nor the requesting site enters
// navigation history. Only this local renderer receives the encoded modules.
const SHELL =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Use a phone passkey</title>
<style>
:root { color-scheme:light dark; font:menu; } body { margin:0; padding:20px; text-align:center; }
h1 { margin:0; font-size:1.35rem; } #origin { margin:6px 0 14px; font-weight:600; overflow-wrap:anywhere; }
figure { margin:0; min-height:280px; display:grid; place-items:center; }
canvas { background:white; image-rendering:pixelated; } #status { min-height:2.5em; margin:14px 0; }
button { font:inherit; padding:4px 18px; }
</style><h1>Use a phone passkey</h1><p id="origin"></p>
<figure><canvas id="qr" role="img" aria-label="Passkey QR code"></canvas></figure>
<p id="status" role="status"></p><button id="cancel" type="button">Cancel</button></html>`);

function secureOrigin(origin: string): boolean {
  const url = URL.parse(origin);
  return (
    url?.origin === origin &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" ||
          url.hostname.endsWith(".localhost") ||
          url.hostname === "[::1]" ||
          /^127\.\d+\.\d+\.\d+$/u.test(url.hostname))))
  );
}

function belongsTo(owner: BrowserWindow, contents: WebContents): boolean {
  return (
    owner.webContents === contents ||
    owner.webContents === contents.hostWebContents ||
    owner.contentView.children.some(
      (view) => view instanceof WebContentsView && view.webContents === contents,
    )
  );
}

interface ActiveRequest {
  id: string;
  frame: WebFrameMain;
  origin: string;
  update(status: TransportStatus): void;
  finish(cancel: boolean): void;
  handoff(): void;
}

export function registerBrowserHybridPasskeys(
  target: Session,
  isHumanBrowserPage: (contents: WebContents) => boolean,
): () => void {
  const hybrid = target as Session & { setWebAuthnHybridEnabled?: (enabled: boolean) => void };
  if (
    process.platform !== "darwin" ||
    !hybrid.setWebAuthnHybridEnabled ||
    target !== session.fromPartition(BROWSER_SESSION_PARTITION)
  )
    return () => {};

  // This capability is provided by the macOS distribution's native patch;
  // stock Electron declarations only list the built-in Session events.
  const events: NodeJS.EventEmitter = target;
  let active: ActiveRequest | undefined;
  const open = (_event: Electron.Event, details: HybridQr, cancel: () => void) => {
    const { frame, origin, requestId, qr } = details;
    const owner = BrowserWindow.getFocusedWindow();
    const contents = frame && !frame.detached ? webContents.fromFrame(frame) : undefined;
    if (
      active ||
      !owner ||
      !contents ||
      !frame ||
      !secureOrigin(origin) ||
      !contents.isFocused() ||
      typeof qr !== "string" ||
      !qr.startsWith("FIDO:/") ||
      qr.length > 4096
    ) {
      cancel();
      return;
    }
    const stillOwned = () => {
      try {
        return (
          !owner.isDestroyed() &&
          owner.isVisible() &&
          !contents.isDestroyed() &&
          contents.session === target &&
          !frame.detached &&
          contents.mainFrame === frame &&
          frame.origin === origin &&
          URL.parse(frame.url)?.origin === origin &&
          belongsTo(owner, contents) &&
          isHumanBrowserPage(contents)
        );
      } catch {
        return false;
      }
    };
    if (!stillOwned()) {
      cancel();
      return;
    }

    let sheet: BrowserWindow;
    try {
      sheet = new BrowserWindow({
        title: TITLE,
        parent: owner,
        modal: true,
        show: false,
        useContentSize: true,
        width: 384,
        height: 465,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        autoHideMenuBar: true,
        webPreferences: {
          partition: "synara-phone-passkey-dialog",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
          webviewTag: false,
        },
      });
    } catch {
      cancel();
      return;
    }

    const renderer = sheet.webContents;
    let loaded = false;
    let status: TransportStatus = "qr";
    const finish = (cancelNative: boolean) => {
      if (active?.id !== requestId) return;
      active = undefined;
      clearInterval(ownershipWatch);
      contents.removeListener("did-start-navigation", onNavigation);
      contents.removeListener("destroyed", onCancel);
      owner.removeListener("closed", onCancel);
      owner.removeListener("hide", onCancel);
      owner.removeListener("minimize", onCancel);
      app.removeListener("browser-window-focus", onWindowFocus);
      try {
        if (!sheet.isDestroyed()) sheet.destroy();
      } finally {
        if (cancelNative) cancel();
      }
    };
    const onCancel = () => finish(true);
    const onWindowFocus = (_event: Electron.Event, focused: BrowserWindow) => {
      if (focused !== sheet && focused !== owner) onCancel();
    };
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame) onCancel();
    };
    const ownershipWatch = setInterval(() => {
      // Tab switches and automation takeovers may leave the same frame alive.
      if (!stillOwned()) onCancel();
    }, 200);
    ownershipWatch.unref();

    const local = () =>
      active?.id === requestId &&
      !sheet.isDestroyed() &&
      renderer.getURL() === SHELL &&
      stillOwned();
    const paintStatus = () => {
      if (!local()) {
        onCancel();
        return;
      }
      const hideCode = status === "phone-connected" || status === "ready";
      void renderer
        .executeJavaScriptInIsolatedWorld(DIALOG_WORLD, [
          {
            code: `document.getElementById('status').textContent = ${JSON.stringify(instructions[status])};
         document.getElementById('qr').hidden = ${hideCode};`,
          },
        ])
        .catch(onCancel);
    };
    active = {
      id: requestId,
      frame,
      origin,
      update(next) {
        status = next;
        if (loaded) paintStatus();
      },
      finish,
      handoff() {
        // The platform's account picker may arrive while the sheet owns focus.
        const focused = BrowserWindow.getFocusedWindow();
        const restoreFocus = (focused === sheet || focused === owner) && stillOwned();
        finish(false);
        if (restoreFocus) {
          owner.focus();
          contents.focus();
        }
      },
    };
    contents.on("did-start-navigation", onNavigation);
    contents.once("destroyed", onCancel);
    owner.once("closed", onCancel);
    owner.once("hide", onCancel);
    owner.once("minimize", onCancel);
    app.on("browser-window-focus", onWindowFocus);
    sheet.once("closed", onCancel);
    renderer.once("render-process-gone", onCancel);
    renderer.setWindowOpenHandler(() => ({ action: "deny" }));
    renderer.on("will-navigate", (event) => {
      event.preventDefault();
      onCancel();
    });
    renderer.on("will-redirect", (event) => {
      event.preventDefault();
      onCancel();
    });
    renderer.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    });

    const render = async () => {
      sheet.setContentProtection(true);
      await sheet.loadURL(SHELL);
      if (!local()) {
        onCancel();
        return;
      }
      const matrix = encode(qr, { border: 4, ecc: "M" });
      const modules = matrix.data
        .map((row) => row.map((black) => (black ? "1" : "0")).join(""))
        .join("");
      // An integer number of canvas pixels per module also preserves the four-
      // module white quiet zone. The original FIDO payload never enters script.
      await renderer.executeJavaScriptInIsolatedWorld(DIALOG_WORLD, [
        {
          code: `(() => {
        const size = ${matrix.size}, scale = Math.max(1, Math.floor(280/size));
        const canvas = document.getElementById('qr'), ctx = canvas.getContext('2d');
        canvas.width = canvas.height = size * scale;
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'black';
        const modules = ${JSON.stringify(modules)};
        for (let i = 0; i < modules.length; i++) {
          if (modules[i] === '1') ctx.fillRect(i % size * scale, Math.floor(i/size) * scale, scale, scale);
        }
        document.getElementById('origin').textContent = ${JSON.stringify(new URL(origin).host)};
        document.getElementById('cancel').addEventListener('click', () => window.close());
      })()`,
        },
      ]);
      if (!local()) {
        onCancel();
        return;
      }
      loaded = true;
      paintStatus();
      sheet.show();
    };
    void render().catch(onCancel);
  };
  const update = (
    _event: Electron.Event,
    details: HybridRequest & { status: TransportStatus | "closed" },
  ) => {
    if (!active || active.id !== details.requestId) return;
    if (details.status === "closed") {
      active.finish(false);
      return;
    }
    if (
      details.frame === active.frame &&
      details.origin === active.origin &&
      Object.hasOwn(instructions, details.status)
    ) {
      active.update(details.status);
    }
  };
  const handoff = (_event: Electron.Event, details: Electron.SelectWebauthnAccountDetails) => {
    if (active && details.frame === active.frame) active.handoff();
  };
  events.on("webauthn-hybrid-qr", open);
  events.on("webauthn-hybrid-status", update);
  events.prependListener("select-webauthn-account", handoff);
  const cleanup = () => {
    events.removeListener("webauthn-hybrid-qr", open);
    events.removeListener("webauthn-hybrid-status", update);
    events.removeListener("select-webauthn-account", handoff);
    active?.finish(true);
  };
  try {
    hybrid.setWebAuthnHybridEnabled(true);
  } catch {
    cleanup();
    console.warn("[Synara browser] Phone passkey discovery could not be enabled.");
    return () => {};
  }
  return () => {
    try {
      hybrid.setWebAuthnHybridEnabled?.(false);
    } finally {
      cleanup();
    }
  };
}
