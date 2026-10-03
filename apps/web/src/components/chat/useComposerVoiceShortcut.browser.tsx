import { useRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { useComposerVoiceShortcut } from "./useComposerVoiceShortcut";
import type { ResolvedKeybindingsConfig } from "@synara/contracts";

const shortcut = {
  key: " ",
  altKey: true,
  modKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};
let screen: Awaited<ReturnType<typeof render>>;
afterEach(async () => {
  await screen?.unmount();
});

function Harness({
  hold = false,
  enabled = true,
  pending = false,
  terminalOpen = false,
  sessionId = "thread-a",
  startup,
  startups,
  initialState = "idle",
}: {
  hold?: boolean;
  enabled?: boolean;
  pending?: boolean;
  terminalOpen?: boolean;
  sessionId?: string;
  startup?: Promise<void>;
  startups?: readonly Promise<void>[];
  initialState?: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [state, setState] = useState(initialState);
  const [starts, setStarts] = useState(0);
  const keybindings: ResolvedKeybindingsConfig = [
    {
      command: hold ? "composer.voice.hold" : "composer.voice.toggle",
      shortcut,
      ...(terminalOpen ? { whenAst: { type: "identifier" as const, name: "terminalOpen" } } : {}),
    },
  ];
  useComposerVoiceShortcut({
    enabled,
    sessionId,
    context: { terminalOpen },
    canHandleEvent: (event) =>
      event.target instanceof Node && Boolean(form.current?.contains(event.target)),
    keybindings,
    isRecording: state === "recording",
    isStarting: state === "starting",
    isTranscribing: false,
    onStart: async () => {
      setStarts((n) => n + 1);
      setState(pending ? "starting" : "recording");
      await (startups?.[starts] ?? startup);
    },
    onSubmit: () => {
      setState("transcribed");
    },
    onCancel: () => {
      setState("cancelled");
    },
  });
  return (
    <form ref={form}>
      <input aria-label="Prompt" />
      <output>
        {state}:{starts}
      </output>
    </form>
  );
}
function key(type: "keydown" | "keyup", overrides: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, {
    key: " ",
    code: "Space",
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  document.querySelector("input")!.dispatchEvent(event);
  return event;
}
async function state(value: string) {
  await expect.poll(() => document.querySelector("output")?.textContent).toBe(value);
}

it("toggles dictation in the composer and consumes auto-repeat without restarting", async () => {
  screen = await render(<Harness />);
  expect(key("keydown").defaultPrevented).toBe(true);
  await state("recording:1");
  expect(key("keydown", { repeat: true }).defaultPrevented).toBe(true);
  key("keyup");
  await state("recording:1");
  key("keydown");
  await state("transcribed:1");
});
it("transcribes on key release after recording state rerenders", async () => {
  screen = await render(<Harness hold />);
  key("keydown");
  await state("recording:1");
  key("keyup", { altKey: false });
  await state("transcribed:1");
});
it("finishes a held recording when its modifier is released first", async () => {
  screen = await render(<Harness hold />);
  key("keydown");
  await state("recording:1");
  key("keyup", { key: "Alt", code: "AltLeft", altKey: false });
  await state("transcribed:1");
});
it("cancels pending microphone startup on early release", async () => {
  screen = await render(<Harness hold pending />);
  key("keydown");
  await state("starting:1");
  key("keyup");
  await state("cancelled:1");
});
it("cancels a held recording when the window loses focus", async () => {
  screen = await render(<Harness hold />);
  key("keydown");
  await state("recording:1");
  window.dispatchEvent(new Event("blur"));
  await state("cancelled:1");
});
it("leaves events alone when voice is unavailable or IME composition is active", async () => {
  screen = await render(<Harness enabled={false} />);
  expect(key("keydown").defaultPrevented).toBe(false);
  await state("idle:0");
  await screen.unmount();
  screen = await render(<Harness />);
  expect(key("keydown", { isComposing: true }).defaultPrevented).toBe(false);
  await state("idle:0");
});
it("does not capture a shortcut targeted at another editor", async () => {
  screen = await render(<Harness />);
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: " ", code: "Space", altKey: true, bubbles: true }),
  );
  await state("idle:0");
  input.remove();
});

