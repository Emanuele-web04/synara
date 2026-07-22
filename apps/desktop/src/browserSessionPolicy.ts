// FILE: browserSessionPolicy.ts
// Purpose: Owns the persistent Electron browser session identity and popup security policy.
// Layer: Desktop browser infrastructure

import {
  app,
  session,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type DownloadItem,
  type Session,
  type WebContents,
} from "electron";
import {
  buildAcceptLanguageHeader,
  buildChromeClientHints,
  deriveChromeUserAgent,
} from "@synara/shared/browserSession";

export const BROWSER_SESSION_PARTITION = "persist:synara-browser";

export interface BrowserSessionDownloadEvent {
  readonly event: Electron.Event;
  readonly item: DownloadItem;
  readonly webContents: WebContents;
}

export type BrowserSessionDownloadListener = (event: BrowserSessionDownloadEvent) => void;

function replaceRequestHeadersCaseInsensitive(
  headers: Record<string, string>,
  replacements: Record<string, string>,
): Record<string, string> {
  const replacementNamesByLower = new Set(
    Object.keys(replacements).map((name) => name.toLowerCase()),
  );
  for (const existing of Object.keys(headers)) {
    if (replacementNamesByLower.has(existing.toLowerCase())) {
      delete headers[existing];
    }
  }
  for (const [name, value] of Object.entries(replacements)) {
    headers[name] = value;
  }
  return headers;
}

export class BrowserSessionPolicy {
  private spoofedUserAgent: string | null = null;
  private configured = false;
  private configuredSession: Session | null = null;
  private willDownloadListener:
    | ((event: Electron.Event, item: DownloadItem, webContents: WebContents) => void)
    | null = null;

  constructor(private readonly onWillDownload?: BrowserSessionDownloadListener) {}

  private resolveUserAgent(): string {
    if (this.spoofedUserAgent === null) {
      this.spoofedUserAgent = deriveChromeUserAgent(app.userAgentFallback, [app.getName()]);
    }
    return this.spoofedUserAgent;
  }

  ensureConfigured(): void {
    if (this.configured) {
      return;
    }
    try {
      const partitionSession = session.fromPartition(BROWSER_SESSION_PARTITION);
      const userAgent = this.resolveUserAgent();
      partitionSession.setUserAgent(userAgent);

      const clientHints = buildChromeClientHints(userAgent, process.platform);
      const acceptLanguage = buildAcceptLanguageHeader(app.getPreferredSystemLanguages());
      partitionSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const requestHeaders = replaceRequestHeadersCaseInsensitive(details.requestHeaders, {
          "User-Agent": userAgent,
          ...(acceptLanguage ? { "Accept-Language": acceptLanguage } : {}),
          ...(clientHints ?? {}),
        });
        callback({ requestHeaders });
      });
      const onWillDownload = this.onWillDownload;
      if (onWillDownload) {
        const listener = (event: Electron.Event, item: DownloadItem, webContents: WebContents) => {
          onWillDownload({ event, item, webContents });
        };
        partitionSession.on("will-download", listener);
        this.configuredSession = partitionSession;
        this.willDownloadListener = listener;
      }
      this.configured = true;
    } catch {
      // Session creation can race Electron readiness. Retrying the next call preserves the
      // per-WebContents fallback without permanently disabling partition configuration.
      this.configured = false;
    }
  }

  dispose(): void {
    const partitionSession = this.configuredSession;
    const listener = this.willDownloadListener;
    this.configuredSession = null;
    this.willDownloadListener = null;
    this.configured = false;
    if (!partitionSession || !listener) {
      return;
    }
    try {
      partitionSession.removeListener("will-download", listener);
    } catch {
      // Electron may already be tearing the session down during app quit.
      // The manager reference is cleared above, so no retained callback remains here.
    }
  }

  applyUserAgent(webContents: Pick<WebContents, "setUserAgent">): void {
    webContents.setUserAgent(this.resolveUserAgent());
  }

  buildOAuthPopupWindowOptions(parent: BrowserWindow | null): BrowserWindowConstructorOptions {
    return {
      width: 480,
      height: 640,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      skipTaskbar: true,
      title: "Sign in",
      ...(parent ? { parent } : {}),
      webPreferences: {
        partition: BROWSER_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    };
  }
}
