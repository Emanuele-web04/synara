import type { GlobalShortcut } from "electron";

import type { ComputerInputMonitorState } from "./escapeKillSwitchMonitor";

type LinuxEscapeSession = "x11" | "wayland" | "unknown";
type ShortcutRegistry = Pick<
  GlobalShortcut,
  "register" | "unregister" | "isRegistered" | "isSuspended"
>;

/** Inspect the existing desktop configuration without changing its display backend. */
export function linuxEscapeSession(
  ozonePlatform = "",
  environment: NodeJS.ProcessEnv = process.env,
): LinuxEscapeSession {
  const platform = ozonePlatform.trim().toLowerCase();
  const session = environment.XDG_SESSION_TYPE?.trim().toLowerCase();
  // An XWayland key grab cannot cover applications outside that X server.
  if (platform === "wayland" || session === "wayland" || environment.WAYLAND_DISPLAY?.trim())
    return "wayland";
  if (!environment.DISPLAY?.trim()) return "unknown";
  if (platform && platform !== "x11" && platform !== "auto") return "unknown";
  if (session && session !== "x11") return "unknown";
  return platform === "x11" || session === "x11" ? "x11" : "unknown";
}

export interface LinuxEscapeKillSwitchMonitorOptions {
  readonly shortcutRegistry: ShortcutRegistry;
  readonly sessionType: LinuxEscapeSession;
  readonly onEscape: () => void;
  readonly onStateChange?: (state: ComputerInputMonitorState) => void;
  readonly onError?: (message: string) => void;
}

/**
 * A task-scoped X11 Escape shortcut for the packaged Linux app. Unlike the
 * macOS event tap, this consumes Escape and does not observe physical input or
 * human takeover. The host owns task attribution, arming and the native stop.
 *
 * Electron 43's portal registration reports a local callback, not a successful
 * compositor binding, and single-shortcut unregister does not clear that map.
 * Do not claim a working kill switch or reserve a persistent key on Wayland.
 */
export class LinuxEscapeKillSwitchMonitor {
  #options: LinuxEscapeKillSwitchMonitorOptions;
  #armed = false;
  #registered = false;
  #disposed = false;
  #registration = 0;
  #state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };

  constructor(options: LinuxEscapeKillSwitchMonitorOptions) {
    this.#options = options;
  }

  get state(): ComputerInputMonitorState {
    if (this.#state.ready) {
      try {
        if (this.#options.shortcutRegistry.isSuspended()) {
          this.#unavailable("linux_escape_shortcut_suspended", "The Escape shortcut is suspended.");
        } else if (!this.#options.shortcutRegistry.isRegistered("Escape")) {
          this.#registered = false;
          this.#unavailable("linux_escape_shortcut_lost", "The Escape shortcut was unregistered.");
        }
      } catch {
        this.#unavailable("linux_escape_registration_failed", "Cannot check the Escape shortcut.");
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
    if (this.#options.sessionType !== "x11") {
      this.#unavailable(
        this.#options.sessionType === "wayland"
          ? "linux_escape_portal_unverified"
          : "linux_escape_session_unavailable",
        "A global Escape stop cannot be confirmed for this Linux desktop session. " +
          "Computer browser actions remain unavailable; observation is still allowed.",
      );
      return;
    }
    if (this.#registered && this.state.ready) return;
    // After suspension/loss, obtain a fresh OS registration. Electron's local
    // registration map alone cannot prove its attempt to resume the key grab.
    if (!this.#release()) return;
    const registry = this.#options.shortcutRegistry;
    try {
      if (registry.isSuspended()) {
        this.#unavailable("linux_escape_shortcut_suspended", "The Escape shortcut is suspended.");
        return;
      }
      if (registry.isRegistered("Escape")) {
        this.#unavailable(
          "linux_escape_shortcut_conflict",
          "Escape is already reserved by another feature. Computer browser actions remain unavailable.",
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
          "linux_escape_registration_failed",
          "The desktop could not reserve Escape. Computer browser actions remain unavailable.",
        );
        return;
      }
      this.#setState({ ready: true });
    } catch {
      this.#unavailable(
        "linux_escape_registration_failed",
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
    this.#unavailable("linux_escape_release_failed", "The Escape shortcut could not be released.");
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
