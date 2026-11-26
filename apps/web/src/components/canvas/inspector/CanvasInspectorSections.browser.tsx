import "../../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

const native = vi.hoisted(() => ({
  canvas: {
    editLayers: vi.fn(),
    layout: vi.fn(),
    restoreFrames: vi.fn(),
    get: vi.fn(),
    getAsset: vi.fn(),
    setChatSelection: vi.fn(),
    fontCatalog: vi.fn(),
    addFont: vi.fn(),
    importImage: vi.fn(),
  },
  contextMenu: { show: vi.fn() },
  dialogs: { confirm: vi.fn() },
}));
vi.mock("../../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));

import {
  element,
  frameOf,
  mountCanvas,
  mounted,
  resetCanvasStores,
  select,
  serveCanvas,
  text,
  workOf,
} from "../editor/canvasEditorTestHarness";

const f1 = frameOf(
  "f1",
  [
    element(
      "card",
      "position:absolute;left:20px;top:20px;width:200px;height:100px;background:#ffffff",
      ["label"],
    ),
    element("label", "font-size:16px;color:#111111;margin:0;height:40px", ["labelText"], "p"),
    text("labelText", "Hello"),
    element(
      "badge",
      "position:absolute;left:250px;top:30px;width:40px;height:40px;background-color:#ff0000;rotate:10deg",
    ),
    element("row", "position:absolute;left:20px;top:150px;width:300px;display:flex;gap:8px", [
      "a",
      "b",
    ]),
    element("a", "width:40px;height:20px;background:#00ff00"),
    element("b", "width:40px;height:20px;background:#0000ff"),
  ],
  ["card", "badge", "row"],
);
const work = () => workOf([f1]);
const layer = (id: string) => ({ kind: "layer" as const, frameId: "f1", layerId: id });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The style the in-memory store saved for a layer, as declarations. */
function savedStyle(server: ReturnType<typeof serveCanvas>, id: string) {
  const node = server.frame("f1").layers.nodes.find((item) => item.id === id);
  const style = node?.type === "element" ? (node.attributes.style ?? "") : "";
  return Object.fromEntries(
    style
      .split(";")
      .filter(Boolean)
      .map((item) => [
        item.slice(0, item.indexOf(":")).trim(),
        item.slice(item.indexOf(":") + 1).trim(),
      ]),
  );
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );
}

async function typeInto(name: string, value: string) {
  const field = page.getByRole("textbox", { name, exact: true });
  await field.fill(value);
  press(field.element(), "Enter");
}

async function pick(combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** A primary-button pointer event, as dnd-kit's sensor requires. */
function drag(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  x: number,
  y: number,
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
  );
}

async function mount() {
  const server = serveCanvas(native, work());
  const mountedCanvas = await mountCanvas(work(), { inspector: true });
  return { server, ...mountedCanvas };
}

