import { describe, expect, it } from "vitest";
import {
  addGradientStop,
  alignBoxes,
  alignmentPatch,
  angleDegrees,
  borderSides,
  borderWidthPatch,
  declaredValues,
  distributeBoxes,
  distributeStops,
  evaluateArithmetic,
  fontFamilyValue,
  fontWeightOptions,
  formatBoxShadow,
  formatFills,
  formatFilterList,
  formatGradient,
  formatHex,
  formatNumber,
  formatTextShadow,
  imageFitOf,
  insetExpansion,
  isAlignmentCell,
  isDropShadowFilter,
  isHandledProperty,
  joinBoxShadows,
  largeStepFor,
  MIXED,
  mergeValues,
  mixedNumber,
  moveItem,
  normalizeDegrees,
  parseBoxShadow,
  parseCssColor,
  parseCssInput,
  parseFills,
  parseFilterList,
  parseGradient,
  parseInlineStyle,
  pinnedPositionPatch,
  pinPatch,
  primaryFontFamily,
  readAlignment,
  readAutoLength,
  readDecorationLine,
  readLetterSpacing,
  readLineHeight,
  readPin,
  readSizingMode,
  readTextVerticalAlign,
  readTextWrap,
  readTruncation,
  replaceFilterGroup,
  rotateDegrees,
  rotationPatch,
  searchFamilies,
  sizingPatch,
  splitBoxShadows,
  textVerticalAlignPatch,
  textWrapPatch,
  toCssColor,
  transformRotation,
  truncationPatch,
  unitValueText,
  type Fill,
  type SizingContext,
} from "./inspectorValues";

describe("inline declarations", () => {
  it("splits on semicolons outside parentheses and quotes, keeping the last value", () => {
    const declarations = parseInlineStyle(
      'Background: url("a;b.png") no-repeat; color: red !important; font-family: "A;B", serif; color: blue',
    );
    expect(declarations).toEqual([
      { property: "background", value: 'url("a;b.png") no-repeat', important: false },
      { property: "color", value: "red", important: true },
      { property: "font-family", value: '"A;B", serif', important: false },
      { property: "color", value: "blue", important: false },
    ]);
    expect(declaredValues(declarations).get("color")).toBe("blue");
  });

  it("ignores empty and malformed parts and keeps custom property case", () => {
    expect(parseInlineStyle(";;nonsense; --Brand-Color: #fff;width:")).toEqual([
      { property: "--Brand-Color", value: "#fff", important: false },
    ]);
  });

  it("routes properties with dedicated controls away from Other styles", () => {
    expect(
      ["padding-inline", "border-top-left-radius", "background", "gap"].every(isHandledProperty),
    ).toBe(true);
    // The inspector's other sections own these.
    expect(
      [
        "rotate",
        "inset",
        "outline-offset",
        "text-decoration-thickness",
        "text-underline-offset",
        "-webkit-text-stroke-width",
        "paint-order",
        "filter",
        "backdrop-filter",
        "text-shadow",
        "text-wrap",
        "-webkit-line-clamp",
        "word-break",
        "align-content",
      ].every(isHandledProperty),
    ).toBe(true);
    expect(
      ["margin", "transform", "z-index", "--brand", "white-space"].some(isHandledProperty),
    ).toBe(false);
  });
});

