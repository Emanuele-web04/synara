// Owns the native macOS updater callback for one explicit install attempt.
// electron-updater still owns the verified ZIP proxy; recovery removes our callback.

type NativeMacUpdater = {
  once(event: "update-downloaded", listener: () => void): unknown;
  removeListener(event: "update-downloaded", listener: () => void): unknown;
  checkForUpdates(): void;
  quitAndInstall(): void;
};

const RELAUNCH_REQUIRED_MESSAGE =
  "Restart Synara before trying to install another update. The previous installer handoff did not finish.";

export class MacUpdateInstallHandoff {
  private downloadedListener: (() => void) | null = null;
  private relaunchRequired = false;

  constructor(
    private readonly nativeUpdater: NativeMacUpdater,
    private readonly onError: (error: unknown) => void,
  ) {}

  get blockedReason(): string | null {
    return this.relaunchRequired ? RELAUNCH_REQUIRED_MESSAGE : null;
  }

  // Always fetch the current proxy; native Squirrel may retain a previous attempt's payload.
  start(): void {
    if (this.blockedReason !== null) throw new Error(this.blockedReason);
    if (this.downloadedListener !== null) throw new Error("An update install is already pending.");
    const downloaded = () => {
      if (this.downloadedListener !== downloaded) return;
      try {
        this.nativeUpdater.quitAndInstall();
      } catch (error) {
        this.cancel();
        this.onError(error);
      }
    };
    this.downloadedListener = downloaded;
    this.nativeUpdater.once("update-downloaded", downloaded);
    try {
      this.nativeUpdater.checkForUpdates();
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  // The failed native request cannot be cancelled safely, so only a fresh process can retry.
  cancel(): void {
    if (this.downloadedListener === null) return;
    this.nativeUpdater.removeListener("update-downloaded", this.downloadedListener);
    this.downloadedListener = null;
    this.relaunchRequired = true;
  }
}
