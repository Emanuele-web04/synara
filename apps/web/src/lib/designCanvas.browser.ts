import type { DesignLayerTree } from "@synara/contracts";
import { expect, it } from "vitest";
import {
  attachDesignFrameRenderer,
  buildDesignFrameRoot,
  createDesignFrameRenderer,
  fitDesignCanvas,
  sanitizeDesignStyle,
  zoomDesignCanvas,
  type DesignRenderContext,
} from "./designCanvas";

const context: DesignRenderContext = {
  assetUrl: (id) => (id === "logo" ? "blob:logo" : null),
  fonts: new Map([["inter", "SynaraCanvas Inter"]]),
};
const styles = (source: string) =>
  Object.fromEntries(
    sanitizeDesignStyle(source, context).map(([property, value]) => [property, value]),
  );

it("drops anything that would reach outside the frame", () => {
  const result = styles(
    "background-image:url(https://example.com/x.png);border-image:url(synara-asset:missing) 1;pointer-events:none;cursor:pointer;color:red",
  );
  expect(result.color).toBe("red");
  expect(Object.values(result).some((value) => value.includes("url("))).toBe(false);
  expect(result["pointer-events"]).toBeUndefined();
  expect(result.cursor).toBeUndefined();
});

it("keeps owned assets, maps viewport units to the frame and renames design variables", () => {
  const result = styles(
    'background-image:url("synara-asset:logo");min-height:100vh;width:50vw;--brand:#123;color:var(--brand);font-family:Inter, sans-serif',
  );
  expect(result["background-image"]).toBe('url("blob:logo")');
  expect(result["min-height"]).toBe("100cqh");
  expect(result.width).toBe("50cqw");
  expect(result["--sc-brand"]).toBe("#123");
  expect(result.color).toBe("var(--sc-brand)");
  expect(result["font-family"]).toBe('"SynaraCanvas Inter", sans-serif');
});

it("keeps every declaration the inspector's sections write, and drops app-region", () => {
  const result = styles(
    [
      "rotate:45deg",
      "left:calc(50% - 20px)",
      'background-image:linear-gradient(in oklab 90deg, #FF0000 0%, #0000FF00 100%), url("synara-asset:logo")',
      "background-blend-mode:multiply, normal",
      "background-size:auto, cover",
      "text-decoration-line:underline",
      "text-decoration-style:wavy",
      "text-decoration-thickness:2px",
      "text-underline-offset:10%",
      "text-decoration-skip-ink:none",
      "outline:2px dashed #333333",
      "outline-offset:4px",
      "-webkit-text-stroke-width:1px",
      "-webkit-text-stroke-color:#000000",
      "paint-order:stroke fill",
      "box-shadow:inset 0px 4px 12px 0px #00000040",
      "text-shadow:1px 2px 3px #000000",
      "filter:blur(4px) drop-shadow(0px 4px 12px #00000040)",
      "backdrop-filter:blur(4px)",
      "text-wrap:balance",
      "word-break:keep-all",
      "display:-webkit-box",
      "-webkit-box-orient:vertical",
      "-webkit-line-clamp:2",
      "align-content:end",
      "color:oklch(0.7 0.35 150)",
      "-webkit-app-region:drag",
      "app-region:drag",
    ].join(";"),
  );
  expect(result.rotate).toBe("45deg");
  expect(result.left).toBe("calc(50% - 20px)");
  expect(result["background-image"]).toContain('url("blob:logo")');
  // Chrome writes the interpolation after the angle; the inspector reads either order.
  expect(result["background-image"]).toContain("in oklab");
  expect(result["background-blend-mode"]).toBe("multiply, normal");
  expect(result["text-decoration-style"]).toBe("wavy");
  expect(result["text-underline-offset"]).toBe("10%");
  expect(result["outline-offset"]).toBe("4px");
  expect(result["-webkit-text-stroke-width"]).toBe("1px");
  expect(result["paint-order"]).toBeDefined();
  expect(result["box-shadow"]).toContain("inset");
  expect(result.filter).toContain("drop-shadow");
  expect(result["backdrop-filter"]).toBe("blur(4px)");
  expect(result["-webkit-line-clamp"]).toBe("2");
  expect(result["align-content"]).toBe("end");
  expect(result.color).toBe("oklch(0.7 0.35 150)");
  expect(result["-webkit-app-region"]).toBeUndefined();
  expect(result["app-region"]).toBeUndefined();
});

