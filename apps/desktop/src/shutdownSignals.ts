export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/**
 * Electron installs its own SIGHUP/SIGINT/SIGTERM handlers after the main
 * script has run (PostCreateMainMessageLoop) and turns each signal into
 * app.quit(), which goes through before-quit and the quit confirmation. A
 * handler registered at module load is replaced before the app is ready,
 * and a second registration after that point does not reinstall it,
 * because Node keeps one signal watcher per signal name. Registering only
 * once the app is ready puts Node's handler in front of Electron's, so a
 * signal from a terminal or a script reaches `onSignal` and shuts the app
 * down without asking.
 */
export function installShutdownSignalHandlers(
  ready: Promise<unknown>,
  onSignal: (signal: ShutdownSignal) => void,
  target: Pick<NodeJS.Process, "on"> = process,
): void {
  void ready.then(() => {
    for (const signal of SHUTDOWN_SIGNALS) {
      target.on(signal, () => onSignal(signal));
    }
  });
}