describe("number input", () => {
  it.each([
    ["12", { kind: "length", value: 12, unit: "px" }],
    ["12px", { kind: "length", value: 12, unit: "px" }],
    ["50 %", { kind: "length", value: 50, unit: "%" }],
    [" 1.25EM ", { kind: "length", value: 1.25, unit: "em" }],
    ["-4", { kind: "length", value: -4, unit: "px" }],
    [".5", { kind: "length", value: 0.5, unit: "px" }],
    ["1,5", { kind: "length", value: 1.5, unit: "px" }],
    ["auto", { kind: "keyword", keyword: "auto" }],
    ["Fill", { kind: "keyword", keyword: "fill" }],
  ])("parses %j", (text, expected) => {
    expect(parseCssInput(text, "px")).toEqual(expected);
  });

  it("rejects text that is not a number, unit or keyword", () => {
    expect(parseCssInput("", "px")).toBeNull();
    expect(parseCssInput("12 apples", "px")).toBeNull();
    expect(parseCssInput("calc(1px)", "px")).toBeNull();
  });

  it("evaluates arithmetic, as number fields accept expressions", () => {
    expect(parseCssInput("24*2", "px")).toEqual({ kind: "length", value: 48, unit: "px" });
    expect(parseCssInput("(100 - 8) / 2", "px")).toEqual({ kind: "length", value: 46, unit: "px" });
    expect(parseCssInput("16px+4px", "px")).toEqual({ kind: "length", value: 20, unit: "px" });
    expect(parseCssInput("50%/2", "px")).toEqual({ kind: "length", value: 25, unit: "%" });
    expect(parseCssInput("-2*-3", "")).toEqual({ kind: "length", value: 6, unit: "" });
    // Two units, a dangling operator, names or a division by zero are not values.
    expect(parseCssInput("10px+2em", "px")).toBeNull();
    expect(parseCssInput("2*", "px")).toBeNull();
    expect(parseCssInput("alert(1)", "px")).toBeNull();
    expect(parseCssInput("1/0", "px")).toBeNull();
    expect(evaluateArithmetic("2+3*4")).toBe(14);
    expect(evaluateArithmetic("((1))")).toBe(1);
    expect(evaluateArithmetic(`${"(".repeat(20)}1${")".repeat(20)}`)).toBeNull();
  });

  it("nudges by 8 with Shift, and fractional steps by tenfold", () => {
    expect(largeStepFor(1)).toBe(8);
    expect(largeStepFor(0.01)).toBe(0.1);
  });

  it("uses the field's unit for bare numbers, including unitless fields", () => {
    expect(parseCssInput("1.5", "")).toEqual({ kind: "length", value: 1.5, unit: "" });
  });

  it("formats compactly without trailing zeros or negative zero", () => {
    expect(formatNumber(12.3456)).toBe("12.35");
    expect(formatNumber(12)).toBe("12");
    expect(formatNumber(-0.001)).toBe("0");
  });
});

describe("mixed values", () => {
  it("returns the shared value, MIXED, or undefined for no selection", () => {
    expect(mergeValues([4, 4])).toBe(4);
    expect(mergeValues([4, 5])).toBe(MIXED);
    expect(mergeValues([])).toBeUndefined();
    expect(mergeValues([{ a: 1 }, { a: 1 }], (x, y) => x.a === y.a)).toEqual({ a: 1 });
  });

  it("turns merged numbers into number field props", () => {
    expect(mixedNumber(8)).toEqual({ value: 8, mixed: false });
    expect(mixedNumber(MIXED)).toEqual({ value: null, mixed: true });
    expect(mixedNumber(Number.NaN)).toEqual({ value: null, mixed: true });
    expect(mixedNumber(undefined)).toEqual({ value: null, mixed: false });
  });
});

describe("sizing modes", () => {
  const base: SizingContext = {
    axis: "width",
    declared: undefined,
    display: "block",
    position: "static",
    flexGrow: 0,
    alignSelf: "auto",
    parent: { display: "block", direction: "row", alignItems: "normal" },
  };
  const row = { display: "flex", direction: "row", alignItems: "normal" };
  const column = { display: "flex", direction: "column", alignItems: "flex-start" };

  it("reads declared sizes", () => {
    expect(readSizingMode({ ...base, declared: "120px" })).toBe("fixed");
    expect(readSizingMode({ ...base, declared: "fit-content" })).toBe("fit");
    expect(readSizingMode({ ...base, declared: "100%" })).toBe("fill");
    expect(readSizingMode({ ...base, declared: "round(50%, 1px)" })).toBe("relative");
    expect(readSizingMode({ ...base, declared: "100%", parent: row })).toBe("relative");
  });

  it("reads auto sizes from the layout context", () => {
    expect(readSizingMode(base)).toBe("fill");
    expect(readSizingMode({ ...base, axis: "height" })).toBe("fit");
    expect(readSizingMode({ ...base, display: "inline-block" })).toBe("fit");
    expect(readSizingMode({ ...base, position: "absolute" })).toBe("fit");
    expect(readSizingMode({ ...base, parent: row })).toBe("fit");
    expect(readSizingMode({ ...base, parent: row, flexGrow: 1, declared: "40px" })).toBe("fill");
    expect(readSizingMode({ ...base, axis: "height", parent: row })).toBe("fill");
    expect(readSizingMode({ ...base, parent: column })).toBe("fit");
    expect(readSizingMode({ ...base, parent: column, alignSelf: "stretch" })).toBe("fill");
  });

  it("writes Fill as flex growth along the parent's main axis, else 100%", () => {
    const input = { axis: "width" as const, size: 80, parentSize: 400, current: "fixed" as const };
    expect(sizingPatch({ ...input, mode: "fill", parent: row })).toEqual({
      "flex-grow": null,
      "flex-basis": null,
      flex: "1 1 0px",
      width: null,
    });
    expect(sizingPatch({ ...input, mode: "fill", parent: column })).toEqual({ width: "100%" });
  });

  it("keeps the current size when switching to Fixed or Relative", () => {
    const input = { axis: "width" as const, size: 80.4, parentSize: 400, parent: row };
    expect(sizingPatch({ ...input, mode: "fixed", current: "fill" })).toEqual({
      flex: null,
      "flex-grow": null,
      "flex-basis": null,
      width: "80px",
      "flex-shrink": "0",
    });
    expect(sizingPatch({ ...input, mode: "relative", current: "fit", parent: null })).toEqual({
      width: "20.1%",
    });
    expect(
      sizingPatch({ ...input, mode: "relative", current: "fit", parent: null, value: 50 }),
    ).toEqual({ width: "50%" });
    expect(sizingPatch({ ...input, axis: "height", mode: "fit", current: "fixed" })).toEqual({
      height: "fit-content",
    });
  });
});

