import type { ProviderRuntimeEvent } from "@synara/contracts";

/** Short, factual labels. Never display arguments, typed text, or model reasoning. */
export function cursorToolActivity(tool: string): string {
  switch (tool) {
    case "computer_click":
      return "Clicking";
    case "computer_scroll":
      return "Scrolling";
    case "computer_type_text":
      return "Typing";
    case "computer_set_value":
      return "Setting field";
    case "computer_select_text":
      return "Selecting text";
    case "computer_paste":
      return "Pasting";
    case "computer_press_key":
      return "Pressing key";
    case "computer_drag":
      return "Dragging";
    case "computer_move_cursor":
      return "Moving cursor";
    case "computer_wait":
      return "Waiting for screen";
    case "computer_screenshot":
      return "Capturing screen";
    case "computer_get_state":
      return "Reading screen";
    case "computer_get_screen_size":
      return "Measuring screen";
    case "computer_list_windows":
      return "Finding window";
    case "computer_list_apps":
      return "Listing apps";
    case "computer_set_window_frame":
      return "Moving window";
    case "computer_invoke_menu":
      return "Opening menu item";
    case "computer_verify_state":
      return "Checking state";
    case "computer_zoom":
      return "Zooming in";
    case "computer_get_accessibility_tree":
      return "Reading desktop inventory";
    case "computer_get_cursor_position":
      return "Reading cursor position";
    case "computer_kill_app":
      return "Force-quitting app";
    case "computer_set_window_minimized":
      return "Changing window visibility";
    case "computer_set_app_visibility":
      return "Changing app visibility";
    case "computer_perform_action":
      return "Activating control";
    case "computer_launch_app":
      return "Opening app";
    case "computer_activate_window":
      return "Activating window";
    case "computer_read_clipboard":
      return "Reading clipboard";
    case "computer_write_clipboard":
      return "Writing clipboard";
    case "computer_run":
      return "Running sequence";
    default:
      return "Working";
  }
}

export function cursorRuntimeActivity(event: ProviderRuntimeEvent): string | undefined {
  switch (event.type) {
    case "user-input.requested":
      return "Waiting for you";
    case "request.opened":
      return "Needs approval";
    case "user-input.resolved":
    case "request.resolved":
    case "turn.started":
    case "item.completed":
      return "Thinking";
    case "item.started":
      return "Working";
    case "content.delta":
      if (event.payload.streamKind === "assistant_text") return "Responding";
      if (
        ["reasoning_text", "reasoning_summary_text", "plan_text"].includes(event.payload.streamKind)
      )
        return "Thinking";
      return undefined;
    default:
      return undefined;
  }
}

/** Cosmetic updates never block input. Debounce brief tools and deduplicate token events. */
export class CursorActivity {
  private owner: string | null = null;
  private base = "Thinking";
  private readonly pending = new Map<symbol, { thread: string; text: string }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last: string | null | undefined;
  private disposed = false;

  constructor(private readonly publish: (text: string | null) => Promise<void> | undefined) {}

  setOwner(owner: string | null): void {
    if (this.owner === owner) return;
    this.owner = owner;
    this.base = "Thinking";
    this.schedule();
  }

  setRuntime(thread: string, text: string, resumed = false): void {
    if (thread !== this.owner || this.base === text) return;
    // Content/item events may continue arriving while a question is open.
    if (!resumed && ["Waiting for you", "Needs approval"].includes(this.base)) return;
    this.base = text;
    this.schedule();
  }

  async during<A>(thread: string, text: string, action: () => Promise<A>): Promise<A> {
    const token = Symbol();
    this.pending.set(token, { thread, text });
    this.schedule();
    try {
      this.setRuntime(thread, "Thinking");
      const result = await action();
      return result;
    } catch (error) {
      this.setRuntime(thread, "Needs attention");
      throw error;
    } finally {
      this.pending.delete(token);
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const active = [...this.pending.values()].filter((item) => item.thread === this.owner).at(-1);
      const waiting = ["Waiting for you", "Needs approval"].includes(this.base);
      const text = this.owner === null ? null : waiting ? this.base : (active?.text ?? this.base);
      if (text === this.last) return;
      this.last = text;
      // Catch synchronous and asynchronous backend failures alike.
      void Promise.resolve()
        .then(() => (this.disposed ? undefined : this.publish(text)))
        .catch(() => undefined);
    }, 80);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.pending.clear();
  }
}
