import { describe, expect, it } from "vitest";

import type { ComputerUiNode, ComputerWindowId } from "@synara/contracts";

import {
  ComputerTargetError,
  activationPointForNode,
  actionableElements,
  computerTargetCandidates,
  diffActionableElements,
  resolveComputerPoint,
  resolveComputerSemanticTarget,
  resolveComputerUniqueTextTarget,
  type ComputerActionableElement,
} from "./uiTreeTargeting.ts";

const windowId = (value: string): ComputerWindowId => value as ComputerWindowId;

function node(partial: Partial<ComputerUiNode> & { readonly role: string }): ComputerUiNode {
  return {
    role: partial.role,
    label: partial.label ?? null,
    value: partial.value ?? null,
    description: partial.description ?? null,
    frame: partial.frame ?? { x: 0, y: 0, width: 1_920, height: 1_080 },
    activationPoint: partial.activationPoint ?? null,
    onScreen: partial.onScreen ?? true,
    windowId: partial.windowId ?? null,
    ...(partial.editable === undefined ? {} : { editable: partial.editable }),
    ...(partial.truncated === undefined ? {} : { truncated: partial.truncated }),
    children: partial.children ?? [],
  };
}

const DESKTOP = node({
  role: "desktop",
  description: "AT-SPI desktop",
  children: [
    node({
      role: "push button",
      label: "Save",
      windowId: windowId("editor"),
      frame: { x: 100, y: 200, width: 80, height: 30 },
      activationPoint: { x: 140, y: 215 },
    }),
    node({
      role: "push button",
      label: "Save As",
      windowId: windowId("editor"),
      frame: { x: 200, y: 200, width: 80, height: 30 },
    }),
    node({
      role: "menu item",
      label: "Save",
      windowId: windowId("browser"),
      frame: { x: 900, y: 200, width: 80, height: 30 },
    }),
  ],
});

function thrown(run: () => unknown): ComputerTargetError {
  try {
    run();
  } catch (cause) {
    return cause as ComputerTargetError;
  }
  throw new Error("expected a ComputerTargetError");
}

describe("resolving a coordinate target", () => {
  const screen = { width: 1_920, height: 1_080, scale: 1 };

  it("takes a point that is on the screen", () => {
    expect(resolveComputerPoint({ x: 10, y: 20 }, screen)).toEqual({
      x: 10,
      y: 20,
    });
  });

  it("refuses half a coordinate and a coordinate past the edge", () => {
    const half = thrown(() => resolveComputerPoint({ x: 10 }, screen));
    expect(half.code).toBe("computer_target_invalid");
    const past = thrown(() => resolveComputerPoint({ x: 1_920, y: 10 }, screen));
    expect(past.code).toBe("computer_target_offscreen");
  });
});