describe("alignment grid", () => {
  it("maps justify-content to the main axis and align-items to the cross axis", () => {
    expect(
      readAlignment({ direction: "row", justifyContent: "center", alignItems: "flex-end" }),
    ).toEqual({ x: "center", y: "end" });
    expect(
      readAlignment({ direction: "column", justifyContent: "flex-end", alignItems: "center" }),
    ).toEqual({ x: "center", y: "end" });
    expect(
      readAlignment({ direction: "row", justifyContent: "normal", alignItems: "stretch" }),
    ).toEqual({ x: "start", y: "start" });
  });

  it("writes a clicked cell for either direction", () => {
    const current = { x: "start", y: "start" } as const;
    expect(alignmentPatch("row", { x: "end", y: "center" }, current)).toEqual({
      "justify-content": "flex-end",
      "align-items": "center",
    });
    expect(alignmentPatch("column", { x: "end", y: "center" }, current)).toEqual({
      "justify-content": "center",
      "align-items": "flex-end",
    });
  });

  it("keeps space-between and only moves the cross axis", () => {
    const spread = readAlignment({
      direction: "row",
      justifyContent: "space-between",
      alignItems: "center",
    });
    expect(spread).toEqual({ x: "spread", y: "center" });
    expect(alignmentPatch("row", { x: "start", y: "end" }, spread)).toEqual({
      "align-items": "flex-end",
    });
    expect(isAlignmentCell(spread, "start", "center")).toBe(true);
    expect(isAlignmentCell(spread, "end", "center")).toBe(true);
    expect(isAlignmentCell(spread, "end", "start")).toBe(false);
  });
});

describe("colors", () => {
  it.each([
    ["#f00", { r: 255, g: 0, b: 0, a: 1 }],
    ["00FF0080", { r: 0, g: 255, b: 0, a: 128 / 255 }],
    ["rgb(1, 2, 3)", { r: 1, g: 2, b: 3, a: 1 }],
    ["rgba(10, 20, 30, 0.5)", { r: 10, g: 20, b: 30, a: 0.5 }],
    ["rgb(10 20 30 / 25%)", { r: 10, g: 20, b: 30, a: 0.25 }],
    ["color(srgb 1 0.5 0 / 0.5)", { r: 255, g: 128, b: 0, a: 0.5 }],
    ["transparent", { r: 0, g: 0, b: 0, a: 0 }],
  ])("parses %s", (text, expected) => {
    const parsed = parseCssColor(text)!;
    expect(parsed.r).toBe(expected.r);
    expect(parsed.g).toBe(expected.g);
    expect(parsed.b).toBe(expected.b);
    expect(parsed.a).toBeCloseTo(expected.a, 3);
  });

  it("leaves named and wide-gamut colors to the browser", () => {
    expect(parseCssColor("rebeccapurple")).toBeNull();
    expect(parseCssColor("oklch(0.7 0.1 200)")).toBeNull();
    expect(parseCssColor("#12345")).toBeNull();
  });

  it("writes hex, with alpha only when translucent", () => {
    expect(formatHex({ r: 255, g: 8, b: 0, a: 0.5 })).toBe("FF0800");
    expect(toCssColor({ r: 255, g: 8, b: 0, a: 1 })).toBe("#FF0800");
    expect(toCssColor({ r: 255, g: 8, b: 0, a: 0.25 })).toBe("#FF080040");
  });
});