it("builds DOM only from allowed layers, with inert controls and layer IDs", () => {
  const root = buildDesignFrameRoot(
    document,
    {
      style: "background:#fff",
      layers: {
        roots: ["b", "x"],
        nodes: [
          {
            id: "b",
            type: "element",
            tag: "button",
            attributes: { onclick: "alert(1)" },
            children: ["t"],
          },
          { id: "t", type: "text", text: "<script>" },
          { id: "x", type: "element", tag: "script", attributes: {}, children: [] },
        ],
      },
    },
    context,
  );
  expect(root.querySelector("script")).toBeNull();
  const button = root.querySelector("button")!;
  expect(button.hasAttribute("onclick")).toBe(false);
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(button.hasAttribute("data-synara-inert")).toBe(true);
  expect(button.getAttribute("data-synara-layer-id")).toBe("b");
  expect(button.textContent).toBe("<script>");
});

/** A bare element layer for the form-control test. */
const control = (id: string, tag: string, attributes: Record<string, string> = {}) => ({
  id,
  type: "element" as const,
  tag,
  attributes,
  children: [] as string[],
});

it("draws inert form controls enabled in the frame's font, and they still take no input", async () => {
  const { userEvent } = await import("vitest/browser");
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px";
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const renderer = attachDesignFrameRenderer(shadow);
  renderer.update(
    {
      style: "font-family:Georgia, serif;font-size:18px",
      layers: {
        roots: ["button", "input", "area", "select", "authored"],
        nodes: [
          { ...control("button", "button", { type: "submit" }), children: ["label"] },
          { id: "label", type: "text", text: "Upgrade" },
          control("input", "input", { value: "Name" }),
          control("area", "textarea"),
          { ...control("select", "select"), children: ["option"] },
          { ...control("option", "option"), children: ["optionText"] },
          { id: "optionText", type: "text", text: "Team plan" },
          { ...control("authored", "button", { disabled: "" }), children: ["off"] },
          { id: "off", type: "text", text: "Off" },
        ],
      },
    },
    context,
  );
  // What the browser draws for the same controls when they are enabled, in the same stylesheet.
  const reference = (tag: string) => {
    const node = document.createElement(tag);
    renderer.root.append(node);
    const style = getComputedStyle(node);
    const result = {
      color: style.color,
      background: style.backgroundColor,
      border: style.borderTopColor,
      opacity: style.opacity,
    };
    node.remove();
    return result;
  };
  const drawn = (id: string) => {
    const style = getComputedStyle(renderer.element(id)!);
    return {
      color: style.color,
      background: style.backgroundColor,
      border: style.borderTopColor,
      opacity: style.opacity,
    };
  };
  try {
    for (const [id, tag] of [
      ["button", "button"],
      ["input", "input"],
      ["area", "textarea"],
      ["select", "select"],
    ] as const) {
      const element = renderer.element(id)!;
      expect(element.hasAttribute("disabled")).toBe(true);
      expect(drawn(id)).toEqual(reference(tag));
      expect(getComputedStyle(element).fontFamily).toBe(getComputedStyle(renderer.root).fontFamily);
      expect(getComputedStyle(element).fontSize).toBe("18px");
    }
    // The select shows its option: options are not disabled themselves.
    expect((renderer.element("select") as HTMLSelectElement).value).toBe("Team plan");
    expect(renderer.element("option")!.hasAttribute("disabled")).toBe(false);
    // A control the design disabled itself keeps the browser's disabled look.
    expect(renderer.element("authored")!.hasAttribute("data-synara-inert")).toBe(false);
    expect(drawn("authored").color).not.toBe(reference("button").color);

    // Still inert: no focus, no activation, no typing, no submission.
    const clicks: string[] = [];
    shadow.addEventListener("click", (event) => clicks.push((event.target as Element).tagName));
    const button = renderer.element("button") as HTMLButtonElement;
    const input = renderer.element("input") as HTMLInputElement;
    button.focus();
    input.focus();
    expect(shadow.activeElement).toBeNull();
    button.click();
    expect(clicks).toEqual([]);
    await userEvent.click(input, { force: true });
    await userEvent.keyboard("typed{Enter}");
    expect(shadow.activeElement).toBeNull();
    expect(input.value).toBe("Name");
    expect(button.form).toBeNull();
  } finally {
    host.remove();
  }
});

