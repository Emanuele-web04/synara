import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  COMPUTER_KEY_NAME_MAX_LENGTH,
  COMPUTER_OCCLUDERS_MAX_LENGTH,
  COMPUTER_UI_TREE_MAX_DEPTH,
  COMPUTER_UI_TREE_MAX_NODES,
  ComputerAvailability,
  ComputerHealth,
  ComputerHotkeyInput,
  ComputerInputKeyInput,
  ComputerPressKeyInput,
  ComputerSetupRequiredPayload,
  ComputerState,
  ComputerWindow,
  type ComputerUiNode,
} from "./computer";

function decodes(input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(ComputerAvailability as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("ComputerAvailability permission-required", () => {
  const PERMISSION_REQUIRED = {
    kind: "permission-required",
    missing: ["accessibility", "screenRecording"],
    message: "Synara needs Accessibility and Screen Recording to control this Mac.",
    buildSignature: "adhoc",
  } as const;

  it("round-trips the grants, the message and the build signature", () => {
    const decoded = Schema.decodeUnknownSync(ComputerAvailability)(PERMISSION_REQUIRED);
    expect(decoded).toEqual(PERMISSION_REQUIRED);
    expect(Schema.encodeUnknownSync(ComputerAvailability)(decoded)).toEqual(PERMISSION_REQUIRED);
  });

  it("keeps the other availability kinds decodable", () => {
    expect(decodes({ kind: "available", backend: "mac" })).toBe(true);
    expect(decodes({ kind: "unsupported-platform", platform: "linux" })).toBe(true);
    expect(decodes({ kind: "backend-unavailable", message: "No helper." })).toBe(true);
  });

  it("refuses a permission state that names no grant", () => {
    // An empty list would render as "Computer control needs " on the card, and
    // would mean the backend reported a permission problem it cannot name — a
    // state the setup signal expresses by not producing this kind at all.
    expect(decodes({ ...PERMISSION_REQUIRED, missing: [] })).toBe(false);
  });

  it("refuses an unknown grant name and an unknown signature", () => {
    expect(decodes({ ...PERMISSION_REQUIRED, missing: ["inputMonitoring"] })).toBe(false);
    expect(decodes({ ...PERMISSION_REQUIRED, buildSignature: "notarized" })).toBe(false);
  });
});

describe("ComputerSetupRequiredPayload", () => {
  it("round-trips the tool, the grants, the build signature and the responsible app", () => {
    const payload = {
      toolName: "computer_list_windows",
      missing: ["accessibility"],
      buildSignature: "adhoc",
      bundleId: "com.emanueledipietro.synara.dev",
    } as const;
    const decoded = Schema.decodeUnknownSync(ComputerSetupRequiredPayload)(payload);
    expect(decoded).toEqual(payload);
    expect(Schema.encodeUnknownSync(ComputerSetupRequiredPayload)(decoded)).toEqual(payload);
  });

  it("accepts a payload with no signature, and refuses an unknown one", () => {
    // Backends with no permission model report none, and the card simply says
    // nothing about stale grants — but "notarized" is a value nothing produces,
    // and reading it as ad-hoc would put a Terminal command in front of a
    // release user.
    const decodes = (input: unknown): boolean => {
      try {
        Schema.decodeUnknownSync(ComputerSetupRequiredPayload as never)(input);
        return true;
      } catch {
        return false;
      }
    };
    expect(decodes({ toolName: "computer_click", missing: [] })).toBe(true);
    expect(decodes({ toolName: "computer_click", missing: [], buildSignature: "notarized" })).toBe(
      false,
    );
    expect(decodes({ toolName: "computer_click", missing: ["inputMonitoring"] })).toBe(false);
  });
});

function decodesWith(schema: Schema.Top, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("computer bounds", () => {
  const window = { id: "w", title: "Window", focused: false, minimized: false, visible: true };
  const occludedBy = (count: number) => Array.from({ length: count }, (_u, i) => `w-${i}`);

  it("caps a window's occluder list at the occluder constant, not the window list", () => {
    expect(
      decodesWith(ComputerWindow, {
        ...window,
        occludedBy: occludedBy(COMPUTER_OCCLUDERS_MAX_LENGTH),
      }),
    ).toBe(true);
    expect(
      decodesWith(ComputerWindow, {
        ...window,
        occludedBy: occludedBy(COMPUTER_OCCLUDERS_MAX_LENGTH + 1),
      }),
    ).toBe(false);
  });

  it("bounds a key name identically on every input surface", () => {
    const fits = "k".repeat(COMPUTER_KEY_NAME_MAX_LENGTH);
    const over = "k".repeat(COMPUTER_KEY_NAME_MAX_LENGTH + 1);
    expect(decodesWith(ComputerPressKeyInput, { key: fits })).toBe(true);
    expect(decodesWith(ComputerPressKeyInput, { key: over })).toBe(false);
    expect(decodesWith(ComputerHotkeyInput, { keys: ["ctrl", fits] })).toBe(true);
    expect(decodesWith(ComputerHotkeyInput, { keys: ["ctrl", over] })).toBe(false);
    expect(decodesWith(ComputerInputKeyInput, { key: fits })).toBe(true);
    expect(decodesWith(ComputerInputKeyInput, { key: over })).toBe(false);
  });

  const node = (children: readonly ComputerUiNode[] = []): ComputerUiNode => ({
    role: "group",
    label: null,
    value: null,
    description: null,
    frame: { x: 0, y: 0, width: 1, height: 1 },
    activationPoint: null,
    onScreen: true,
    windowId: null,
    children,
  });
  const state = (root: ComputerUiNode) => ({
    computerId: "desktop",
    windows: [],
    screenSize: { width: 1, height: 1 },
    root,
    capturedAt: "2026-09-16T00:00:00.000Z",
  });
  const chain = (depth: number) => {
    let current = node();
    for (let index = 1; index < depth; index += 1) current = node([current]);
    return current;
  };
  const leaves = (count: number) => Array.from({ length: count }, () => node());

  it("refuses a tree deeper than the depth budget", () => {
    expect(decodesWith(ComputerState, state(chain(COMPUTER_UI_TREE_MAX_DEPTH)))).toBe(true);
    expect(decodesWith(ComputerState, state(chain(COMPUTER_UI_TREE_MAX_DEPTH + 1)))).toBe(false);
  });

  it("refuses a tree with more nodes than the node budget", () => {
    // Thirty-two wide children under the root, sized to sit just under the
    // budget; one more child holding the remainder tips it over by one.
    const perChild = Math.floor((COMPUTER_UI_TREE_MAX_NODES - 1) / 32) - 1;
    const wide = Array.from({ length: 32 }, () => node(leaves(perChild)));
    expect(decodesWith(ComputerState, state(node(wide)))).toBe(true);
    const total = 1 + 32 * (1 + perChild);
    const extra = node(leaves(COMPUTER_UI_TREE_MAX_NODES - total));
    expect(decodesWith(ComputerState, state(node([...wide, extra])))).toBe(false);
  });
});

describe("ComputerHealth", () => {
  const health = {
    status: "connected",
    consecutiveFailures: 0,
    reconnects: 0,
    captureAvailable: true,
  };

  it("carries an optional session lock beside the connection state", () => {
    expect(decodesWith(ComputerHealth, health)).toBe(true);
    expect(decodesWith(ComputerHealth, { ...health, locked: true })).toBe(true);
    expect(decodesWith(ComputerHealth, { ...health, locked: "yes" })).toBe(false);
  });
});