it("uses the active terminal context to resolve conditional voice bindings", async () => {
  screen = await render(<Harness terminalOpen />);
  expect(key("keydown").defaultPrevented).toBe(true);
  await state("recording:1");
});

it("cancels a held recording when its composer becomes disabled", async () => {
  screen = await render(<Harness hold />);
  key("keydown");
  await state("recording:1");
  await screen.rerender(<Harness hold enabled={false} />);
  await state("cancelled:1");
  expect(key("keydown").defaultPrevented).toBe(false);
});

it("cancels a held recording on navigation", async () => {
  screen = await render(<Harness hold />);
  key("keydown");
  await state("recording:1");
  await screen.rerender(<Harness hold sessionId="thread-b" />);
  await state("cancelled:1");
});

it("does not submit after an early release and late microphone startup completion", async () => {
  let resolve!: () => void;
  const startup = new Promise<void>((done) => {
    resolve = done;
  });
  screen = await render(<Harness hold pending startup={startup} />);
  key("keydown");
  await state("starting:1");
  key("keyup");
  await state("cancelled:1");
  resolve();
  await startup;
  await state("cancelled:1");
});

it("can retry after cancelling an unresolved microphone startup", async () => {
  let resolve!: () => void;
  const startup = new Promise<void>((done) => {
    resolve = done;
  });
  screen = await render(<Harness hold pending startup={startup} />);
  key("keydown");
  await state("starting:1");
  key("keyup");
  await state("cancelled:1");
  key("keydown");
  await state("starting:2");
  key("keyup");
  resolve();
  await startup;
  await state("cancelled:2");
});

it("ignores an old startup failure after a new hold begins", async () => {
  let rejectFirst!: (error: Error) => void;
  let resolveSecond!: () => void;
  const first = new Promise<void>((_, reject) => {
    rejectFirst = reject;
  });
  const second = new Promise<void>((resolve) => {
    resolveSecond = resolve;
  });
  screen = await render(<Harness hold pending startups={[first, second]} />);
  key("keydown");
  await state("starting:1");
  key("keyup");
  await state("cancelled:1");
  key("keydown");
  await state("starting:2");
  rejectFirst(new Error("Old startup cancelled"));
  await first.catch(() => undefined);
  await state("starting:2");
  key("keyup");
  resolveSecond();
  await second;
  await state("cancelled:2");
});

const escape = { key: "Escape", code: "Escape", altKey: false };

it.each([false, true])("Escape cancels dictation instead of submitting (hold=%s)", async (hold) => {
  screen = await render(<Harness hold={hold} />);
  key("keydown");
  await state("recording:1");
  expect(key("keydown", escape).defaultPrevented).toBe(true);
  await state("cancelled:1");
  key("keyup");
  await state("cancelled:1");
});

it("Escape cancels pending startup and permits an immediate retry", async () => {
  let resolve!: () => void;
  const startup = new Promise<void>((done) => {
    resolve = done;
  });
  screen = await render(<Harness pending startup={startup} />);
  key("keydown");
  await state("starting:1");
  expect(key("keydown", escape).defaultPrevented).toBe(true);
  await state("cancelled:1");
  key("keydown");
  await state("starting:2");
  resolve();
  await startup;
  key("keydown", escape);
  await state("cancelled:2");
});

it("Escape cancels dictation started by the microphone button", async () => {
  screen = await render(<Harness initialState="recording" />);
  expect(key("keydown", escape).defaultPrevented).toBe(true);
  await state("cancelled:0");
});

it("leaves Escape available when idle or targeted at another editor", async () => {
  screen = await render(<Harness />);
  expect(key("keydown", escape).defaultPrevented).toBe(false);
  await screen.rerender(<Harness initialState="recording" />);
  key("keydown");
  await state("recording:1");
  const input = document.createElement("input");
  document.body.append(input);
  const event = new KeyboardEvent("keydown", { ...escape, bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  await state("recording:1");
  input.remove();
});