describe("shadows", () => {
  it("parses computed (color first) and authored (color last) shadow lists", () => {
    expect(
      parseBoxShadow("rgba(0, 0, 0, 0.25) 0px 4px 12px 0px, rgb(255, 0, 0) 1px 2px 0px 0px inset"),
    ).toEqual([
      { x: 0, y: 4, blur: 12, spread: 0, color: "rgba(0, 0, 0, 0.25)", inset: false },
      { x: 1, y: 2, blur: 0, spread: 0, color: "rgb(255, 0, 0)", inset: true },
    ]);
    expect(parseBoxShadow("2px 3px #000")).toEqual([
      { x: 2, y: 3, blur: 0, spread: 0, color: "#000", inset: false },
    ]);
    expect(parseBoxShadow("none")).toEqual([]);
  });

  it("formats shadows back to CSS", () => {
    expect(
      formatBoxShadow([{ x: 0, y: 4, blur: 12, spread: 0, color: "#00000040", inset: false }]),
    ).toBe("0px 4px 12px 0px #00000040");
    expect(formatBoxShadow([])).toBeNull();
  });
});

describe("fonts", () => {
  it("names the family designs use, without the editor's registration prefix", () => {
    expect(primaryFontFamily('"SynaraCanvas Inter", sans-serif')).toBe("Inter");
    expect(primaryFontFamily("system-ui, -apple-system")).toBe("system-ui");
    expect(primaryFontFamily("'Playfair Display', serif")).toBe("Playfair Display");
  });

  it("quotes picked families and adds a generic fallback", () => {
    expect(fontFamilyValue("Inter", "sans-serif")).toBe('"Inter", sans-serif');
    expect(fontFamilyValue("Fira Code", "monospace")).toBe('"Fira Code", monospace');
    expect(fontFamilyValue("Caveat", "handwriting")).toBe('"Caveat", cursive');
    expect(fontFamilyValue("serif")).toBe("serif");
  });

  it("offers catalog weights, or every hundred inside a variable range", () => {
    expect(fontWeightOptions({ weights: [700, 400], variable: false })).toEqual([400, 700]);
    expect(fontWeightOptions({ weights: [300, 800], variable: true })).toEqual([
      300, 400, 500, 600, 700, 800,
    ]);
    expect(fontWeightOptions(undefined)).toHaveLength(9);
  });

  it("ranks prefix matches before word starts and substrings", () => {
    const families = ["Roboto Mono", "Noto Sans", "Mono Lisa", "Space Mono"].map((family) => ({
      family,
    }));
    expect(searchFamilies(families, "mono", 10).map((item) => item.family)).toEqual([
      "Mono Lisa",
      "Roboto Mono",
      "Space Mono",
    ]);
    expect(searchFamilies(families, "", 2)).toHaveLength(2);
  });
});

describe("borders", () => {
  it("classifies which sides draw a border", () => {
    expect(borderSides({ top: 1, right: 1, bottom: 1, left: 1 })).toBe("all");
    expect(borderSides({ top: 0, right: 0, bottom: 2, left: 0 })).toBe("bottom");
    expect(borderSides({ top: 0, right: 0, bottom: 0, left: 0 })).toBe("none");
    expect(borderSides({ top: 1, right: 2, bottom: 1, left: 1 })).toBe("custom");
  });

  it("moves the width to the chosen side", () => {
    expect(borderWidthPatch("all", 2)).toEqual({
      "border-width": "2px",
      "border-top-width": null,
      "border-right-width": null,
      "border-bottom-width": null,
      "border-left-width": null,
    });
    expect(borderWidthPatch("bottom", 1)).toMatchObject({
      "border-width": "0px",
      "border-bottom-width": "1px",
      "border-top-width": null,
    });
  });
});

