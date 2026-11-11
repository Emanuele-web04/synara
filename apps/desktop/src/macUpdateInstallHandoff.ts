// Owns native macOS staging and relaunch for one explicit install attempt.
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
  private phase: "idle" | "preparing" | "prepared" | "installing" | "blocked" = "idle";
  private cancelPreparation: ((error: unknown) => void) | null = null;

  constructor(private readonly nativeUpdater: NativeMacUpdater) {}

  get blockedReason(): string | null {
    return this.phase === "blocked" ? RELAUNCH_REQUIRED_MESSAGE : null;
  }

  // Always fetch the current proxy; native Squirrel may retain a previous attempt's payload.
  async prepare(timeoutMs: number): Promise<void> {
    if (this.blockedReason !== null) throw new Error(this.blockedReason);
    if (this.phase !== "idle") throw new Error("An update install is already pending.");
    this.phase = "preparing";
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.nativeUpdater.removeListener("update-downloaded", downloaded);
        this.cancelPreparation = null;
      };
      const downloaded = () => {
        if (this.phase !== "preparing") return;
        cleanup();
        this.phase = "prepared";
        resolve();
      };
      const timeout = setTimeout(
        () => this.cancel(new Error("Timed out preparing the update for macOS.")),
        timeoutMs,
      );
      this.cancelPreparation = (error) => {
        cleanup();
        reject(error);
      };
      this.nativeUpdater.once("update-downloaded", downloaded);
      try {
        this.nativeUpdater.checkForUpdates();
      } catch (error) {
        this.cancel(error);
      }
    });
  }

  quitAndInstall(): void {
    if (this.phase !== "prepared") throw new Error("The macOS update is not ready to install.");
    this.phase = "installing";
    try {
      this.nativeUpdater.quitAndInstall();
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  // The failed native request cannot be cancelled safely, so only a fresh process can retry.
  cancel(error: unknown = new Error("macOS update preparation was cancelled.")): void {
    if (this.phase === "idle") return;
    this.phase = "blocked";
    this.cancelPreparation?.(error);
  }
}
