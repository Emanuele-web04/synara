import "../../../index.css";

import type { KeybindingRule, ResolvedKeybindingRule } from "@synara/contracts";
import { compileKeybindingRule } from "@synara/shared/keybindingRules";
import { designTextRuns } from "@synara/shared/designCanvasText";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

const native = vi.hoisted(() => ({
  canvas: {
    editLayers: vi.fn(),
    layout: vi.fn(),
    restoreFrames: vi.fn(),
    get: vi.fn(),
    getAsset: vi.fn(),
    setChatSelection: vi.fn(),
    fontCatalog: vi.fn(),
  },
  contextMenu: { show: vi.fn() },
  dialogs: { confirm: vi.fn() },
}));
vi.mock("../../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));

import { matchesFixedShortcut } from "../../../fixedShortcuts";
import { resolveShortcutCommand } from "../../../keybindings";
import { flushCanvasCameras } from "./canvasCamera";
import {
  element,
  frameOf,
  mountCanvas,
  mounted,
  nextFrame,
  resetCanvasStores,
  select,
  serveCanvas,
  text,
  workOf,
} from "./canvasEditorTestHarness";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? "Meta" : "Control";
const chord = (key: string) => `{${modKey}>}${key}{/${modKey}}`;

// The app's own default bindings for the chords the canvas also uses (apps/server keybindings),
// compiled by the same compiler the app resolves them with.
const RULES: KeybindingRule[] = [
  { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  { key: "mod+i", command: "sidebar.importThread", when: "!terminalFocus" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
];
const KEYBINDINGS: ResolvedKeybindingRule[] = RULES.map((rule) => compileKeybindingRule(rule)!);

/**
 * The app's global shortcut listener as `routes/_chat.tsx` installs it: on the window, in the
 * capture phase, so it sees every key before the canvas. A command it resolves is run and the
 * key is stopped there.
 */
const fired: string[] = [];
function appShortcuts(event: KeyboardEvent) {
  if (matchesFixedShortcut(event, "navigation.back", "MacIntel")) {
    event.preventDefault();
    event.stopPropagation();
    fired.push("navigation.back");
    return;
  }
  const command = resolveShortcutCommand(event, KEYBINDINGS, {
    context: { terminalFocus: false, terminalOpen: false },
  });
  if (!command) return;
  event.preventDefault();
  event.stopPropagation();
  fired.push(command);
}

const f1 = frameOf(
  "f1",
  [
    element(
      "plain",
      "position:absolute;left:20px;top:20px;margin:0;width:340px;font-size:20px;line-height:24px",
      ["plainText"],
      "p",
    ),
    text("plainText", "Hello world"),
    element("box", "position:absolute;left:20px;top:120px;width:60px;height:40px;background:#0f0"),
  ],
  ["plain", "box"],
);
const work = () => workOf([f1]);
const runsOf = (server: ReturnType<typeof serveCanvas>) =>
  designTextRuns(
    new Map(server.frame("f1").layers.nodes.map((node) => [node.id, node])),
    "plain",
  ).map(({ text: value, style }) => ({ text: value, style }));

function selectText(target: HTMLElement, start: number, end: number) {
  const node = target.firstChild as Text;
  document.getSelection()!.setBaseAndExtent(node, start, node, end);
}

describe("canvas keys against the app's global shortcuts", () => {
  beforeEach(async () => {
    await page.viewport(1200, 900);
    resetCanvasStores();
    fired.length = 0;
    for (const mock of Object.values(native.canvas)) mock.mockReset();
    native.canvas.fontCatalog.mockResolvedValue({ families: [], available: true });
    native.canvas.getAsset.mockRejectedValue(new Error("no assets in this test"));
    window.addEventListener("keydown", appShortcuts, { capture: true });
  });
  afterEach(() => {
    window.removeEventListener("keydown", appShortcuts, { capture: true });
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("⌘B in a text edit bolds the range; the sidebar toggle never runs", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "plain" }]);
      root.focus();
      await nextFrame();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(layer("plain")!.isContentEditable).toBe(true));
      const block = layer("plain")!;
      selectText(block, 6, 11);
      await userEvent.keyboard(chord("b"));
      expect(block.querySelector("span")?.textContent).toBe("world");
      expect(fired).toEqual([]);
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() =>
        expect(runsOf(server)).toEqual([
          { text: "Hello ", style: "" },
          { text: "world", style: "font-weight:700" },
        ]),
      );
      expect(fired).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });

  it("canvas shortcuts on a focused canvas win over the app's (⌘B, ⌘I, ⌘D)", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "plain" }]);
      root.focus();
      await nextFrame();
      await userEvent.keyboard(chord("b"));
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      await userEvent.keyboard(chord("i"));
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      await userEvent.keyboard(chord("d"));
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(3));
      expect(fired).toEqual([]);
      // ⌘[ (one step back) is the desktop app's Back elsewhere; the canvas keeps it here.
      if (isMac) {
        await userEvent.keyboard(chord("[["));
        expect(fired).toEqual([]);
      }
      expect(mounted.editor!.editingText).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("outside the canvas the app's shortcuts keep working", async () => {
    serveCanvas(native, work());
    const { screen } = await mountCanvas(work());
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "plain" }]);
      outside.focus();
      await userEvent.keyboard(chord("b"));
      await userEvent.keyboard(chord("d"));
      expect(fired).toEqual(["sidebar.toggle", "diff.toggle"]);
      expect(native.canvas.editLayers).not.toHaveBeenCalled();
    } finally {
      outside.remove();
      await screen.unmount();
    }
  });
});