it("zooms around the cursor and fits content", () => {
  const view = zoomDesignCanvas({ x: 0, y: 0, zoom: 1 }, 100, 50, 2);
  expect(view).toEqual({ x: -100, y: -50, zoom: 2 });
  const fit = fitDesignCanvas([{ x: 0, y: 0, width: 1000, height: 500 }], 1160, 660, {
    padding: 80,
  });
  expect(fit.zoom).toBe(1);
});

it("keeps checkboxes, radios and sliders enabled-looking but inert: no focus, no check, no drag", async () => {
  const { userEvent } = await import("vitest/browser");
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px";
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const renderer = attachDesignFrameRenderer(shadow);
  renderer.update(
    {
      style: "background:#fff",
      layers: {
        roots: ["label", "radio", "range", "off"],
        nodes: [
          { ...control("label", "label"), children: ["check", "labelText"] },
          control("check", "input", { type: "checkbox" }),
          { id: "labelText", type: "text", text: "Remember me" },
          control("radio", "input", { type: "radio", name: "plan" }),
          control("range", "input", {
            type: "range",
            min: "0",
            max: "100",
            value: "20",
            style: "width:200px",
          }),
          control("off", "input", { type: "checkbox", disabled: "" }),
        ],
      },
    },
    context,
  );
  const check = renderer.element("check") as HTMLInputElement;
  const radio = renderer.element("radio") as HTMLInputElement;
  const range = renderer.element("range") as HTMLInputElement;
  const events: string[] = [];
  for (const type of ["input", "change"])
    shadow.addEventListener(type, (event) =>
      events.push(`${type}:${(event.target as Element).id}`),
    );
  try {
    // Enabled, so the browser paints them as it paints enabled controls; out of the tab order.
    for (const input of [check, radio, range]) {
      expect(input.matches(":enabled")).toBe(true);
      expect(input.tabIndex).toBe(-1);
      expect(input.hasAttribute("data-synara-inert")).toBe(true);
    }
    // One the design disabled keeps the disabled look.
    expect((renderer.element("off") as HTMLInputElement).disabled).toBe(true);

    // Real clicks (on the box, through its label, on the slider's track) change nothing.
    await userEvent.click(check);
    await userEvent.click(shadow.querySelector("label")!, { position: { x: 120, y: 8 } });
    await userEvent.click(radio);
    await userEvent.click(range, { position: { x: 180, y: 8 } });
    expect(check.checked).toBe(false);
    expect(radio.checked).toBe(false);
    expect(range.value).toBe("20");
    // Nothing takes focus, by pointer or by script, so keys cannot reach them either.
    check.focus();
    range.focus();
    expect(shadow.activeElement).toBeNull();
    await userEvent.keyboard(" {ArrowRight}");
    expect(check.checked).toBe(false);
    expect(range.value).toBe("20");
    expect(events).toEqual([]);
  } finally {
    host.remove();
  }
});

it("exports a frame, or one layer alone on transparency, at the requested size", async () => {
  const { exportCanvasTarget } = await import("./canvasExport");
  const frame = {
    width: 200,
    height: 100,
    style: "background:#ff0000",
    layers: {
      roots: ["box"],
      nodes: [
        {
          id: "box",
          type: "element" as const,
          tag: "div",
          attributes: {
            style: "position:absolute;left:50px;top:25px;width:40px;height:20px;background:#0000ff",
          },
          children: [],
        },
      ],
    },
  };
  const pixels = async (blob: Blob) => {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      at: (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data],
    };
  };
  // Exports are Display P3, so colours come back within a rounding step.
  const near = (actual: number[], expected: number[]) =>
    expect(actual.every((value, index) => Math.abs(value - expected[index]!) <= 3)).toBe(true);
  const png = await exportCanvasTarget(
    { frame, layerId: null, rect: { x: 0, y: 0, width: 200, height: 100 } },
    [],
    "2x",
    "png",
  );
  const bytes = new TextDecoder("latin1").decode(await png.arrayBuffer());
  expect(bytes.includes("iCCP") || bytes.includes("cICP")).toBe(true);
  const whole = await pixels(png);
  expect([whole.width, whole.height]).toEqual([400, 200]);
  near(whole.at(4, 4), [255, 0, 0, 255]);
  const layer = await pixels(
    await exportCanvasTarget(
      { frame, layerId: "box", rect: { x: 40, y: 15, width: 60, height: 40 } },
      [],
      "120w",
      "png",
    ),
  );
  expect([layer.width, layer.height]).toEqual([120, 80]);
  // The frame's red fill is not part of a layer export; the layer itself is.
  expect(layer.at(2, 2)[3]).toBe(0);
  near(layer.at(60, 40), [0, 0, 255, 255]);
});