describe("resolving a labelled desktop target", () => {
  it("returns the control's own activation point when it has one", () => {
    const match = resolveComputerSemanticTarget(DESKTOP, {
      label: "Save",
      role: "push button",
    });
    expect(match.point).toEqual({ x: 140, y: 215 });
    expect(match.node.windowId).toBe("editor");
  });

  it("falls back to the frame centre for a control with no activation point", () => {
    const plain = node({
      role: "x",
      frame: { x: 10, y: 20, width: 100, height: 40 },
    });
    expect(activationPointForNode(plain)).toEqual({ x: 60, y: 40 });
  });

  it("prefers an exact label over a longer one that contains it", () => {
    const target = { label: "Save", windowId: windowId("editor") };
    expect(resolveComputerSemanticTarget(DESKTOP, target).node.frame.x).toBe(100);
  });

  it("scopes matching to the named window", () => {
    const target = { label: "Save", windowId: windowId("browser") };
    expect(resolveComputerSemanticTarget(DESKTOP, target).node.role).toBe("menu item");
  });

  it("falls back to substring when no label matches exactly", () => {
    expect(resolveComputerSemanticTarget(DESKTOP, { label: "ave As" }).node.label).toBe("Save As");
  });

  it("compares a role verbatim rather than loosely", () => {
    // AT-SPI role names are a fixed vocabulary, so a near miss is a wrong role
    // and not a spelling to be forgiven.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { role: "Push Button" }));
    expect(error.code).toBe("computer_target_not_found");
  });

  it("matches a label without trimming the query", () => {
    // Nothing trims a label arriving over MCP, and quietly acting on a control
    // the caller did not name is worse than a refusal they can correct.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: " Save " }));
    expect(error.code).toBe("computer_target_not_found");
  });

  it.each(["\u00a0", "\u2007", "\u202f"])(
    "matches a visible form label containing a non-breaking space (%j)",
    (space) => {
      const field = node({ role: "AXTextField", label: `First name${space}*` });
      const desktop = node({
        role: "desktop",
        children: [field, node({ role: "AXTextField", label: "First name * (optional)" })],
      });
      expect(resolveComputerSemanticTarget(desktop, { label: "First name *" }).node).toBe(field);
    },
  );

  it("matches a label whatever Unicode composition the toolkit stored it in", () => {
    // "é" as one code point in the query, as "e" + combining acute in the tree.
    const field = node({ role: "entry", label: "Pr\u0065\u0301nom" });
    const desktop = node({
      role: "desktop",
      children: [field, node({ role: "entry", label: "Nom" })],
    });
    expect(resolveComputerSemanticTarget(desktop, { label: "Pr\u00e9nom" }).node).toBe(field);
    expect(resolveComputerSemanticTarget(desktop, { label: "pr\u00e9n" }).node).toBe(field);
  });

  it("folds case the same way in every locale", () => {
    // Under a Turkish locale a locale-aware lowercase turns "I" into a dotless
    // "ı", so "Insert" would stop matching "insert" depending on the server.
    const field = node({ role: "entry", label: "Insert Image" });
    const desktop = node({ role: "desktop", children: [field] });
    expect("INSERT IMAGE".toLowerCase()).toBe("insert image");
    expect(resolveComputerSemanticTarget(desktop, { label: "insert im" }).node).toBe(field);
  });

  it("refuses ambiguity between labels differing only in non-breaking spaces", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({ role: "AXTextField", label: "First name\u00a0*" }),
        node({ role: "AXTextField", label: "First name *" }),
      ],
    });
    const error = thrown(() => resolveComputerSemanticTarget(desktop, { label: "First name *" }));
    expect(error.code).toBe("computer_target_ambiguous");
    expect(error.candidates).toHaveLength(2);
  });

  it("refuses a label that names a control in two windows", () => {
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: "Save" }));
    expect(error.code).toBe("computer_target_ambiguous");
    expect(error.candidates).toHaveLength(2);
  });

  it("trusts the perception source's own on-screen flag", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "push button",
          label: "Hidden",
          onScreen: false,
          // On screen by coordinates; the source knows better, and is believed.
          frame: { x: 10, y: 10, width: 80, height: 30 },
        }),
      ],
    });
    const error = thrown(() => resolveComputerSemanticTarget(desktop, { label: "Hidden" }));
    expect(error.code).toBe("computer_target_offscreen");
    expect(error.candidates).toHaveLength(1);
    expect(resolveComputerSemanticTarget(desktop, { label: "Hidden" }, true).node.label).toBe(
      "Hidden",
    );
  });
});

describe("resolving the sole writable text control in a window", () => {
  it("selects an unlabelled native text area without guessing across windows", () => {
    const editor = node({
      role: "AXTextArea",
      windowId: windowId("editor"),
      frame: { x: 20, y: 40, width: 300, height: 200 },
    });
    const desktop = node({
      role: "desktop",
      children: [
        editor,
        node({ role: "AXTextArea", windowId: windowId("other") }),
        node({ role: "AXButton", label: "Save", windowId: windowId("editor") }),
      ],
    });

    expect(resolveComputerUniqueTextTarget(desktop, "editor").node).toBe(editor);
  });

  it("refuses multiple writable controls and names each candidate", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "AXTextField",
          label: "Title",
          windowId: windowId("editor"),
        }),
        node({
          role: "AXTextArea",
          label: "Body",
          windowId: windowId("editor"),
        }),
      ],
    });

    const error = thrown(() => resolveComputerUniqueTextTarget(desktop, "editor"));
    expect(error.code).toBe("computer_target_ambiguous");
    expect(error.candidates.map((candidate) => candidate.label)).toEqual(["Title", "Body"]);
  });

  it("does not select a text-shaped control explicitly marked read-only", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "AXTextArea",
          label: "Transcript",
          editable: false,
          windowId: windowId("editor"),
        }),
      ],
    });

    const error = thrown(() => resolveComputerUniqueTextTarget(desktop, "editor"));
    expect(error.code).toBe("computer_target_not_found");
  });

  it("can retain an exact writable control after its window leaves the active Space", () => {
    const editor = node({
      role: "AXTextArea",
      label: "Body",
      windowId: windowId("editor"),
      onScreen: false,
    });
    const desktop = node({ role: "desktop", children: [editor] });

    expect(resolveComputerUniqueTextTarget(desktop, "editor", true).node).toBe(editor);
    expect(() => resolveComputerUniqueTextTarget(desktop, "editor")).toThrow(ComputerTargetError);
  });
});

