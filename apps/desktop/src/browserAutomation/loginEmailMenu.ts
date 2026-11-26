import {
  BrowserWindow,
  Menu,
  type IpcMainEvent,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { BROWSER_IPC_CHANNELS } from "../ipcChannels";
import { literalMenuLabel } from "../contextMenuTemplate";
import type { BrowserEmailHistory } from "./browserEmailHistory";
import type { BrowserVault } from "./browserVault";
import { isLoginEmail, type LoginFieldChoice, type LoginFieldChoiceRequest } from "./loginEmail";

function isChoiceRequest(value: unknown): value is LoginFieldChoiceRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<LoginFieldChoiceRequest>;
  return (
    (input.field === "email" || input.field === "username" || input.field === "password") &&
    typeof input.prefix === "string" &&
    input.prefix.length <= 1024 &&
    (input.formUsername === undefined ||
      (typeof input.formUsername === "string" && input.formUsername.length <= 1024)) &&
    typeof input.acceptsPassword === "boolean" &&
    (input.field !== "password" || (input.prefix === "" && input.acceptsPassword))
  );
}

export function registerLoginEmailMenu(
  contents: WebContents,
  history: Pick<BrowserEmailHistory, "matching" | "remember">,
  vault: Pick<BrowserVault, "savedLoginsForOrigin" | "fillSelectedLogin">,
  isHumanControlled: () => boolean,
  protectDocument: () => { ready: Promise<void>; release(): void },
): () => void {
  let menu: Menu | undefined;
  let navigation = 0;
  let disposed = false;
  let releaseDocument: (() => void) | undefined;
  const ipc = contents.ipc;
  const currentOrigin = (frame: WebFrameMain | null) => {
    if (
      disposed ||
      contents.isDestroyed() ||
      !frame ||
      frame.detached ||
      frame !== contents.mainFrame ||
      !isHumanControlled()
    )
      return null;
    const url = URL.parse(frame.url);
    if (!url || frame.origin !== url.origin) return null;
    if (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      return url.origin;
    return null;
  };
  const remember = (event: IpcMainEvent, value: unknown) => {
    const origin = currentOrigin(event.senderFrame);
    if (origin && contents.isFocused()) void history.remember(origin, value).catch(() => {});
  };
  ipc.on(BROWSER_IPC_CHANNELS.email.remember, remember);
  ipc.handle(BROWSER_IPC_CHANNELS.email.choose, async (event, request: unknown) => {
    const frame = event.senderFrame;
    const origin = currentOrigin(frame);
    if (!origin || !isChoiceRequest(request) || !contents.isFocused()) return null;
    const owner = BrowserWindow.getFocusedWindow();
    const startedAt = navigation;
    const current = () =>
      owner &&
      BrowserWindow.getFocusedWindow() === owner &&
      navigation === startedAt &&
      currentOrigin(frame) === origin;
    const [addresses, accounts] = await Promise.all([
      request.field !== "password" ? history.matching(origin, request.prefix).catch(() => []) : [],
      vault.savedLoginsForOrigin(origin).catch(() => []),
    ]);
    if (!current() || !owner || !contents.isFocused() || menu) return null;
    const prefix = request.prefix.toLowerCase();
    const matches = accounts.filter(
      ({ username }) =>
        username &&
        (request.field !== "email" || isLoginEmail(username)) &&
        !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(username) &&
        username.toLowerCase().startsWith(prefix) &&
        (request.formUsername === undefined || username === request.formUsername),
    );
    const historyOnly = addresses.filter(
      (address) =>
        !matches.some((entry) => entry.username === address) &&
        (request.formUsername === undefined || address === request.formUsername),
    );
    if (!matches.length && !historyOnly.length) return null;

    const fill = async (id: string, username: string) => {
      if (!current()) return null;
      // An email-first form only receives the username. The password step gets its own selection.
      if (!request.acceptsPassword) {
        const available = await vault.savedLoginsForOrigin(origin);
        return current() &&
          available.some((account) => account.id === id && account.username === username)
          ? { username }
          : null;
      }
      const protection = protectDocument();
      let filled = false;
      try {
        await protection.ready;
        if (!current()) return null;
        const login = await vault.fillSelectedLogin(origin, id, username);
        if (!login || !current()) return null;
        releaseDocument?.();
        releaseDocument = protection.release;
        filled = true;
        return login;
      } finally {
        if (!filled) protection.release();
      }
    };
    return new Promise<LoginFieldChoice | null>((resolve) => {
      const template: MenuItemConstructorOptions[] = [];
      if (matches.length) {
        template.push({ label: "Saved logins", enabled: false });
        for (const { id, username } of matches) {
          template.push({
            label: literalMenuLabel(username),
            click: () => resolve(fill(id, username).catch(() => null)),
          });
        }
        if (historyOnly.length) template.push({ type: "separator" });
      }
      for (const username of historyOnly) {
        template.push({
          label: literalMenuLabel(username),
          click: () => resolve(current() ? { username } : null),
        });
      }
      try {
        menu = Menu.buildFromTemplate(template);
        menu.popup({
          window: owner,
          callback: () => {
            menu = undefined;
            resolve(null);
          },
        });
      } catch {
        menu = undefined;
        resolve(null);
      }
    });
  });
  const onNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ) => {
    if (!details.isMainFrame) return;
    navigation++;
    menu?.closePopup();
  };
  const release = () => {
    releaseDocument?.();
    releaseDocument = undefined;
  };
  contents.on("did-start-navigation", onNavigation);
  // A failed or same-document navigation can leave a filled field on the screen.
  contents.on("did-navigate", release);
  return () => {
    disposed = true;
    release();
    menu?.closePopup();
    contents.removeListener("did-navigate", release);
    contents.removeListener("did-start-navigation", onNavigation);
    ipc.removeListener(BROWSER_IPC_CHANNELS.email.remember, remember);
    ipc.removeHandler(BROWSER_IPC_CHANNELS.email.choose);
  };
}