describe("inspector sections", () => {
  beforeEach(async () => {
    await page.viewport(1200, 900);
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
    native.canvas.fontCatalog.mockResolvedValue({ families: [], available: true });
    native.canvas.getAsset.mockRejectedValue(new Error("no assets in this test"));
  });
  afterEach(() => select([]));

  it("rotates a layer from the field and the 90° button, each one undo step", async () => {
    const { server, screen, layer: rendered } = await mount();
    try {
      select([layer("badge")]);
      const rotation = page.getByRole("textbox", { name: "Rotation", exact: true });
      await expect.element(rotation).toHaveValue("10");
      await typeInto("Rotation", "45");
      await vi.waitFor(() => expect(savedStyle(server, "badge").rotate).toBe("45deg"));
      await vi.waitFor(() => expect(getComputedStyle(rendered("badge")!).rotate).toBe("45deg"));
      await page.getByRole("button", { name: "Rotate 90°" }).click();
      await vi.waitFor(() => expect(savedStyle(server, "badge").rotate).toBe("135deg"));
      await mounted.editor!.undo();
      await vi.waitFor(() => expect(savedStyle(server, "badge").rotate).toBe("45deg"));
    } finally {
      await screen.unmount();
    }
  });

  it("turns several layers in one undo step, though each needs its own patch", async () => {
    const { server, screen } = await mount();
    try {
      select([layer("card"), layer("badge")]);
      await page.getByRole("button", { name: "Rotate 90°" }).click();
      await vi.waitFor(() => {
        expect(savedStyle(server, "card").rotate).toBe("90deg");
        expect(savedStyle(server, "badge").rotate).toBe("100deg");
      });
      expect(native.canvas.editLayers).toHaveBeenCalledTimes(2);
      await mounted.editor!.undo();
      await vi.waitFor(() => {
        expect(savedStyle(server, "card").rotate).toBeUndefined();
        expect(savedStyle(server, "badge").rotate).toBe("10deg");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("nudges by 8 with Shift and takes arithmetic", async () => {
    const { server, screen } = await mount();
    try {
      select([layer("badge")]);
      const width = page.getByRole("textbox", { name: "Width", exact: true });
      await expect.element(width).toHaveValue("40");
      press(width.element(), "ArrowUp", { shiftKey: true });
      await expect.element(width).toHaveValue("48");
      await vi.waitFor(() => expect(savedStyle(server, "badge").width).toBe("48px"));
      await typeInto("Width", "100/4");
      await vi.waitFor(() => expect(savedStyle(server, "badge").width).toBe("25px"));
    } finally {
      await screen.unmount();
    }
  });

  it("pins a layer to the right edge without moving it, and X then moves it from the right", async () => {
    const { server, screen, layer: rendered } = await mount();
    try {
      select([layer("badge")]);
      await pick("Horizontal constraint", "Right");
      // 400 wide frame, left 250, 40 wide: 110 from the right edge.
      await vi.waitFor(() => {
        expect(savedStyle(server, "badge").right).toBe("110px");
        expect(savedStyle(server, "badge").left).toBeUndefined();
      });
      await vi.waitFor(() => expect(rendered("badge")!.offsetLeft).toBe(250));
      await typeInto("X position", "200");
      await vi.waitFor(() => expect(savedStyle(server, "badge").right).toBe("160px"));
    } finally {
      await screen.unmount();
    }
  });

  it("aligns several absolute layers from the Layout header and wraps them in flex", async () => {
    const { server, screen } = await mount();
    try {
      select([layer("card"), layer("row")]);
      await page.getByRole("button", { name: "Align top" }).click();
      await vi.waitFor(() => expect(savedStyle(server, "row").top).toBe("20px"));
      // The card was already at the top edge: only the row was written.
      expect(native.canvas.editLayers).toHaveBeenCalledTimes(1);
      await page.getByRole("button", { name: /Wrap in flex/ }).click();
      await vi.waitFor(() => {
        const roots = server.frame("f1").layers.roots;
        expect(roots).not.toContain("card");
        const wrapper = server.frame("f1").layers.nodes.find((node) => node.id === roots[0]);
        expect(wrapper?.type === "element" && wrapper.children).toEqual(["card", "row"]);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("edits Flex: wrap, the cross-axis gap and Remove flex", async () => {
    const { server, screen } = await mount();
    try {
      select([layer("row")]);
      await page.getByRole("button", { name: "Wrap", exact: true }).click();
      await vi.waitFor(() => expect(savedStyle(server, "row")["flex-wrap"]).toBe("wrap"));
      await typeInto("Line gap", "12");
      await vi.waitFor(() => expect(savedStyle(server, "row")["row-gap"]).toBe("12px"));
      await page.getByRole("button", { name: "Remove flex" }).click();
      await vi.waitFor(() => {
        expect(savedStyle(server, "row").display).toBeUndefined();
        expect(savedStyle(server, "row").gap).toBeUndefined();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("stacks fills: adds one on top, makes it a gradient and reorders by dragging", async () => {
    const { server, screen, layer: rendered } = await mount();
    try {
      select([layer("card")]);
      await expect
        .element(page.getByRole("textbox", { name: "Fill", exact: true }))
        .toHaveValue("FFFFFF");
      await page.getByRole("button", { name: "Add fill" }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "card")["background-image"]).toBe(
          "linear-gradient(#FFFFFF, #FFFFFF)",
        ),
      );
      await page.getByRole("button", { name: "Fill type and blending" }).first().click();
      await page.getByRole("menuitemradio", { name: "Gradient" }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "card")["background-image"]).toBe(
          "linear-gradient(in oklab 180deg, #FFFFFF 0%, #FFFFFF00 100%)",
        ),
      );
      // The renderer shows the gradient (Chrome serializes it its own way).
      await vi.waitFor(() =>
        expect(getComputedStyle(rendered("card")!).backgroundImage).toContain("linear-gradient"),
      );
      await expect.element(page.getByRole("button", { name: "Edit Linear fill" })).toBeVisible();
      const handle = page.getByRole("button", { name: "Reorder fill 1" }).element();
      const box = handle.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      drag(handle, "pointerdown", x, y);
      for (const step of [6, 20, 34, 40]) {
        drag(document.body, "pointermove", x, y + step);
        await sleep(16);
      }
      drag(document.body, "pointerup", x, y + 40);
      // The gradient is now the bottom fill: the solid above it becomes an image layer.
      await vi.waitFor(() => {
        const style = savedStyle(server, "card");
        expect(style["background-image"]).toBe(
          "linear-gradient(#FFFFFF, #FFFFFF), linear-gradient(in oklab 180deg, #FFFFFF 0%, #FFFFFF00 100%)",
        );
        expect(style["background-color"]).toBeUndefined();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("replaces mixed fills with the first layer's, in one undo step", async () => {
    const { server, screen } = await mount();
    try {
      select([layer("card"), layer("badge")]);
      await page.getByRole("button", { name: "Mixed fills · click to unify" }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "badge")["background-color"]).toBe("#FFFFFF"),
      );
      await mounted.editor!.undo();
      await vi.waitFor(() =>
        expect(savedStyle(server, "badge")["background-color"]).toBe("#ff0000"),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("aligns text vertically and formats wrap, truncation and the italic style", async () => {
    const { server, screen, layer: rendered } = await mount();
    try {
      select([layer("label")]);
      await page.getByRole("radio", { name: "Align bottom" }).click();
      await vi.waitFor(() => expect(savedStyle(server, "label")["align-content"]).toBe("end"));
      await vi.waitFor(() => expect(getComputedStyle(rendered("label")!).alignContent).toBe("end"));
      await pick("Style", "Italic");
      await vi.waitFor(() => {
        expect(savedStyle(server, "label")["font-style"]).toBe("italic");
        expect(savedStyle(server, "label")["font-weight"]).toBe("400");
      });
      await page.getByRole("button", { name: "Formatting" }).click();
      await pick("Wrap", "Balanced");
      await vi.waitFor(() => expect(savedStyle(server, "label")["text-wrap"]).toBe("balance"));
      await page.getByRole("checkbox", { name: "Truncate with an ellipsis" }).click();
      await vi.waitFor(() => expect(savedStyle(server, "label")["-webkit-line-clamp"]).toBe("1"));
      await vi.waitFor(() =>
        expect(getComputedStyle(rendered("label")!).getPropertyValue("-webkit-line-clamp")).toBe(
          "1",
        ),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("adds Underline from its dimmed header and edits thickness and shape", async () => {
    const { server, screen, layer: rendered } = await mount();
    try {
      select([layer("label")]);
      await page.getByRole("button", { name: "Underline", exact: true }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "label")["text-decoration-line"]).toBe("underline"),
      );
      await vi.waitFor(() =>
        expect(getComputedStyle(rendered("label")!).textDecorationLine).toBe("underline"),
      );
      await typeInto("Underline thickness", "2");
      await vi.waitFor(() =>
        expect(savedStyle(server, "label")["text-decoration-thickness"]).toBe("2px"),
      );
      await page.getByRole("button", { name: "Underline options" }).click();
      await page.getByRole("menuitem", { name: "Shape" }).click();
      await page.getByRole("menuitemradio", { name: "Wavy" }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "label")["text-decoration-style"]).toBe("wavy"),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("adds an Outline and a Text stroke that the renderer paints", async () => {
    const { server, screen, layer: rendered } = await mount();
    try {
      select([layer("card")]);
      await page.getByRole("button", { name: "Outline", exact: true }).click();
      await vi.waitFor(() => expect(savedStyle(server, "card")["outline-style"]).toBe("solid"));
      await typeInto("Outline offset", "4");
      await vi.waitFor(() => expect(savedStyle(server, "card")["outline-offset"]).toBe("4px"));
      await vi.waitFor(() => expect(getComputedStyle(rendered("card")!).outlineOffset).toBe("4px"));
      select([layer("label")]);
      // Text-only layers have no Outline.
      await expect
        .element(page.getByRole("button", { name: "Text stroke", exact: true }))
        .toBeVisible();
      expect(document.querySelector('[aria-label="Add Outline"]')).toBeNull();
      await page.getByRole("button", { name: "Text stroke", exact: true }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "label")["-webkit-text-stroke-width"]).toBe("1px"),
      );
      await pick("Stroke placement", "Under fill");
      await vi.waitFor(() =>
        expect(savedStyle(server, "label")["paint-order"]).toBe("stroke fill"),
      );
      await vi.waitFor(() => {
        const style = getComputedStyle(rendered("label")!);
        expect(style.getPropertyValue("-webkit-text-stroke-width")).toBe("1px");
        // Chrome serializes "stroke fill" as its shortest form.
        expect(style.paintOrder).toBe("stroke");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("adds shadows, switches them to drop-shadow filters, and adds an inner shadow", async () => {
    const { server, screen, layer: rendered } = await mount();
    try {
      select([layer("card")]);
      await page.getByRole("button", { name: "Shadow", exact: true }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "card")["box-shadow"]).toBe("0px 4px 12px 0px #00000040"),
      );
      await page.getByRole("button", { name: "Shadow type" }).click();
      await page.getByRole("menuitemradio", { name: "Drop shadow" }).click();
      await vi.waitFor(() => {
        expect(savedStyle(server, "card").filter).toBe("drop-shadow(0px 4px 12px #00000040)");
        expect(savedStyle(server, "card")["box-shadow"]).toBeUndefined();
      });
      await page.getByRole("button", { name: "Inner shadow", exact: true }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "card")["box-shadow"]).toBe("inset 0px 4px 12px 0px #00000040"),
      );
      await vi.waitFor(() =>
        expect(getComputedStyle(rendered("card")!).boxShadow).toContain("inset"),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("adds layer and backdrop filters, and changes a filter's type", async () => {
    const { server, screen, layer: rendered } = await mount();
    try {
      select([layer("card")]);
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await vi.waitFor(() => expect(savedStyle(server, "card").filter).toBe("blur(4px)"));
      await page.getByRole("button", { name: "Add Backdrop" }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "card")["backdrop-filter"]).toBe("blur(4px)"),
      );
      await page.getByRole("combobox", { name: "Filter type", exact: true }).first().click();
      await page.getByRole("option", { name: "Grayscale", exact: true }).click();
      await vi.waitFor(() => expect(savedStyle(server, "card").filter).toBe("grayscale(100%)"));
      await vi.waitFor(() => {
        const style = getComputedStyle(rendered("card")!);
        expect(style.filter).toBe("grayscale(1)");
        expect(style.backdropFilter).toBe("blur(4px)");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("lists the selection's colours and recolours every use in place", async () => {
    const { server, screen } = await mount();
    try {
      select([layer("card")]);
      const colors = page.getByRole("textbox", { name: /^Selection color \d$/ });
      await vi.waitFor(() =>
        expect(colors.elements().map((input) => (input as HTMLInputElement).value)).toEqual([
          "FFFFFF",
          "111111",
        ]),
      );
      const textColor = colors.elements()[1] as HTMLInputElement;
      await page.elementLocator(textColor).fill("222222");
      press(textColor, "Enter");
      await vi.waitFor(() => expect(savedStyle(server, "label").color).toBe("#222222"));
      expect(native.canvas.editLayers).toHaveBeenCalledTimes(1);
      expect(native.canvas.editLayers.mock.calls[0]![0].edit.operations).toEqual([
        { type: "set_styles", nodeId: "label", styles: { color: "#222222" } },
      ]);
    } finally {
      await screen.unmount();
    }
  });
});

describe("colour picker", () => {
  beforeEach(async () => {
    await page.viewport(1200, 900);
    resetCanvasStores();
    localStorage.clear();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
    native.canvas.fontCatalog.mockResolvedValue({ families: [], available: true });
    native.canvas.getAsset.mockRejectedValue(new Error("no assets in this test"));
  });
  afterEach(() => select([]));

  it("picks on the area, reverts to Previous, keeps a wide colour as typed and clamps it", async () => {
    const { server, screen } = await mount();
    try {
      select([layer("badge")]);
      await page.getByRole("button", { name: "Open the color picker for Fill" }).click();
      await expect.element(page.getByText("255 0 0", { exact: true })).toBeVisible();
      const area = page.getByRole("slider", { name: /^Saturation and brightness, perceptual hue/ });
      await area.click({ position: { x: 76, y: 76 } });
      await vi.waitFor(() => {
        const saved = savedStyle(server, "badge")["background-color"];
        expect(saved).toMatch(/^#[0-9A-F]{6}$/);
        expect(saved).not.toBe("#FF0000");
      });
      await page.getByRole("button", { name: "Previous color, click to restore" }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "badge")["background-color"]).toBe("#FF0000"),
      );
      // A colour outside sRGB is stored as written, and the badge offers the sRGB colour.
      const text = page.getByRole("textbox", { name: "Color value", exact: true });
      await text.fill("oklch(0.7 0.35 150)");
      press(text.element(), "Enter");
      await vi.waitFor(() =>
        expect(savedStyle(server, "badge")["background-color"]).toBe("oklch(0.7 0.35 150)"),
      );
      await page.getByRole("button", { name: "Out of gamut" }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "badge")["background-color"]).toMatch(/^#[0-9A-F]{6}$/),
      );
      // The format menu changes what the field shows; right-click switches the area's space.
      await page.getByRole("button", { name: "Color format" }).click();
      await page.getByRole("menuitemradio", { name: "OKLCH" }).click();
      await vi.waitFor(() =>
        expect((text.element() as HTMLInputElement).value).toMatch(
          /^oklch\(0\.\d+ 0\.\d+ [\d.]+\)$/,
        ),
      );
      await area.click({ button: "right" });
      await expect
        .element(page.getByRole("slider", { name: /^Saturation and brightness, classic hue/ }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});

describe("font picker", () => {
  beforeEach(async () => {
    await page.viewport(1200, 900);
    resetCanvasStores();
    localStorage.clear();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
    native.canvas.fontCatalog.mockResolvedValue({
      families: [
        {
          family: "Inter",
          category: "sans-serif",
          weights: [100, 900],
          italic: true,
          variable: true,
        },
        { family: "Lora", category: "serif", weights: [400, 700], italic: false, variable: false },
      ],
      available: true,
    });
    native.canvas.getAsset.mockRejectedValue(new Error("no assets in this test"));
  });
  afterEach(() => select([]));

  it("stars a family, lists it under Favorites and picks it from there", async () => {
    const { server, screen } = await mount();
    native.canvas.addFont.mockImplementation(async () => server.work);
    try {
      select([layer("label")]);
      await page.getByRole("combobox", { name: "Font family" }).click();
      await page.getByRole("button", { name: "Add Lora to favorites" }).click();
      // The star does not pick the row.
      await expect
        .element(page.getByRole("button", { name: "Remove Lora from favorites" }))
        .toBeVisible();
      expect(native.canvas.addFont).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem("synara.canvas.fontFavorites") ?? "[]")).toEqual([
        "Lora",
      ]);
      await page.getByRole("radio", { name: "Favorites", exact: true }).click();
      await expect.element(page.getByRole("option", { name: /Inter/ })).not.toBeInTheDocument();
      await page.getByRole("option", { name: /Lora/ }).click();
      await vi.waitFor(() =>
        expect(savedStyle(server, "label")["font-family"]).toBe('"Lora", serif'),
      );
      expect(native.canvas.addFont).toHaveBeenCalledWith({ workId: "work1", family: "Lora" });
      // Lora has no italics in the catalog: only upright styles are offered.
      await page.getByRole("combobox", { name: "Style", exact: true }).click();
      await expect.element(page.getByRole("option", { name: "Bold", exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("option", { name: "Bold italic" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