describe("naming the candidates", () => {
  it("puts the candidates in the message, not only in the structured field", () => {
    // Every transport between here and the model — MCP tool errors, WsRpcError —
    // is only guaranteed to carry the message, and a "no such label" with no
    // list of the real ones is a dead end.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: "Print" }));
    expect(error.code).toBe("computer_target_not_found");
    expect(error.candidates.length).toBeGreaterThan(0);
    expect(error.message).toContain("Save As");
    expect(error.message).toContain("push button");
    expect(error.message).toContain('in window "editor"');
  });

  it("leaves a message alone when there are no candidates to name", () => {
    const screen = { width: 100, height: 100 };
    const error = thrown(() => resolveComputerPoint({ x: 5_000, y: 10 }, screen));
    expect(error.message).toBe("Computer target (5000, 10) is outside the 100x100 screen.");
  });

  it("caps a candidate list at sixteen entries", () => {
    const desktop = node({
      role: "desktop",
      children: Array.from({ length: 40 }, (_unused, index) =>
        node({ role: "push button", label: `Button ${index}` }),
      ),
    });
    // The root counts too: the cap is on the flattened list, not on the children.
    expect(computerTargetCandidates(desktop)).toHaveLength(16);
    const error = thrown(() => resolveComputerSemanticTarget(desktop, { label: "Nope" }));
    expect(error.candidates).toHaveLength(16);
  });
});

/**
 * The digest is what makes labels discoverable to the model: without it the
 * only grounding is pixel estimation from a downscaled screenshot, which is
 * exactly the clunkiness this exists to remove.
 */
describe("actionableElements", () => {
  it("finds non-breaking-space labels through the same query used for targeting", () => {
    const field = node({
      role: "AXTextField",
      label: "First name\u00a0*",
      windowId: windowId("browser"),
    });
    const result = actionableElements(node({ role: "desktop", children: [field] }), {
      windowId: "browser",
      labelContains: "FIRST NAME *",
    });
    expect(result.items.map((item) => item.label)).toEqual(["First name\u00a0*"]);
    expect(result.complete).toBe(true);
  });

  it("lists labeled on-screen actionable elements in tree order", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "push button",
          label: "Reload",
          windowId: windowId("browser"),
          children: [
            node({
              role: "entry",
              label: "Email",
              value: "",
              windowId: windowId("browser"),
            }),
          ],
        }),
        node({
          role: "heading",
          label: "Settings",
          windowId: windowId("browser"),
        }),
      ],
    });

    expect(actionableElements(desktop)).toEqual({
      complete: true,
      sourceIncomplete: false,
      omitted: 0,
      items: [
        { ref: 0, role: "push button", label: "Reload", windowId: windowId("browser") },
        {
          ref: 1,
          role: "entry",
          label: "Email",
          value: "",
          windowId: windowId("browser"),
        },
      ],
      refIndex: [
        { label: "Reload", role: "push button", windowId: "browser", ordinal: 0 },
        { label: "Email", role: "entry", windowId: "browser", ordinal: 0 },
      ],
    });
  });

  it("drops unlabeled controls, static text, and off-screen elements", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({ role: "push button", windowId: windowId("w") }),
        node({
          role: "text",
          label: "A paragraph of static text",
          windowId: windowId("w"),
        }),
        node({
          role: "check box",
          label: "Off screen",
          onScreen: false,
          windowId: windowId("w"),
        }),
        node({
          role: "check box",
          label: "Subscribed",
          windowId: windowId("w"),
        }),
      ],
    });

    expect(actionableElements(desktop).items).toEqual([
      { ref: 0, role: "check box", label: "Subscribed", windowId: windowId("w") },
    ]);
  });

  it("falls back to the description when there is no label, matching targeting", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "slider",
          description: "Volume",
          windowId: windowId("player"),
        }),
      ],
    });

    // Targeting matches on `label ?? description`, so the digest must name the
    // element by the same words or the model could not act on it by label.
    expect(actionableElements(desktop).items).toEqual([
      { ref: 0, role: "slider", label: "Volume", windowId: windowId("player") },
    ]);
  });

  it("keeps duplicate labels — real ambiguity — but separates windows", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "push button",
          label: "Save",
          windowId: windowId("editor"),
        }),
        node({
          role: "push button",
          label: "Save",
          windowId: windowId("editor"),
        }),
        node({
          role: "menu item",
          label: "Save",
          windowId: windowId("browser"),
        }),
      ],
    });

    const elements = actionableElements(desktop);
    expect(elements.complete).toBe(true);
    expect(elements.items).toHaveLength(3);
    expect(elements.items[0]?.windowId).toBe(windowId("editor"));
    expect(elements.items.at(-1)?.windowId).toBe(windowId("browser"));
  });

  it("truncates long labels and values on whole characters", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "entry",
          label: `x`.repeat(300),
          value: "v".repeat(200),
          windowId: windowId("editor"),
        }),
      ],
    });

    const [element] = actionableElements(desktop).items;
    expect(element?.label.length).toBeLessThanOrEqual(80);
    expect(element?.value?.length).toBeLessThanOrEqual(40);
  });

  it("caps the list and reports when it had to cut elements off", () => {
    const desktop = node({
      role: "desktop",
      children: Array.from({ length: 80 }, (_unused, index) =>
        node({
          role: "push button",
          label: `Button ${index}`,
          windowId: windowId("panel"),
          children: [
            node({
              role: "link",
              label: "child link",
              windowId: windowId("panel"),
            }),
          ],
        }),
      ),
    });

    const elements = actionableElements(desktop);
    expect(elements.items).toHaveLength(60);
    expect(elements.complete).toBe(false);
  });
});

