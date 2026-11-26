import {
  app,
  BrowserWindow,
  Menu,
  webContents,
  type SelectWebauthnAccountDetails,
  type Session,
  type WebContents,
} from "electron";
import { literalMenuLabel } from "./contextMenuTemplate";

/** The signed package names its own group. Chromium checks the entitlement and Secure Enclave. */
export function configureBrowserTouchId(bundleId: string, packagedGroup: unknown): void {
  if (process.platform !== "darwin" || !app.isPackaged || typeof packagedGroup !== "string") return;
  const [prefix] = packagedGroup.split(".", 1);
  if (
    !prefix ||
    !/^[A-Z0-9]{10}$/.test(prefix) ||
    packagedGroup !== `${prefix}.${bundleId}.webauthn`
  )
    return;
  try {
    app.configureWebAuthn({ touchID: { keychainAccessGroup: packagedGroup } });
  } catch {
    console.warn("[Synara browser] The local Touch ID authenticator could not be configured.");
  }
}

export function registerBrowserPasskeyAccounts(
  target: Session,
  isUserVisible: (contents: WebContents) => boolean,
): () => void {
  let cancelPending: (() => void) | undefined;
  const select = (
    _event: Electron.Event,
    { frame, relyingPartyId, accounts }: SelectWebauthnAccountDetails,
    reply: (credentialId?: string | null) => void,
  ) => {
    const contents = frame && !frame.detached ? webContents.fromFrame(frame) : undefined;
    const owner = BrowserWindow.getFocusedWindow();
    if (
      !frame ||
      !contents ||
      !owner ||
      !accounts.length ||
      cancelPending ||
      !contents.isFocused()
    ) {
      reply(null);
      return;
    }
    const isCurrent = () =>
      BrowserWindow.getFocusedWindow() === owner &&
      !contents.isDestroyed() &&
      !frame.detached &&
      contents.mainFrame === frame &&
      contents.session === target &&
      isUserVisible(contents);
    if (!isCurrent()) {
      reply(null);
      return;
    }
    let menu: Menu | undefined;
    const finish = (credentialId: string | null) => {
      if (cancelPending !== cancel) return;
      cancelPending = undefined;
      contents.removeListener("did-start-navigation", onNavigation);
      contents.removeListener("destroyed", cancel);
      owner.removeListener("closed", cancel);
      try {
        menu?.closePopup();
      } finally {
        reply(credentialId);
      }
    };
    const cancel = () => finish(null);
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame) cancel();
    };
    cancelPending = cancel;
    contents.on("did-start-navigation", onNavigation);
    contents.once("destroyed", cancel);
    owner.once("closed", cancel);
    try {
      menu = Menu.buildFromTemplate([
        { label: relyingPartyId, enabled: false },
        { type: "separator" },
        ...accounts.map((account, index) => {
          // Account names are supplied by sites. Keep each choice on one visible line.
          const text = (account.name || account.displayName || "")
            .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
            .trim()
            .slice(0, 140);
          const label = text || `Account ${index + 1}`;
          return {
            label: literalMenuLabel(label),
            click: () => finish(isCurrent() ? account.credentialId : null),
          };
        }),
      ]);
      menu.popup({ window: owner, callback: cancel });
    } catch {
      cancel();
    }
  };
  target.on("select-webauthn-account", select);
  return () => {
    target.removeListener("select-webauthn-account", select);
    cancelPending?.();
  };
}