describe("typography values", () => {
  it("keeps percent and unitless line heights as stored, else computed px", () => {
    expect(readLineHeight("150%", "24px")).toEqual({ value: 150, unit: "%" });
    expect(readLineHeight("1.4", "22.4px")).toEqual({ value: 1.4, unit: "" });
    expect(readLineHeight("2rem", "32px")).toEqual({ value: 32, unit: "px" });
    expect(readLineHeight(undefined, "normal")).toEqual({ value: null, unit: "px", normal: true });
  });

  it("keeps em letter spacing and reads normal as 0px", () => {
    expect(readLetterSpacing("-0.02em", "-0.32px")).toEqual({ value: -0.02, unit: "em" });
    expect(readLetterSpacing(undefined, "normal")).toEqual({ value: 0, unit: "px" });
    expect(readLetterSpacing("1rem", "16px")).toEqual({ value: 16, unit: "px" });
  });

  it("writes typed values and known keywords only", () => {
    const keywords = { normal: "normal", none: null };
    expect(unitValueText({ kind: "length", value: 1.25, unit: "" }, keywords)).toBe("1.25");
    expect(unitValueText({ kind: "length", value: 120, unit: "%" }, keywords)).toBe("120%");
    expect(unitValueText({ kind: "keyword", keyword: "normal" }, keywords)).toBe("normal");
    expect(unitValueText({ kind: "keyword", keyword: "none" }, keywords)).toBeNull();
    expect(unitValueText({ kind: "keyword", keyword: "fill" }, keywords)).toBeUndefined();
  });
});

describe("alignment grid variants", () => {
  it("reads baseline alignment as the baseline variant and keeps it on a click", () => {
    const baseline = readAlignment({
      direction: "row",
      justifyContent: "center",
      alignItems: "last baseline",
    });
    expect(baseline).toEqual({ x: "center", y: "baseline" });
    expect(isAlignmentCell(baseline, "center", "start")).toBe(true);
    expect(isAlignmentCell(baseline, "start", "start")).toBe(false);
    expect(alignmentPatch("row", { x: "end", y: "start" }, baseline)).toEqual({
      "justify-content": "flex-end",
    });
  });
});

describe("rotation", () => {
  it("reads angles in every unit, from `rotate` and from a transform matrix", () => {
    expect(angleDegrees("0.25turn")).toBe(90);
    expect(angleDegrees("100grad")).toBe(90);
    expect(angleDegrees("0")).toBe(0);
    expect(angleDegrees("12px")).toBeNull();
    expect(rotateDegrees("45deg")).toBe(45);
    expect(rotateDegrees("z 30deg")).toBe(30);
    expect(rotateDegrees("1 0 0 30deg")).toBe(0);
    expect(rotateDegrees("none")).toBe(0);
    expect(transformRotation("matrix(0.707107, 0.707107, -0.707107, 0.707107, 10, 0)")).toBe(45);
    expect(transformRotation("none")).toBe(0);
  });

  it("writes `rotate`, moving a pure rotate() transform there", () => {
    expect(rotationPatch(30, undefined, 0)).toEqual({ rotate: "30deg" });
    expect(rotationPatch(0, undefined, 0)).toEqual({ rotate: null });
    expect(rotationPatch(30, "rotate(10deg)", 10)).toEqual({ transform: null, rotate: "30deg" });
    // Another transform keeps its share of the angle.
    expect(rotationPatch(30, "translateX(4px) rotate(10deg)", 10)).toEqual({ rotate: "20deg" });
    expect(normalizeDegrees(270)).toBe(-90);
    expect(normalizeDegrees(-180)).toBe(180);
  });
});

const insetSpecified = (property: string) =>
  ({ top: "0px", right: "0px", bottom: "0px", left: "0px" })[property] ?? "";

describe("constraints", () => {
  it("reads the pinned edge from the specified insets", () => {
    expect(readPin({ start: "10px", end: "", size: "40px" })).toBe("start");
    expect(readPin({ start: "auto", end: "8px", size: "40px" })).toBe("end");
    expect(readPin({ start: "0px", end: "0px", size: "" })).toBe("stretch");
    expect(readPin({ start: "0px", end: "0px", size: "40px" })).toBe("start");
    expect(readPin({ start: "calc(50% - 20px)", end: "" })).toBe("center");
  });

  it("re-pins without moving the layer", () => {
    const at = { axis: "x" as const, start: 30, end: 50, size: 120, container: 200 };
    expect(pinPatch({ ...at, pin: "end", current: "start" })).toEqual({
      left: null,
      right: "50px",
    });
    expect(pinPatch({ ...at, pin: "center", current: "start" })).toEqual({
      left: "calc(50% - 70px)",
      right: null,
    });
    expect(pinPatch({ ...at, pin: "stretch", current: "start" })).toEqual({
      left: "30px",
      right: "50px",
      width: null,
    });
    // Leaving a stretch fixes the width it had.
    expect(pinPatch({ ...at, axis: "y", pin: "start", current: "stretch" })).toEqual({
      top: "30px",
      bottom: null,
      height: "120px",
    });
  });

  it("moves through the pinned inset, so the pin survives an X or Y edit", () => {
    const at = { axis: "x" as const, start: 30, end: 50, container: 200 };
    expect(pinnedPositionPatch({ ...at, pin: "end", next: 40 })).toEqual({ right: "40px" });
    expect(pinnedPositionPatch({ ...at, pin: "center", next: 100 })).toEqual({ left: "50%" });
    expect(pinnedPositionPatch({ ...at, pin: "stretch", next: 20 })).toEqual({
      left: "20px",
      right: "60px",
    });
    expect(pinnedPositionPatch({ ...at, pin: "start", next: 20 })).toEqual({ left: "20px" });
  });

  it("splits `inset` before one side changes", () => {
    expect(insetExpansion(new Map([["inset", "0"]]), insetSpecified)).toEqual({
      inset: null,
      top: "0px",
      right: "0px",
      bottom: "0px",
      left: "0px",
    });
    expect(insetExpansion(new Map(), insetSpecified)).toEqual({});
  });
});