const SVG = "http://www.w3.org/2000/svg";
type Layer = DesignLayerTree["nodes"][number];
const el = (
  id: string,
  tag: string,
  attributes: Record<string, string> = {},
  children: string[] = [],
): Layer => ({ id, type: "element", tag, attributes, children });

it("renders an inline SVG icon with createElementNS: its box, colour and exact attribute names", () => {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;width:200px;height:100px";
  document.body.append(host);
  try {
    const renderer = attachDesignFrameRenderer(host.attachShadow({ mode: "open" }));
    renderer.update(
      {
        style: "color:#ff0000",
        layers: {
          roots: ["icon"],
          nodes: [
            el(
              "icon",
              "svg",
              {
                viewBox: "0 0 24 24",
                width: "24",
                height: "24",
                preserveAspectRatio: "xMidYMid meet",
                style: "display:block",
              },
              ["grad", "shape"],
            ),
            el("grad", "linearGradient", { id: "g", gradientUnits: "userSpaceOnUse" }, ["stop"]),
            el("stop", "stop", { offset: "0", "stop-color": "#00ff00" }),
            el("shape", "path", { d: "M0 0h24v24H0z", fill: "currentColor" }),
          ],
        },
      },
      context,
    );
    const svg = renderer.element("icon")!;
    const path = renderer.element("shape")!;
    const gradient = renderer.element("grad")!;
    expect(svg.namespaceURI).toBe(SVG);
    expect(path.namespaceURI).toBe(SVG);
    expect(gradient.localName).toBe("linearGradient");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
    expect(gradient.getAttribute("gradientUnits")).toBe("userSpaceOnUse");
    const box = svg.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([24, 24]);
    expect(getComputedStyle(path).fill).toBe("rgb(255, 0, 0)");
    // Only the SVG carries a layer ID: the editor hits and selects it as one layer.
    expect(svg.getAttribute("data-synara-layer-id")).toBe("icon");
    expect(path.hasAttribute("data-synara-layer-id")).toBe(false);
    // Its IDs live in the SVG's own scope.
    expect(gradient.id).toBe("sc.icon.g");
  } finally {
    host.remove();
  }
});

it("keeps refused SVG constructs out of the DOM even when the model holds them", () => {
  // A forged tree that skipped the server: the renderer enforces the subset again.
  const root = buildDesignFrameRoot(
    document,
    {
      layers: {
        roots: ["svg", "stray", "html"],
        nodes: [
          el("svg", "svg", { onload: "alert(1)", viewBox: "0 0 4 4" }, [
            "script",
            "fo",
            "use",
            "image",
            "a",
            "anim",
            "grad",
            "shape",
            "title",
            "div",
            "text",
          ]),
          el("script", "script", {}, ["code"]),
          { id: "code", type: "text", text: "alert(1)" },
          el("fo", "foreignObject", {}, []),
          el("use", "use", { href: "https://evil.example/s.svg#a" }),
          el("image", "image", { href: "https://evil.example/x.png" }),
          el("a", "a", { href: "https://evil.example" }),
          el("anim", "animate", { attributeName: "x" }),
          el("grad", "linearGradient", { id: "g", href: "https://evil.example/g.svg#g" }),
          el("shape", "path", {
            d: "M0 0h4v4z",
            onclick: "x()",
            fill: "url(https://evil.example/#g)",
            stroke: "var(--x)",
            "clip-path": "url(#c)",
          }),
          el("title", "title", {}, ["b"]),
          el("b", "b", {}, []),
          el("div", "div", {}, []),
          { id: "text", type: "text", text: "loose" },
          el("stray", "path", { d: "M0 0" }),
          el("html", "div", { id: "sc.svg.c" }),
        ],
      },
    },
    context,
  );
  const svg = root.querySelector("svg")!;
  expect([...svg.children].map((child) => child.localName)).toEqual([
    "linearGradient",
    "path",
    "title",
  ]);
  expect(svg.hasAttribute("onload")).toBe(false);
  const gradient = svg.querySelector("linearGradient")!;
  expect(gradient.hasAttribute("href")).toBe(false);
  const path = svg.querySelector("path")!;
  expect(path.getAttributeNames().toSorted()).toEqual(["clip-path", "d"]);
  expect(path.getAttribute("clip-path")).toBe("url(#sc.svg.c)");
  expect(svg.querySelector("title")!.childNodes).toHaveLength(0);
  expect(svg.textContent).toBe("");
  // A path outside an svg is never rendered, and an HTML ID can never take a scoped SVG ID.
  expect(root.children).toHaveLength(2);
  expect(root.querySelector("div")!.hasAttribute("id")).toBe(false);
});

