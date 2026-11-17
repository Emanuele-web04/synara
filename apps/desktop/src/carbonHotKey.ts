/**
 * Electron `globalShortcut` replacement for the standalone macOS CUA host.
 *
 * `RegisterEventHotKey` performs the same exclusive system-wide grab
 * Electron uses: registering an accelerator another app (or macOS) owns
 * fails, and the press is consumed before it reaches the frontmost app.
 * The difference is delivery: Electron has a running event loop, this host
 * is a plain Node process, so a timer pumps the Carbon event queue
 * (`ReceiveNextEvent` + `SendEventToEventTarget`) to dispatch presses to
 * the installed handler.
 *
 * Only key chords travel this path; the `both-option-keys` AppSnap
 * shortcut is detected inside the appsnap helper's own event tap.
 */

import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";

// kEventHotKeyPressed, delivered under class kEventClassKeyboard ('keyb').
const K_EVENT_HOTKEY_PRESSED = 6;
const K_EVENT_CLASS_HOTKEY = 0x6b657962;
// EventHotKeyID.signature — arbitrary owner tag checked on dispatch.
const HOTKEY_SIGNATURE = 0x736e6b79; // 'snky'
// Modifier mask bits, same values Carbon uses.
const MODIFIER_BITS: Readonly<Record<string, number>> = {
  Command: 0x0100,
  Shift: 0x0200,
  Alt: 0x0800,
  Control: 0x1000,
};

// ANSI virtual key codes for every key AppSnap chords allow: letters,
// digits, Space, Return, Tab, Esc, and the four arrows.
const KEY_CODES: Readonly<Record<string, number>> = {
  // Letters (Electron accelerators spell them without the KeyX prefix).
  A: 0x00,
  S: 0x01,
  D: 0x02,
  F: 0x03,
  H: 0x04,
  G: 0x05,
  Z: 0x06,
  X: 0x07,
  C: 0x08,
  V: 0x09,
  B: 0x0b,
  Q: 0x0c,
  W: 0x0d,
  E: 0x0e,
  R: 0x0f,
  Y: 0x10,
  T: 0x11,
  O: 0x1f,
  U: 0x20,
  I: 0x22,
  P: 0x23,
  L: 0x25,
  J: 0x26,
  K: 0x28,
  N: 0x2d,
  M: 0x2e,
  // Digit accelerators arrive bare (no "Digit" prefix in Electron form).
  "1": 0x12,
  "2": 0x13,
  "3": 0x14,
  "4": 0x15,
  "6": 0x16,
  "5": 0x17,
  "9": 0x19,
  "7": 0x1a,
  "8": 0x1c,
  "0": 0x1d,
  // Named keys as ELECTRON_KEY_NAMES spells them upstream.
  Space: 0x31,
  Return: 0x24,
  Tab: 0x30,
  Esc: 0x35,
  Up: 0x7e,
  Down: 0x7d,
  Left: 0x7b,
  Right: 0x7c,
};

const CARBON = "/System/Library/Frameworks/Carbon.framework/Carbon";

interface CarbonApi {
  symbols: {
    RegisterEventHotKey: (
      keyCode: number,
      modifiers: number,
      hotKeyId: number,
      target: number,
      options: number,
      outRef: number,
    ) => number;
    UnregisterEventHotKey: (ref: number) => number;
    InstallEventHandler: (
      target: number,
      handler: number,
      numTypes: number,
      list: number,
      userData: number,
      outRef: number,
    ) => number;
    RemoveEventHandler: (handlerRef: number) => number;
    GetApplicationEventTarget: () => number;
    GetEventDispatcherTarget: () => number;
    ReceiveNextEvent: (
      numTypes: number,
      list: number,
      timeout: number,
      pullEvent: boolean,
      outEvent: number,
    ) => number;
    SendEventToEventTarget: (event: number, target: number) => number;
    ReleaseEvent: (event: number) => number;
  };
}

