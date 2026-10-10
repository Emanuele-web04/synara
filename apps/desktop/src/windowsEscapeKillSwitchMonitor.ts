import type { GlobalShortcut } from "electron";

import type { ComputerInputMonitorState } from "./escapeKillSwitchMonitor";

type ShortcutRegistry = Pick<
  GlobalShortcut,
  "register" | "unregister" | "isRegistered" | "isSuspended"
>;

export interface WindowsEscapeKillSwitchMonitorOptions {
  readonly shortcutRegistry: ShortcutRegistry;
  readonly onEscape: () => void;
  readonly onStateChange?: (state: ComputerInputMonitorState) => void;
  readonly onError?: (message: string) => void;
}

/**
 * A task-scoped Windows Escape shortcut for the packaged Windows app. Unlike the
 * macOS event tap, this consumes Escape and does not observe physical input.
 */
export class WindowsEscapeKillSwitchMonitor {
  #options: WindowsEscapeKillSwitchMonitorOptions;
  #armed = false;
  #registered = false;
  #disposed = false;
  #registration = 0;
  #state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };

  constructor(options: WindowsEscapeKillSwitchMonitorOptions) {
    this.#options = options;
  }

  get state(): ComputerInputMonitorState {
    if (this.#state.ready) {
      try {
        if (this.#options.shortcutRegistry.isSuspended()) {
          this.#unavailable(
            "windows_escape_shortcut_suspended",
            "The Escape shortcut is suspended.",
          );
        } else if (!this.#options.shortcutRegistry.isRegistered("Escape")) {
          this.#registered = false;
          this.#unavailable(
            "windows_escape_shortcut_lost",
            "The Escape shortcut was unregistered.",
          );
        }
      } catch {
        this.#unavailable(
          "windows_escape_registration_failed",
          "Cannot check the Escape shortcut.",
        );
      }
    }
    return this.#state;
  }

  activate(): Promise<void> {
    this.setArmed(true);
    return Promise.resolve();
  }

  setArmed(armed: boolean): void {
    if (this.#disposed) return;
    this.#armed = armed;
    if (!armed) {
      this.#registration += 1;
      if (this.#release()) this.#setState({ ready: false, error: "input_monitor_idle" });
      return;
    }
    if (this.#registered && this.state.ready) return;
    if (!this.#release()) return;

    const registry = this.#options.shortcutRegistry;
    try {
      if (registry.isSuspended()) {
        this.#unavailable("windows_escape_shortcut_suspended", "The Escape shortcut is suspended.");
        return;
      }
      if (registry.isRegistered("Escape")) {
        this.#unavailable(
          "windows_escape_shortcut_conflict",
          "Escape is already reserved by another feature. Computer actions remain unavailable.",
        );
        return;
      }
      const registration = ++this.#registration;
      this.#registered = registry.register("Escape", () => {
        if (
          !this.#disposed &&
          this.#armed &&
          this.#registered &&
          registration === this.#registration &&
          this.state.ready
        )
          this.#options.onEscape();
      });
      if (!this.#registered) {
        this.#unavailable(
          "windows_escape_registration_failed",
          "The desktop could not reserve Escape. Computer actions remain unavailable.",
        );
        return;
      }
      this.#setState({ ready: true });
    } catch {
      this.#unavailable(
        "windows_escape_registration_failed",
        "The desktop could not register the Escape shortcut.",
      );
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#armed = false;
    this.#registration += 1;
    if (this.#release()) this.#setState({ ready: false, error: "input_monitor_stopped" });
  }

  #release(): boolean {
    if (!this.#registered) return true;
    try {
      this.#options.shortcutRegistry.unregister("Escape");
      if (!this.#options.shortcutRegistry.isRegistered("Escape")) {
        this.#registered = false;
        return true;
      }
    } catch {
      // Keep ownership so disposal can retry releasing this one shortcut.
    }
    this.#unavailable(
      "windows_escape_release_failed",
      "The Escape shortcut could not be released.",
    );
    return false;
  }

  #unavailable(error: string, message: string): void {
    if (this.#state.error === error) return;
    this.#setState({ ready: false, error });
    this.#options.onError?.(message);
  }

  #setState(state: ComputerInputMonitorState): void {
    if (this.#state.ready === state.ready && this.#state.error === state.error) return;
    this.#state = state;
    this.#options.onStateChange?.(state);
  }
}