it("patches an SVG in place: restyling a sibling keeps its DOM nodes, an edit rewrites one", () => {
  const renderer = createDesignFrameRenderer(document);
  const layers = (siblingColor: string, fill: string) => ({
    roots: ["card"],
    nodes: [
      el("card", "div", {}, ["label", "icon"]),
      el("label", "span", { style: `color:${siblingColor}` }, []),
      el("icon", "svg", { viewBox: "0 0 4 4" }, ["shape"]),
      el("shape", "path", { d: "M0 0h4v4z", fill }),
    ],
  });
  const first = layers("red", "#000");
  renderer.update({ layers: first }, context);
  const svg = renderer.element("icon")!;
  const path = renderer.element("shape")!;
  // A delta restyling the sibling: the SVG's nodes are reused as they are.
  const restyled = {
    ...first,
    nodes: first.nodes.map((node) =>
      node.id === "label" ? layers("blue", "#000").nodes[1]! : node,
    ),
  };
  expect(renderer.update({ layers: restyled }, context)).toBe(true);
  expect(renderer.element("icon")).toBe(svg);
  expect(renderer.element("shape")).toBe(path);
  // An edit to a shape rewrites that node only, in place.
  const recolored = {
    ...restyled,
    nodes: restyled.nodes.map((node) =>
      node.id === "shape" ? layers("blue", "#00f").nodes[3]! : node,
    ),
  };
  renderer.update({ layers: recolored }, context);
  expect(renderer.element("shape")).toBe(path);
  expect(path.getAttribute("fill")).toBe("#00f");
});

it("scopes gradient IDs per SVG, so two icons with the same ID keep their own (pixel check)", async () => {
  const { exportCanvasTarget } = await import("./canvasExport");
  const icon = (prefix: string, color: string, x: number): Layer[] => [
    el(
      `${prefix}svg`,
      "svg",
      {
        viewBox: "0 0 10 10",
        width: "10",
        height: "10",
        style: `position:absolute;left:${x}px;top:0`,
      },
      [`${prefix}grad`, `${prefix}rect`],
    ),
    el(`${prefix}grad`, "linearGradient", { id: "g" }, [`${prefix}stop`]),
    el(`${prefix}stop`, "stop", { offset: "0", "stop-color": color }),
    el(`${prefix}rect`, "rect", { width: "10", height: "10", fill: "url(#g)" }),
  ];
  const frame = {
    width: 40,
    height: 10,
    style: "background:#ffffff",
    layers: {
      roots: ["asvg", "bsvg"],
      nodes: [...icon("a", "#ff0000", 0), ...icon("b", "#0000ff", 20)],
    },
  };
  const png = await exportCanvasTarget(
    { frame, layerId: null, rect: { x: 0, y: 0, width: 40, height: 10 } },
    [],
    "1x",
    "png",
  );
  const bitmap = await createImageBitmap(png);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const paint = canvas.getContext("2d")!;
  paint.drawImage(bitmap, 0, 0);
  const at = (x: number, y: number) => [...paint.getImageData(x, y, 1, 1).data];
  const near = (actual: number[], expected: number[]) =>
    expect(
      actual.every((value, index) => Math.abs(value - expected[index]!) <= 3),
      `${actual}`,
    ).toBe(true);
  // The nested SVG survives the foreignObject rasterization, each with its own gradient.
  near(at(5, 5), [255, 0, 0, 255]);
  near(at(25, 5), [0, 0, 255, 255]);
  near(at(15, 5), [255, 255, 255, 255]);
  // A layer export of one SVG paints it alone on transparency.
  const alone = await createImageBitmap(
    await exportCanvasTarget(
      { frame, layerId: "bsvg", rect: { x: 20, y: 0, width: 10, height: 10 } },
      [],
      "1x",
      "png",
    ),
  );
  paint.clearRect(0, 0, canvas.width, canvas.height);
  paint.drawImage(alone, 0, 0);
  near(at(5, 5), [0, 0, 255, 255]);
});