describe("align and distribute", () => {
  const boxes = [
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 30, y: 20, width: 20, height: 40 },
    { x: 100, y: 5, width: 10, height: 10 },
  ];

  it("lines boxes up on an edge or centre of their bounds", () => {
    expect(alignBoxes(boxes, "left").map((shift) => shift.dx)).toEqual([0, -30, -100]);
    expect(alignBoxes(boxes, "center").map((shift) => shift.dx)).toEqual([50, 15, -50]);
    expect(alignBoxes(boxes, "bottom").map((shift) => shift.dy)).toEqual([50, 0, 45]);
  });

  it("spaces boxes evenly between the first and the last", () => {
    // Span 0..110, sizes 40: gaps of 35.
    expect(distributeBoxes(boxes, "x").map((shift) => shift.dx)).toEqual([0, 15, 0]);
    expect(distributeBoxes(boxes.slice(0, 2), "x")).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
  });
});

describe("fills", () => {
  it("parses the gradients the inspector can write back", () => {
    expect(parseGradient("linear-gradient(in oklab 90deg, #f00 0%, rgb(0, 0, 255) 100%)")).toEqual({
      type: "linear",
      angle: 90,
      direction: null,
      interpolation: "oklab",
      shape: "",
      stops: [
        { color: "#f00", position: 0 },
        { color: "rgb(0, 0, 255)", position: 100 },
      ],
    });
    // Missing positions are filled in as CSS does; a double position becomes two stops.
    expect(parseGradient("linear-gradient(to right, red, white, blue)")).toMatchObject({
      angle: 90,
      direction: "to right",
      stops: [
        { color: "red", position: 0 },
        { color: "white", position: 50 },
        { color: "blue", position: 100 },
      ],
    });
    expect(parseGradient("linear-gradient(red 10% 40%, blue)")?.stops).toEqual([
      { color: "red", position: 10 },
      { color: "red", position: 40 },
      { color: "blue", position: 100 },
    ]);
    expect(parseGradient("radial-gradient(circle at center, red, blue)")).toMatchObject({
      type: "radial",
      shape: "circle at center",
    });
    expect(parseGradient("conic-gradient(from 45deg in oklch, red, blue)")).toMatchObject({
      type: "conic",
      angle: 45,
      interpolation: "oklch",
    });
    // Chrome serializes the interpolation after the angle.
    expect(
      parseGradient("linear-gradient(90deg in oklab, rgb(255, 0, 0) 0%, rgba(0, 0, 255, 0) 100%)"),
    ).toMatchObject({ angle: 90, interpolation: "oklab", direction: null });
    // Repeating gradients, colour hints, px stops and other spaces stay read-only.
    expect(parseGradient("repeating-linear-gradient(red, blue 10%)")).toBeNull();
    expect(parseGradient("linear-gradient(red, 30%, blue)")).toBeNull();
    expect(parseGradient("linear-gradient(red 10px, blue)")).toBeNull();
    expect(parseGradient("linear-gradient(in display-p3, red, blue)")).toBeNull();
  });

  it("writes gradients in their stored form and round-trips them", () => {
    const text = formatGradient(parseGradient("linear-gradient(in oklab 90deg, red, blue)")!);
    expect(text).toBe("linear-gradient(in oklab 90deg, red 0%, blue 100%)");
    expect(formatGradient(parseGradient(text)!)).toBe(text);
    expect(formatGradient(parseGradient("conic-gradient(from 90deg at 50% 50%, red, blue)")!)).toBe(
      "conic-gradient(from 90deg at 50% 50%, red 0%, blue 100%)",
    );
  });

  it("reads a fill stack top first, with the background colour at the bottom", () => {
    const fills = parseFills({
      image:
        'linear-gradient(rgb(255, 0, 0), rgb(255, 0, 0)), linear-gradient(red, blue), url("synara-asset:a1")',
      color: "#FFFFFF",
      blend: "multiply",
      size: "auto, auto, cover",
      position: "0% 0%, 0% 0%, 50% 50%",
      repeat: "repeat, repeat, no-repeat",
    });
    expect(fills.map((fill) => fill.kind)).toEqual(["solid", "gradient", "image", "solid"]);
    expect(fills[0]).toMatchObject({ color: "rgb(255, 0, 0)", blend: "multiply" });
    // A list shorter than the layers repeats, as CSS repeats it.
    expect(fills[2]).toMatchObject({ url: "synara-asset:a1", blend: "multiply" });
    expect(imageFitOf(fills[2]!.layout)).toBe("cover");
    expect(fills[3]).toMatchObject({ kind: "solid", color: "#FFFFFF" });
    expect(parseFills({ image: "none", color: null })).toEqual([]);
  });

  it("writes the stack back as background longhands", () => {
    const layout = { size: "auto", position: "0% 0%", repeat: "repeat" };
    const stack: Fill[] = [
      { kind: "solid", color: "#FF000080", blend: "multiply", layout },
      {
        kind: "image",
        url: "synara-asset:a1",
        blend: "normal",
        layout: { size: "cover", position: "50% 50%", repeat: "no-repeat" },
      },
      { kind: "solid", color: "#FFFFFF", blend: "normal", layout },
    ];
    expect(formatFills(stack)).toEqual({
      background: null,
      "background-image": 'linear-gradient(#FF000080, #FF000080), url("synara-asset:a1")',
      "background-color": "#FFFFFF",
      "background-blend-mode": "multiply, normal",
      "background-size": "auto, cover",
      "background-position": "0% 0%, 50% 50%",
      "background-repeat": "repeat, no-repeat",
    });
    expect(formatFills([])).toMatchObject({ "background-image": null, "background-color": null });
    // A frame's root is white by default: without a fill it is made transparent.
    expect(formatFills([], { frame: true })["background-color"]).toBe("transparent");
    // The written stack parses back to the same fills.
    const patch = formatFills(stack);
    expect(
      parseFills({
        image: patch["background-image"]!,
        color: patch["background-color"]!,
        blend: patch["background-blend-mode"]!,
        size: patch["background-size"]!,
        position: patch["background-position"]!,
        repeat: patch["background-repeat"]!,
      }),
    ).toEqual(stack);
  });

  it("reorders fills and edits gradient stops", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    const stops = [
      { color: "red", position: 0 },
      { color: "blue", position: 90 },
      { color: "white", position: 100 },
    ];
    expect(distributeStops(stops).map((stop) => stop.position)).toEqual([0, 50, 100]);
    expect(addGradientStop(stops)).toEqual([
      { color: "red", position: 0 },
      { color: "red", position: 45 },
      { color: "blue", position: 90 },
      { color: "white", position: 100 },
    ]);
  });
});