function loadCarbon(): CarbonApi {
  return dlopen(CARBON, {
    RegisterEventHotKey: {
      args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    UnregisterEventHotKey: { args: [FFIType.ptr], returns: FFIType.i32 },
    InstallEventHandler: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    RemoveEventHandler: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetApplicationEventTarget: { args: [], returns: FFIType.ptr },
    GetEventDispatcherTarget: { args: [], returns: FFIType.ptr },
    ReceiveNextEvent: {
      args: [FFIType.u32, FFIType.ptr, FFIType.f64, FFIType.bool, FFIType.ptr],
      returns: FFIType.i32,
    },
    SendEventToEventTarget: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ReleaseEvent: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
}

/**
 * Parses an Electron accelerator (`Alt+K`, `Command+Space`, `Control+5`,
 * `Shift+Up`) into the Carbon modifier mask and virtual key code. Returns
 * null for anything outside the shapes AppSnap produces.
 */
function parseAccelerator(accelerator: string): { modifiers: number; keyCode: number } | null {
  const parts = accelerator.split("+");
  if (parts.length < 2) return null;
  const key = parts[parts.length - 1];
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIER_BITS[part];
    if (bit === undefined) return null;
    modifiers |= bit;
  }
  const keyCode = KEY_CODES[key];
  if (keyCode === undefined) return null;
  return { modifiers, keyCode };
}

interface RegisteredHotKey {
  ref: number;
  handlerRefOut: ArrayBuffer;
  handler: JSCallback;
}

export interface CarbonShortcutRegistry {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
  dispose: () => void;
}

export function createCarbonShortcutRegistry(): CarbonShortcutRegistry {
  const carbon = loadCarbon();
  const registrations = new Map<string, RegisteredHotKey>();
  let nextId = 1;
  let pump: ReturnType<typeof setInterval> | undefined;

  const eventOut = new ArrayBuffer(8);
  const eventOutPtr = ptr(eventOut);
  const refOut = new ArrayBuffer(8);
  const refOutPtr = ptr(refOut);
  const idSpec = new Uint32Array(2);
  idSpec[0] = HOTKEY_SIGNATURE;
  const idSpecPtr = ptr(idSpec.buffer);
  const spec = new Uint32Array([K_EVENT_CLASS_HOTKEY, K_EVENT_HOTKEY_PRESSED]);

  function ensurePump(): void {
    if (pump) return;
    pump = setInterval(() => {
      // Drain queued Carbon events; each press lands here as a queued event
      // whose dispatch calls the installed handler.
      for (;;) {
        const status = carbon.symbols.ReceiveNextEvent(0, 0, 0, true, eventOutPtr);
        if (status !== 0) return;
        const event = Number(new DataView(eventOut).getBigUint64(0, true));
        if (event === 0) return;
        carbon.symbols.SendEventToEventTarget(event, carbon.symbols.GetEventDispatcherTarget());
        carbon.symbols.ReleaseEvent(event);
      }
    }, 40);
    if (typeof pump === "object" && pump && "unref" in pump) pump.unref();
  }

  return {
    register(accelerator, callback) {
      if (registrations.has(accelerator)) return false;
      const parsed = parseAccelerator(accelerator);
      if (!parsed) return false;
      const id = nextId++;
      idSpec[1] = id;
      const status = carbon.symbols.RegisterEventHotKey(
        parsed.keyCode,
        parsed.modifiers,
        idSpecPtr,
        carbon.symbols.GetApplicationEventTarget(),
        0,
        refOutPtr,
      );
      if (status !== 0) return false;
      const ref = Number(new DataView(refOut).getBigUint64(0, true));
      // One handler per registration carries the callback in its closure;
      // presses dispatch straight to it — no EventHotKeyID round-trip.
      const handler = new JSCallback(
        () => {
          callback();
          return 0;
        },
        { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      );
      const handlerRefOut = new ArrayBuffer(8);
      const installed = carbon.symbols.InstallEventHandler(
        carbon.symbols.GetApplicationEventTarget(),
        handler.ptr,
        1,
        ptr(spec.buffer),
        0,
        ptr(handlerRefOut),
      );
      if (installed !== 0) {
        carbon.symbols.UnregisterEventHotKey(ref);
        handler.close();
        return false;
      }
      registrations.set(accelerator, { ref, handlerRefOut, handler });
      ensurePump();
      return true;
    },

    unregister(accelerator) {
      const registration = registrations.get(accelerator);
      if (!registration) return;
      registrations.delete(accelerator);
      carbon.symbols.UnregisterEventHotKey(registration.ref);
      const handlerRef = Number(new DataView(registration.handlerRefOut).getBigUint64(0, true));
      if (handlerRef !== 0) carbon.symbols.RemoveEventHandler(handlerRef);
      registration.handler.close();
    },

    dispose() {
      for (const accelerator of registrations.keys()) this.unregister(accelerator);
      if (pump) {
        clearInterval(pump);
        pump = undefined;
      }
    },
  };
}