it("includes native macOS controls and reports a partial accessibility source", () => {
  const tree = node({
    role: "desktop",
    truncated: true,
    children: [
      node({ role: "AXButton", label: "Save", windowId: windowId("native") }),
      node({
        role: "AXMenuBarItem",
        label: "File",
        windowId: windowId("native"),
      }),
    ],
  });
  const result = actionableElements(tree);
  expect(result.items.map((item) => item.label)).toEqual(["Save", "File"]);
  expect(result.complete).toBe(false);
  expect(result.sourceIncomplete).toBe(true);
});

describe("diffActionableElements", () => {
  const element = (
    label: string,
    extra: Partial<ComputerActionableElement> = {},
  ): ComputerActionableElement => ({
    ref: 0,
    role: "push button",
    label,
    windowId: windowId("editor"),
    ...extra,
  });

  it("reports every element as added against an empty baseline", () => {
    const after = [element("Save"), element("Cancel")];
    expect(diffActionableElements([], after)).toEqual({
      added: after,
      removed: [],
      changed: [],
    });
  });

  it("reports an identical digest as no change", () => {
    const items = [element("Save"), element("Cancel", { value: "armed" })];
    expect(diffActionableElements(items, [...items])).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("separates added, removed, and value-changed entries", () => {
    const before = [element("Save"), element("Display", { value: "0" }), element("Help")];
    const after = [element("Save"), element("Display", { value: "42" }), element("About")];
    expect(diffActionableElements(before, after)).toEqual({
      added: [element("About")],
      removed: [element("Help")],
      changed: [
        {
          ref: 0,
          role: "push button",
          label: "Display",
          windowId: windowId("editor"),
          was: "0",
          value: "42",
        },
      ],
    });
  });

  it("treats a reordering of the same elements as no change", () => {
    const before = [element("Save"), element("Cancel")];
    const after = [element("Cancel"), element("Save")];
    expect(diffActionableElements(before, after)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("keeps duplicate labels distinct by count", () => {
    const before = [element("Save"), element("Save")];
    const after = [element("Save")];
    expect(diffActionableElements(before, after)).toEqual({
      added: [],
      removed: [element("Save")],
      changed: [],
    });
  });

  it("separates identical labels across windows", () => {
    const before = [
      element("Save", { windowId: windowId("editor") }),
      element("Save", { windowId: windowId("browser") }),
    ];
    const after = [element("Save", { windowId: windowId("editor") })];
    expect(diffActionableElements(before, after)).toEqual({
      added: [],
      removed: [element("Save", { windowId: windowId("browser") })],
      changed: [],
    });
  });

  it("reports a gained or lost value as a change, not a remove-add pair", () => {
    const before = [element("Notes")];
    const after = [element("Notes", { value: "draft text" })];
    expect(diffActionableElements(before, after).changed).toEqual([
      {
        ref: 0,
        role: "push button",
        label: "Notes",
        windowId: windowId("editor"),
        value: "draft text",
      },
    ]);
    expect(diffActionableElements(after, before).changed).toEqual([
      {
        ref: 0,
        role: "push button",
        label: "Notes",
        windowId: windowId("editor"),
        was: "draft text",
      },
    ]);
  });
});

describe("resolving a duplicate by ordinal", () => {
  const twoSaves = node({
    role: "desktop",
    children: [
      node({
        role: "window",
        label: "Editor",
        windowId: windowId("editor"),
        children: [
          node({
            role: "push button",
            label: "Save",
            windowId: windowId("editor"),
            activationPoint: { x: 10, y: 10 },
          }),
          node({
            role: "push button",
            label: "Save",
            windowId: windowId("editor"),
            activationPoint: { x: 20, y: 20 },
          }),
        ],
      }),
    ],
  });

  it("picks the ordinal-th control sharing the exact identity", () => {
    const match = resolveComputerSemanticTarget(twoSaves, {
      label: "Save",
      refOrdinal: 1,
    });
    expect(match.point).toEqual({ x: 20, y: 20 });
  });

  it.each([false, true])(
    "refuses a disappeared ordinal instead of targeting the sole survivor (allowOffscreen=%s)",
    (allowOffscreen) => {
      const oneSave = node({
        role: "desktop",
        children: [
          node({
            role: "push button",
            label: "Save",
            windowId: windowId("editor"),
            activationPoint: { x: 10, y: 10 },
          }),
        ],
      });
      const error = thrown(() =>
        resolveComputerSemanticTarget(oneSave, { label: "Save", refOrdinal: 1 }, allowOffscreen),
      );
      expect(error.code).toBe("computer_target_not_found");
      expect(error.notFound).toBe(true);
      expect(error.message).toContain("Observe again with computer_get_state");
    },
  );

  it("refuses a disappeared ordinal even when multiple controls survive", () => {
    const error = thrown(() =>
      resolveComputerSemanticTarget(twoSaves, { label: "Save", refOrdinal: 2 }),
    );
    expect(error.code).toBe("computer_target_not_found");
    expect(error.candidates).toHaveLength(2);
  });

  it("reports the pool's near-misses when nothing matches", () => {
    const thrown = (() => {
      try {
        resolveComputerSemanticTarget(twoSaves, {
          label: "Missing",
          refOrdinal: 0,
        });
      } catch (cause) {
        return cause as ComputerTargetError;
      }
      throw new Error("expected a refusal");
    })();
    expect(thrown.code).toBe("computer_target_not_found");
  });
});

describe("actionableElements ref data", () => {
  it("indexes each item with its full identity and duplicate ordinal", () => {
    const tree = node({
      role: "desktop",
      children: [
        node({
          role: "window",
          windowId: windowId("editor"),
          children: [
            node({
              role: "push button",
              label: "Save",
              windowId: windowId("editor"),
            }),
            node({
              role: "push button",
              label: "Save",
              windowId: windowId("editor"),
            }),
          ],
        }),
      ],
    });
    const digest = actionableElements(tree);
    expect(digest.items.map((item) => item.ref)).toEqual([0, 1]);
    expect(digest.refIndex).toEqual([
      { label: "Save", role: "push button", windowId: "editor", ordinal: 0 },
      { label: "Save", role: "push button", windowId: "editor", ordinal: 1 },
    ]);
  });

  it("keeps the full label in the ref index when the wire label clamps", () => {
    const longLabel = "x".repeat(200);
    const tree = node({
      role: "desktop",
      children: [
        node({
          role: "window",
          windowId: windowId("editor"),
          children: [
            node({
              role: "push button",
              label: longLabel,
              windowId: windowId("editor"),
            }),
          ],
        }),
      ],
    });
    const digest = actionableElements(tree);
    expect(digest.items[0]!.label.length).toBeLessThan(longLabel.length);
    expect(digest.refIndex[0]!.label).toBe(longLabel);
  });
});
