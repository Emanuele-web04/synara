// FILE: terminalModeReplay.ts
// Purpose: Tracks live terminal modes so a fresh renderer can reattach with matching input state.
// Layer: Terminal infrastructure

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } =
  require("@xterm/headless") as typeof import("@xterm/headless");

export interface TerminalModeReplayTracker {
  feed(data: string): void;
  resize(cols: number, rows: number): void;
  buildPreamble(): string;
  dispose(): void;
}

type HeadlessTerminalInternals = {
  _core?: {
    _writeBuffer?: { writeSync(data: string | Uint8Array): void };
    coreService?: { isCursorHidden?: boolean };
    optionsService?: {
      rawOptions: { vtExtensions?: { kittyKeyboard?: boolean } };
    };
  };
};

interface KittyKeyboardReplayState {
  flags: number;
  pendingSequence: string;
  stack: number[];
}

const KITTY_KEYBOARD_SEQUENCE_PATTERN = /(?:\u001b\[|\u009b)([<>=])([0-9;]*)u/g;

function parseKittyFlags(rawParams: string): number {
  const firstParam = rawParams.split(";")[0] ?? "";
  const flags = Number(firstParam);
  return Number.isInteger(flags) && flags > 0 ? flags : 0;
}

function retainPotentialKittySequenceTail(input: string, startIndex: number): string {
  const tail = input.slice(startIndex);
  const escCsiIndex = tail.lastIndexOf("\u001b[");
  const c1CsiIndex = tail.lastIndexOf("\u009b");
  const csiIndex = Math.max(escCsiIndex, c1CsiIndex);
  return csiIndex >= 0 ? tail.slice(csiIndex, csiIndex + 128) : "";
}

function feedKittyKeyboardReplayState(state: KittyKeyboardReplayState, data: string): void {
  const input = `${state.pendingSequence}${data}`;
  let processedUntil = 0;
  KITTY_KEYBOARD_SEQUENCE_PATTERN.lastIndex = 0;

  for (const match of input.matchAll(KITTY_KEYBOARD_SEQUENCE_PATTERN)) {
    processedUntil = (match.index ?? 0) + match[0].length;
    const command = match[1];
    if (command === ">") {
      state.stack.push(state.flags);
      state.flags = parseKittyFlags(match[2] ?? "");
    } else if (command === "<") {
      state.flags = state.stack.pop() ?? 0;
    } else if (command === "=") {
      state.flags = parseKittyFlags(match[2] ?? "");
      state.stack.length = 0;
    }
  }

  state.pendingSequence = retainPotentialKittySequenceTail(input, processedUntil);
}

export function createTerminalModeReplayTracker(
  cols: number,
  rows: number,
): TerminalModeReplayTracker {
  const terminal = new HeadlessTerminal({
    cols,
    rows,
    scrollback: 1,
    allowProposedApi: true,
  });
  const internals = terminal as unknown as HeadlessTerminalInternals;
  const rawOptions = internals._core?.optionsService?.rawOptions;
  const writeBuffer = internals._core?._writeBuffer;

  if (!rawOptions || typeof writeBuffer?.writeSync !== "function") {
    terminal.dispose();
    throw new Error("@xterm/headless internals unavailable for terminal mode replay");
  }

  rawOptions.vtExtensions = { kittyKeyboard: true };
  const kittyKeyboardState: KittyKeyboardReplayState = {
    flags: 0,
    pendingSequence: "",
    stack: [],
  };

  return {
    feed(data) {
      feedKittyKeyboardReplayState(kittyKeyboardState, data);
      writeBuffer.writeSync(data);
    },
    resize(cols, rows) {
      if (terminal.cols === cols && terminal.rows === rows) return;
      terminal.resize(cols, rows);
    },
    buildPreamble() {
      const modes = terminal.modes;
      const parts: string[] = [];

      if (modes.applicationCursorKeysMode) parts.push("\u001b[?1h");
      if (modes.applicationKeypadMode) parts.push("\u001b[?66h");
      if (modes.bracketedPasteMode) parts.push("\u001b[?2004h");
      if (modes.insertMode) parts.push("\u001b[4h");
      if (modes.originMode) parts.push("\u001b[?6h");
      if (modes.reverseWraparoundMode) parts.push("\u001b[?45h");
      if (modes.sendFocusMode) parts.push("\u001b[?1004h");
      if (!modes.wraparoundMode) parts.push("\u001b[?7l");
      if (internals._core?.coreService?.isCursorHidden === true) parts.push("\u001b[?25l");

      switch (modes.mouseTrackingMode) {
        case "x10":
          parts.push("\u001b[?9h");
          break;
        case "vt200":
          parts.push("\u001b[?1000h");
          break;
        case "drag":
          parts.push("\u001b[?1002h");
          break;
        case "any":
          parts.push("\u001b[?1003h");
          break;
        case "none":
          break;
      }

      if (kittyKeyboardState.flags > 0) {
        parts.push(`\u001b[=${kittyKeyboardState.flags};1u`);
      }

      return parts.join("");
    },
    dispose() {
      terminal.dispose();
    },
  };
}