describe("shadow lists", () => {
  it("splits outer and inset box shadows and writes inset first", () => {
    const { drop, inner } = splitBoxShadows(
      "rgba(0, 0, 0, 0.2) 0px 4px 8px 0px, rgb(255, 0, 0) 1px 1px 0px 0px inset",
    );
    expect(drop).toHaveLength(1);
    expect(inner).toEqual([
      { x: 1, y: 1, blur: 0, spread: 0, color: "rgb(255, 0, 0)", inset: true },
    ]);
    expect(joinBoxShadows(inner, drop)).toBe(
      "inset 1px 1px 0px 0px rgb(255, 0, 0), 0px 4px 8px 0px rgba(0, 0, 0, 0.2)",
    );
    expect(joinBoxShadows([], [])).toBeNull();
  });

  it("writes text shadows without spread", () => {
    expect(
      formatTextShadow([{ x: 1, y: 2, blur: 3, spread: 9, color: "#000000", inset: false }]),
    ).toBe("1px 2px 3px #000000");
    expect(formatTextShadow([])).toBeNull();
  });
});

describe("filters", () => {
  it("parses filter lists in their units", () => {
    expect(
      parseFilterList(
        "blur(0.5em) brightness(1.2) contrast(80%) hue-rotate(0.5turn) drop-shadow(rgb(0, 0, 0) 0px 4px 8px) url(#x)",
      ),
    ).toEqual([
      { kind: "filter", type: "blur", amount: 0.5, unit: "em" },
      { kind: "filter", type: "brightness", amount: 120, unit: "%" },
      { kind: "filter", type: "contrast", amount: 80, unit: "%" },
      { kind: "filter", type: "hue-rotate", amount: 180, unit: "deg" },
      {
        kind: "drop-shadow",
        shadow: { x: 0, y: 4, blur: 8, spread: 0, color: "rgb(0, 0, 0)", inset: false },
      },
      { kind: "other", value: "url(#x)" },
    ]);
    expect(parseFilterList("none")).toEqual([]);
  });

  it("writes filters and replaces one group in place", () => {
    const current = parseFilterList("blur(4px) drop-shadow(rgb(0, 0, 0) 0px 1px 2px) sepia(1)");
    expect(formatFilterList(current)).toBe(
      "blur(4px) drop-shadow(0px 1px 2px rgb(0, 0, 0)) sepia(100%)",
    );
    const filters = replaceFilterGroup(current, (entry) => !isDropShadowFilter(entry), [
      { kind: "filter", type: "grayscale", amount: 50, unit: "%" },
    ]);
    expect(formatFilterList(filters)).toBe("grayscale(50%) drop-shadow(0px 1px 2px rgb(0, 0, 0))");
    expect(formatFilterList([])).toBeNull();
  });
});

