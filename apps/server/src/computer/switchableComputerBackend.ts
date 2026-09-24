/**
 * A backend slot whose occupant can change after the manager was built on it.
 *
 * Two things need that on Linux. Startup must not wait for backend selection
 * and its passive probe — both ask the session bus, and a wedged bus holds
 * each question for its full D-Bus timeout, which stalled boot for about
 * twenty seconds — so the service may start on a placeholder that answers
 * "checking" and put the chosen backend in when selection finishes. And a
 * compositor backend whose desktop is gone for good (the Hyprland instance it
 * was bound to exited) can be replaced by whatever selection picks now.
 *
 * The manager binds a backend once, at construction, and reads optional
 * members by presence (`backend.waitForSettle !== undefined`), so the slot is
 * a `Proxy` rather than a class: every member read goes to the current
 * occupant, and an optional method the occupant lacks is absent here too. The
 * few members that must outlive a swap are the slot's own — the event
 * subscription, the preview stream, and disposal.
 *
 * @module computer/switchableComputerBackend
 */
import type { ComputerAvailability, ComputerHealth } from "@synara/contracts";

import {
  ComputerBackendError,
  DEFAULT_COMPUTER_ID,
  NO_COMPUTER_CAPABILITIES,
  type ComputerBackend,
  type ComputerBackendEventListener,
  type ComputerFrameListener,
} from "./ComputerBackend.ts";

/**
 * Stands in while selection is still running. It reports `checking` and
 * refuses every desktop call with a retryable error: guessing a desktop would
 * be worse than saying "not yet", and on a healthy host this window never
 * opens, because the service waits out a short budget before starting on it.
 *
 * `agentDialect` and `dedicatedSeat` are the profile every Linux tier
 * declares, so session guidance rendered during the window already describes
 * the kind of desktop selection will produce.
 */
export class CheckingComputerBackend implements ComputerBackend {
  readonly computerId = DEFAULT_COMPUTER_ID as ComputerBackend["computerId"];
  readonly agentDialect = "linux" as const;
  readonly dedicatedSeat = true;

  constructor(private readonly message: string) {}

  probeAvailability(): Promise<ComputerAvailability> {
    return Promise.resolve({ kind: "checking", message: this.message });
  }

  availability(): Promise<ComputerAvailability> {
    return this.probeAvailability();
  }

  /** The idle placeholder health: nothing connected, nothing failed. */
  health(): ComputerHealth {
    return {
      status: "unavailable",
      consecutiveFailures: 0,
      reconnects: 0,
      captureAvailable: false,
    };
  }

  capabilities() {
    return NO_COMPUTER_CAPABILITIES;
  }

  /** A pane may attach before the desktop is known; the slot replays it on swap. */
  async attachStream(): Promise<void> {}
  async detachStream(): Promise<void> {}

  listWindows = () => this.refuse();
  getScreenSize = () => this.refuse();
  getState = () => this.refuse();
  captureScreenshot = () => this.refuse();
  launchApp = () => this.refuse();
  click = () => this.refuse();
  doubleClick = () => this.refuse();
  rightClick = () => this.refuse();
  moveCursor = () => this.refuse();
  drag = () => this.refuse();
  scroll = () => this.refuse();
  typeText = () => this.refuse();
  pressKey = () => this.refuse();
  hotkey = () => this.refuse();
  setValue = () => this.refuse();
  performAction = () => this.refuse();
  selectText = () => this.refuse();

  dispose(): void {}

  private refuse(): Promise<never> {
    return Promise.reject(new ComputerBackendError(this.message, { retryable: true }));
  }
}

export interface ComputerBackendSwapOptions {
  /**
   * The old occupant drove a different desktop. Standing consent and the
   * window list the manager remembers belong to that desktop, so the slot
   * announces an interruption (the manager revokes task grants on it) and an
   * empty window list before the new occupant reports its own.
   */
  readonly desktopChanged?: boolean;
}

export class SwitchableComputerBackend {
  /** What the manager is built on; every read resolves against the occupant. */
  readonly backend: ComputerBackend;

  private occupant: ComputerBackend;
  private readonly listeners = new Set<ComputerBackendEventListener>();
  private unsubscribeOccupant: (() => void) | undefined;
  private streamListener: ComputerFrameListener | undefined;
  private disposed = false;

  constructor(
    initial: ComputerBackend,
    private readonly options: {
      /** The occupant reported its desktop gone for good; see `desktop-gone`. */
      readonly onDesktopGone?: (backend: ComputerBackend, message: string) => void;
    } = {},
  ) {
    this.occupant = initial;
    this.subscribe(initial);
    const own: Partial<Record<keyof ComputerBackend, unknown>> = {
      onEvent: (listener: ComputerBackendEventListener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      attachStream: async (listener: ComputerFrameListener) => {
        this.streamListener = listener;
        await this.occupant.attachStream(listener);
      },
      detachStream: async () => {
        this.streamListener = undefined;
        await this.occupant.detachStream();
      },
      dispose: async () => {
        this.disposed = true;
        this.unsubscribeOccupant?.();
        this.listeners.clear();
        await this.occupant.dispose();
      },
    };
    this.backend = new Proxy({} as ComputerBackend, {
      get: (_target, property) => {
        if (Object.hasOwn(own, property)) return own[property as keyof ComputerBackend];
        const value: unknown = Reflect.get(this.occupant, property, this.occupant);
        return typeof value === "function" ? value.bind(this.occupant) : value;
      },
      has: (_target, property) => Object.hasOwn(own, property) || property in this.occupant,
      getPrototypeOf: () => Object.getPrototypeOf(this.occupant) as object | null,
    });
  }

  get current(): ComputerBackend {
    return this.occupant;
  }

  /**
   * Put `next` in the slot. The manager hears the new health and capability
   * set as ordinary backend events, and a preview stream that was attached to
   * the old occupant is attached to the new one. The old occupant is only
   * unsubscribed here; disposing it is the caller's decision, because the
   * placeholder has nothing to dispose and a replaced desktop backend does.
   */
  async swap(next: ComputerBackend, options: ComputerBackendSwapOptions = {}): Promise<void> {
    if (this.disposed) {
      await next.dispose();
      return;
    }
    const previous = this.occupant;
    if (previous === next) return;
    this.unsubscribeOccupant?.();
    this.occupant = next;
    this.subscribe(next);
    if (options.desktopChanged) {
      this.emit({ type: "desktop-interrupted", pauses: [] });
      this.emit({ type: "windows-changed", windows: [] });
    }
    this.emit({ type: "capabilities-changed", capabilities: next.capabilities() });
    this.emit({ type: "health-changed", health: next.health() });
    const listener = this.streamListener;
    if (listener !== undefined) {
      await previous.detachStream().catch(() => undefined);
      // A failed attach is the new occupant's to report through its health;
      // the pane's next keyframe request retries against it.
      if (this.streamListener === listener && this.occupant === next) {
        await next.attachStream(listener).catch(() => undefined);
      }
    }
  }

  private subscribe(backend: ComputerBackend): void {
    this.unsubscribeOccupant = backend.onEvent?.((event) => {
      if (backend !== this.occupant) return;
      if (event.type === "desktop-gone") {
        this.options.onDesktopGone?.(backend, event.message);
      }
      this.emit(event);
    });
  }

  private emit(event: Parameters<ComputerBackendEventListener>[0]): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One observer cannot stop the rest.
      }
    }
  }
}
