import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ComputerUiNode as ComputerUiNodeSchema } from "@synara/contracts";
import type { ComputerUiNode } from "@synara/contracts";

import {
  atspiFrameInWindow,
  atspiNodeAddress,
  atspiTextWriteAddress,
  clampNodeText,
  decorationOffsetForClientSize,
  fuseAtspiWindowTree,
  fuseAtspiTrees,
  type AtspiRawNode,
} from "./atspiTreeTargeting.ts";
import { resolveComputerSemanticTarget } from "./uiTreeTargeting.ts";

describe("AT-SPI coordinate fusion", () => {
  it("pins the Phase 0 Plasma frame/client offset", () => {
    expect(
      decorationOffsetForClientSize({ width: 648, height: 518 }, { width: 640, height: 480 }),
    ).toEqual({ x: 4, y: 34 });
  });

  it("turns client-relative widget extents into global targeting points", () => {
    const window = {
      id: "phase0-window" as const,
      bounds: { x: 956, y: 1519, width: 648, height: 518 },
    };
    const fused = fuseAtspiWindowTree({
      window,
      tree: {
        windowId: "phase0-window",
        clientSize: { width: 640, height: 480 },
        root: {
          role: "window",
          label: "Phase 0",
          value: null,
          description: null,
          frame: { x: 0, y: 0, width: 640, height: 480 },
          children: [
            {
              role: "button",
              label: "Target",
              value: null,
              description: null,
              frame: { x: 10, y: 20, width: 100, height: 30 },
              activationPoint: { x: 60, y: 35 },
              children: [],
            },
          ],
        },
      },
    });

    expect(fused.children[0]?.frame).toEqual({
      x: 970,
      y: 1573,
      width: 100,
      height: 30,
    });
    expect(fused.children[0]?.activationPoint).toEqual({ x: 1_020, y: 1_588 });
    expect(fused.children[0]?.windowId).toBe("phase0-window");

    const resolved = resolveComputerSemanticTarget(fused, {
      label: "Target",
      role: "button",
      windowId: "phase0-window",
    });
    expect(resolved.point).toEqual({ x: 1_020, y: 1_588 });
  });

  it("rebuilds child-index paths and carries the editable flag onto fused nodes", () => {
    const fused = fuseAtspiWindowTree({
      window: { id: "editor" as const, bounds: { x: 0, y: 0, width: 640, height: 480 } },
      tree: {
        windowId: "editor",
        clientSize: { width: 640, height: 480 },
        root: rawNode("window", "Editor", { x: 0, y: 0, width: 640, height: 480 }, [
          {
            // The real AT-SPI index, which is not the emitted child position.
            ...rawNode("panel", null, { x: 0, y: 0, width: 640, height: 480 }, [
              {
                ...rawNode("entry", "Name", { x: 10, y: 10, width: 200, height: 24 }),
                i: 1,
                editable: true,
              },
            ]),
            i: 3,
          },
        ]),
      },
    });

    expect(fused.nodePath).toEqual([]);
    expect(fused.editable).toBeUndefined();
    expect(atspiTextWriteAddress(fused.children[0]!.children[0]!)).toEqual({
      windowId: "editor",
      path: [3, 1],
    });
  });

  it("leaves a node without its child index, and everything under it, unaddressed", () => {
    const fused = fuseAtspiWindowTree({
      window: { id: "editor" as const, bounds: { x: 0, y: 0, width: 640, height: 480 } },
      tree: {
        windowId: "editor",
        clientSize: { width: 640, height: 480 },
        root: rawNode("window", "Editor", { x: 0, y: 0, width: 640, height: 480 }, [
          rawNode("panel", null, { x: 0, y: 0, width: 10, height: 10 }, [
            { ...rawNode("entry", "Name", { x: 0, y: 0, width: 10, height: 10 }), i: 0 },
          ]),
        ]),
      },
    });

    expect(atspiNodeAddress(fused.children[0]!)).toBeUndefined();
    expect(atspiNodeAddress(fused.children[0]!.children[0]!)).toBeUndefined();
  });

  /**
   * N6: the helper reports extents relative to the window (AT-SPI WINDOW
   * coordinates), and the window's bounds are already in agent space. With a
   * monitor left of and above the primary, the workspace origin is negative;
   * the tree must land exactly where the window is, not a screen width off.
   */
  it("places a window's controls correctly when the workspace origin is negative", () => {
    // The window sits at global (-1500, -300) on a workspace whose origin is
    // (-1920, -1080); in agent space that is (420, 780).
    const window = {
      id: "left-monitor" as const,
      title: "Editor",
      bounds: { x: 420, y: 780, width: 648, height: 518 },
      focused: true,
      minimized: false,
      visible: true,
    };
    const root = fuseAtspiTrees({
      windows: [window],
      trees: [
        {
          windowId: "left-monitor",
          clientSize: { width: 640, height: 480 },
          root: rawNode("frame", "Editor", { x: 0, y: 0, width: 640, height: 480 }, [
            { ...rawNode("button", "Save", { x: 10, y: 20, width: 100, height: 30 }), i: 0 },
          ]),
        },
      ],
      screenSize: { width: 3_840, height: 2_160 },
    });

    const save = root.children[0]!.children[0]!;
    expect(save.frame).toEqual({ x: 434, y: 834, width: 100, height: 30 });
    expect(save.onScreen).toBe(true);
    expect(resolveComputerSemanticTarget(root, { label: "Save" }).point).toEqual({
      x: 484,
      y: 849,
    });
    // A node re-read at dispatch is placed by the same rule.
    expect(
      atspiFrameInWindow(
        window,
        { width: 640, height: 480 },
        { x: 10, y: 20, width: 100, height: 30 },
      ),
    ).toEqual(save.frame);
  });

  it("carries truncation onto the fused nodes and the desktop root", () => {
    const window = {
      id: "browser" as const,
      title: "Browser",
      bounds: { x: 0, y: 0, width: 640, height: 480 },
      focused: true,
      minimized: false,
      visible: true,
    };
    const tree = {
      windowId: "browser",
      clientSize: { width: 640, height: 480 },
      root: {
        ...rawNode("frame", "Browser", { x: 0, y: 0, width: 640, height: 480 }),
        truncated: true,
      },
      status: "partial" as const,
      truncated: true,
    };
    const screenSize = { width: 1_920, height: 1_080 };

    const root = fuseAtspiTrees({ windows: [window], trees: [tree], screenSize });

    expect(root.truncated).toBe(true);
    expect(root.children[0]?.truncated).toBe(true);
    const complete = fuseAtspiTrees({
      windows: [window],
      trees: [
        {
          ...tree,
          status: "complete",
          truncated: false,
          root: rawNode("frame", "B", tree.root.frame),
        },
      ],
      screenSize,
    });
    expect(complete.truncated).toBeUndefined();
    expect(
      fuseAtspiTrees({ windows: [window], trees: [], screenSize, incomplete: true }).truncated,
    ).toBe(true);
  });

  it("keeps an unavailable window's frame, with the reason and no children", () => {
    const fused = fuseAtspiWindowTree({
      window: { id: "chromium" as const, bounds: { x: 0, y: 0, width: 800, height: 600 } },
      tree: {
        windowId: "chromium",
        clientSize: { width: 800, height: 600 },
        root: rawNode("frame", "Claude", { x: 0, y: 0, width: 800, height: 600 }),
        status: "unavailable",
        reason: "renderer accessibility is off",
      },
    });

    expect(fused.truncated).toBe(true);
    expect(fused.children).toEqual([]);
    expect(fused.description).toBe("renderer accessibility is off");
  });

  it("refuses a write address for anything it cannot re-resolve", () => {
    const base: ComputerUiNode = {
      role: "entry",
      label: "Name",
      value: null,
      description: null,
      frame: { x: 0, y: 0, width: 10, height: 10 },
      activationPoint: null,
      onScreen: true,
      windowId: "editor",
      nodePath: [0],
      editable: true,
      children: [],
    };

    expect(atspiTextWriteAddress(base)).toEqual({ windowId: "editor", path: [0] });
    expect(atspiTextWriteAddress({ ...base, editable: false })).toBeUndefined();
    expect(atspiTextWriteAddress({ ...base, editable: undefined })).toBeUndefined();
    expect(atspiTextWriteAddress({ ...base, nodePath: undefined })).toBeUndefined();
    expect(atspiTextWriteAddress({ ...base, windowId: null })).toBeUndefined();
    expect(atspiTextWriteAddress({ ...base, nodePath: [0, -1] })).toBeUndefined();
    expect(atspiTextWriteAddress({ ...base, nodePath: [1.5] })).toBeUndefined();
  });

  /**
   * An accessible name is whatever the application put there, and the contract
   * bounds it. Before this, one application labelling a widget with its own
   * paragraph of text took every computer.getState on the desktop down with a
   * schema encode failure.
   */
  it("keeps an oversized accessible name inside the contract's bounds", () => {
    const fused = fuseAtspiWindowTree({
      window: { id: "verbose" as const, bounds: { x: 0, y: 0, width: 640, height: 480 } },
      tree: {
        windowId: "verbose",
        clientSize: { width: 640, height: 480 },
        root: {
          role: "window",
          label: "w".repeat(4_000),
          value: null,
          description: "d".repeat(40_000),
          frame: { x: 0, y: 0, width: 640, height: 480 },
          children: [
            {
              role: "r".repeat(500),
              label: null,
              value: "v".repeat(40_000),
              description: null,
              frame: { x: 0, y: 0, width: 10, height: 10 },
              children: [],
            },
          ],
        },
      },
    });

    expect(fused.label).toHaveLength(1_024);
    expect(fused.label?.endsWith("…")).toBe(true);
    expect(fused.description).toHaveLength(16 * 1_024);
    expect(fused.children[0]?.role).toHaveLength(128);
    expect(fused.children[0]?.value).toHaveLength(16 * 1_024);
    // The bounds this module mirrors are the contract's own, so the fused node
    // has to satisfy the schema computer.getState is encoded against — and one
    // character more than the mirror allows must not.
    // The contract annotates this as `Schema.Schema<ComputerUiNode>`, which
    // leaves the decoding-service slot `unknown`, and the validator only takes
    // schemas that declare they need none. The runtime value is the same schema
    // the RPC encodes against; the cast restores what the annotation erased.
    const isContractNode = Schema.is(ComputerUiNodeSchema as Schema.Codec<ComputerUiNode>);
    expect(isContractNode(fused)).toBe(true);
    expect(isContractNode({ ...fused, label: "w".repeat(1_025) })).toBe(false);
  });

  it("never cuts an oversized label between the halves of a surrogate pair", () => {
    const text = `${"a".repeat(9)}${"🙂".repeat(4)}`;
    // The cut lands on the low half, so the whole character fits.
    expect(clampNodeText(text, 12)).toBe("aaaaaaaaa🙂…");
    // The cut lands on the high half: the character goes rather than half of it.
    const split = clampNodeText(text, 11);
    expect(split).toBe("aaaaaaaaa…");
    expect(split.includes("�")).toBe(false);
  });

  it("passes a label the helper clamped through unchanged, astral characters included", () => {
    // The helper clamps in UTF-16 units, as this side counts: a label at its
    // bound must arrive whole, or the label sent back to validateNode (the
    // tree's) no longer matches the helper's clamp of the live name.
    const label = "🙂".repeat(512);
    const fused = fuseAtspiWindowTree({
      window: { id: "emoji" as const, bounds: { x: 0, y: 0, width: 640, height: 480 } },
      tree: {
        windowId: "emoji",
        clientSize: { width: 640, height: 480 },
        root: {
          role: "window",
          label,
          value: null,
          description: null,
          frame: { x: 0, y: 0, width: 640, height: 480 },
          children: [],
        },
      },
    });
    expect(fused.label).toBe(label);
  });

  it("drops minimized windows from the fused desktop tree", () => {
    const root = fuseAtspiTrees({
      windows: [
        {
          id: "hidden",
          title: "Hidden",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          focused: false,
          minimized: true,
          visible: true,
        },
      ],
      trees: [
        {
          windowId: "hidden",
          clientSize: { width: 100, height: 100 },
          root: {
            role: "window",
            label: "Hidden",
            value: null,
            description: null,
            frame: { x: 0, y: 0, width: 100, height: 100 },
            children: [],
          },
        },
      ],
      screenSize: { width: 1_920, height: 1_080 },
    });
    expect(root.children).toHaveLength(0);
  });
});

function rawNode(
  role: string,
  label: string | null,
  frame: AtspiRawNode["frame"],
  children: readonly AtspiRawNode[] = [],
): AtspiRawNode {
  return { role, label, value: null, description: null, frame, children };
}