describe("text formatting", () => {
  it("maps the wrap options to text-wrap", () => {
    expect(readTextWrap({ mode: "wrap", style: "balance", whiteSpace: "normal" })).toBe("balance");
    expect(readTextWrap({ mode: "wrap", style: "auto", whiteSpace: "nowrap" })).toBe("none");
    expect(textWrapPatch("pretty", undefined)).toEqual({
      "text-wrap-mode": null,
      "text-wrap-style": null,
      "text-wrap": "pretty",
    });
    expect(textWrapPatch("normal", "nowrap")).toMatchObject({
      "text-wrap": null,
      "white-space": null,
    });
  });

  it("truncates with a line clamp", () => {
    expect(readTruncation({ lineClamp: "3", textOverflow: "clip" })).toBe(3);
    expect(readTruncation({ lineClamp: "none", textOverflow: "ellipsis" })).toBe(1);
    expect(readTruncation({ lineClamp: "none", textOverflow: "clip" })).toBeNull();
    expect(truncationPatch(2)).toMatchObject({
      display: "-webkit-box",
      "-webkit-line-clamp": "2",
      overflow: "hidden",
    });
    expect(truncationPatch(null)["-webkit-line-clamp"]).toBeNull();
  });

  it("aligns text vertically by the box's layout", () => {
    const flexRow = { display: "flex", direction: "row" };
    expect(textVerticalAlignPatch(flexRow, "center")).toEqual({ "align-items": "center" });
    expect(textVerticalAlignPatch({ display: "flex", direction: "column" }, "bottom")).toEqual({
      "justify-content": "flex-end",
    });
    expect(textVerticalAlignPatch({ display: "block", direction: "row" }, "bottom")).toEqual({
      "align-content": "end",
    });
    expect(textVerticalAlignPatch({ display: "block", direction: "row" }, "top")).toEqual({
      "align-content": null,
    });
    const read = (input: Partial<Parameters<typeof readTextVerticalAlign>[0]>) =>
      readTextVerticalAlign({
        display: "block",
        direction: "row",
        alignItems: "normal",
        justifyContent: "normal",
        alignContent: "normal",
        ...input,
      });
    expect(read({ alignContent: "center" })).toBe("center");
    expect(read({ display: "flex", alignItems: "flex-end" })).toBe("bottom");
    expect(read({ display: "flex", direction: "column", justifyContent: "center" })).toBe("center");
    expect(read({})).toBe("top");
  });

  it("reads underline lines and auto lengths", () => {
    expect(readDecorationLine("underline line-through")).toBe("underline");
    expect(readDecorationLine("none")).toBeNull();
    expect(readAutoLength("10%", "1.6px")).toEqual({ value: 10, unit: "%" });
    expect(readAutoLength("", "auto")).toEqual({ value: null, unit: "px", normal: true });
    expect(readAutoLength("2px", "2px")).toEqual({ value: 2, unit: "px" });
  });
});
