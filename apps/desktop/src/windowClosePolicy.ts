// FILE: windowClosePolicy.ts
// Purpose: Decide when closing the main window hides it instead of closing, so
//          macOS keeps the app and its running chats alive.
// Layer: Desktop main process

export interface DesktopWindowCloseState {
  readonly platform: NodeJS.Platform;
  readonly quitting: boolean;
  readonly shutdownComplete: boolean;
  readonly updaterHandoffActive: boolean;
  readonly updaterInstallPreparing: boolean;
}

/** macOS hides an ordinary close; a quit or updater-owned close must go through. */
export function shouldHideMainWindowOnClose(state: DesktopWindowCloseState): boolean {
  return (
    state.platform === "darwin" &&
    !state.quitting &&
    !state.shutdownComplete &&
    !state.updaterHandoffActive &&
    !state.updaterInstallPreparing
  );
}
