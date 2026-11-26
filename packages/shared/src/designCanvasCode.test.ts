import type { DesignFrame, DesignLayer } from "@synara/contracts";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { type CanvasCodeFlavor, canvasNodeToReact } from "./designCanvasCode";

type Frame = Pick<DesignFrame, "width" | "height" | "style" | "layers">;
type Rendered = { tag: string; props: Record<string, unknown>; children: Rendered[] } | string;

const element = (
  id: string,
  tag: string,
  attributes: Record<string, string> = {},
  children: string[] = [],
): DesignLayer => ({ id, type: "element", tag, attributes, children });
const text = (id: string, value: string): DesignLayer => ({ id, type: "text", text: value });

const frameOf = (roots: string[], nodes: DesignLayer[], style?: string): Frame => ({
  width: 400,
  height: 300,
  ...(style !== undefined ? { style } : {}),
  layers: { roots, nodes },
});

const exportCode = (
  frame: Frame,
  layerId: string | null,
  flavor: CanvasCodeFlavor = "css",
  title = "Card",
) => canvasNodeToReact({ frame, layerId, flavor, title, date: new Date(2026, 10, 7) });

function parseErrors(code: string): string[] {
  const file = ts.createSourceFile(
    "Export.tsx",
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  const { parseDiagnostics } = file as unknown as { parseDiagnostics: readonly ts.Diagnostic[] };
  return parseDiagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
}

const h = (tag: string, props: Record<string, unknown> | null, ...children: Rendered[]) => ({
  tag,
  props: props ?? {},
  children,
});

/** Runs the exported component with a JSX factory that records the element tree. */
function render(code: string): Rendered {
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment",
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const exports: { default?: () => Rendered } = {};
  new Function("exports", "h", "Fragment", outputText)(exports, h, "fragment");
  return exports.default!();
}

/** The node at a path of child indexes. */
const at = (node: Rendered, ...path: number[]): Rendered =>
  path.reduce<Rendered>(
    (current, index) => (typeof current === "string" ? current : current.children[index]!),
    node,
  );
const childCount = (node: Rendered) => (typeof node === "string" ? 0 : node.children.length);

describe("canvasNodeToReact", () => {
  it("wraps the JSX in a default-exported component with a dated header", () => {
    expect(exportCode(frameOf(["box"], [element("box", "div")]), "box")).toBe(
      [
        "/**",
        " * From Synara canvas: Card",
        " * Nov 7, 2026",
        " */",
        "export default function () {",
        "  return (",
        "    <div style={{ boxSizing: 'border-box' }} />",
        "  );",
        "}",
      ].join("\n"),
    );
  });

  it("writes sorted camelCase keys, bare unitless numbers and quoted custom properties", () => {
    const code = exportCode(
      frameOf(
        ["box"],
        [
          element("box", "div", {}, ["dot"]),
          element("dot", "span", {
            style:
              "z-index:2;opacity:.5;font-weight:600 !important;line-height:1.4;-webkit-line-clamp:2;--accent:#f00;background-color:#fff;margin:0 auto",
          }),
        ],
      ),
      "box",
    );
    expect(code).toContain(
      "<span style={{ '--accent': '#f00', backgroundColor: '#fff', fontWeight: 600, lineHeight: 1.4, margin: '0 auto', opacity: 0.5, WebkitLineClamp: 2, zIndex: 2 }} />",
    );
  });

  it("keeps the declared cascade when sorting shorthands and longhands", () => {
    const code = exportCode(
      frameOf(
        ["box"],
        [
          element("box", "div", {}, ["panel"]),
          element("panel", "div", { style: "padding-top:4px;padding:8px;inset:0;bottom:auto" }),
        ],
      ),
      "box",
    );
    // React applies keys in order, so `inset` must come before the `bottom` that overrides it.
    expect(code).toContain("<div style={{ inset: '0', bottom: 'auto', padding: '8px' }} />");
  });

  it("makes a copied layer the root: positioning dropped, inherited text styles carried", () => {
    const frame = frameOf(
      ["column"],
      [
        element("column", "div", { style: "display:flex;line-height:20px;gap:8px" }, ["label"]),
        element(
          "label",
          "p",
          { style: "position:absolute;top:8px;left:0;z-index:3;font-size:14px;margin:0" },
          ["copy"],
        ),
        text("copy", "Hi"),
      ],
      "font-family:Inter;color:#111;padding:24px",
    );
    expect(exportCode(frame, "label")).toContain(
      "<p style={{ boxSizing: 'border-box', color: '#111', fontFamily: 'Inter', fontSize: '14px', fontSynthesis: 'none', lineHeight: '20px', margin: '0', MozOsxFontSmoothing: 'grayscale', overflowWrap: 'anywhere', WebkitFontSmoothing: 'antialiased' }}>",
    );
  });

  it("exports the whole frame as a fixed-size div with the frame's own style", () => {
    const frame = frameOf(
      ["box"],
      [element("box", "div")],
      "display:flex;gap:12px;background:#0a0a0a;width:50%",
    );
    expect(exportCode(frame, null)).toContain(
      [
        "    <div style={{ background: '#0a0a0a', boxSizing: 'border-box', display: 'flex', gap: '12px', height: '300px', overflow: 'hidden', position: 'relative', width: '400px' }}>",
        "      <div />",
        "    </div>",
      ].join("\n"),
    );
  });

  it("skips hidden layers and editor-only attributes, and maps attributes to React", () => {
    const frame = frameOf(
      ["form"],
      [
        element("form", "div", {}, ["logo", "secret", "label", "check"]),
        element("logo", "img", {
          class: "logo",
          src: "synara-asset:logo",
          alt: "",
          "data-name": "Logo",
          "data-locked": "true",
        }),
        element("secret", "div", { "data-hidden": "true" }, ["secretText"]),
        text("secretText", "Hidden copy"),
        element("label", "label", { for: "email", tabindex: "0", "aria-label": "Email" }, [
          "labelText",
        ]),
        text("labelText", "Email"),
        element("check", "input", { type: "checkbox", checked: "", value: "yes" }),
      ],
    );
    const code = exportCode(frame, null);
    expect(code).toContain('<img className="logo" src="synara-asset:logo" alt="" />');
    expect(code).toContain('<label htmlFor="email" tabIndex="0" aria-label="Email">');
    expect(code).toContain('<input type="checkbox" defaultChecked defaultValue="yes" />');
    expect(code).not.toMatch(/data-name|data-locked|data-hidden|Hidden copy/);
  });

  it("keeps hostile text and attribute values literal while staying valid TSX", () => {
    const hostile = "  {props.secret} </p>\n<script>alert('x')</script> \\ back \ud800 // */  ";
    const frame = frameOf(
      ["note"],
      [
        element(
          "note",
          "p",
          {
            title: 'say "hi" \\ & {x}\n',
            "aria-label": "</p>",
            "data-x.y": "dropped",
            onclick: "steal()",
            style: "font-family:\"A'B\", serif;content:'*/'",
          },
          ["body"],
        ),
        text("body", hostile),
      ],
    );
    for (const flavor of ["css", "tailwind"] as const) {
      const code = exportCode(frame, "note", flavor, "Evil */ alert(1) /*\nnext");
      expect(parseErrors(code)).toEqual([]);
      const root = render(code);
      if (typeof root === "string") throw new Error("expected an element");
      expect(root.props).toMatchObject({ title: 'say "hi" \\ & {x}\n', "aria-label": "</p>" });
      expect(Object.keys(root.props)).not.toContain("onclick");
      expect(Object.keys(root.props)).not.toContain("data-x.y");
      expect(root.props.style).toMatchObject({ fontFamily: '"A\'B", serif', content: "'*/'" });
      expect(root.children).toEqual([
        "{props.secret} </p> <script>alert('x')</script> \\ back \ud800 // */",
      ]);
    }
  });

  it("collapses whitespace like HTML while keeping the spaces that render", () => {
    const frame = frameOf(
      ["intro", "gap", "line", "code"],
      [
        element("intro", "div", {}, ["introText"]),
        text("introText", "\n  Hello\n   world  \n"),
        text("gap", "\n  "),
        element("line", "p", {}, ["before", "strong", "after"]),
        text("before", "Hello "),
        element("strong", "b", {}, ["strongText"]),
        text("strongText", "world"),
        text("after", "!"),
        element("code", "pre", {}, ["codeText"]),
        text("codeText", "a\n  b"),
      ],
    );
    const root = render(exportCode(frame, null));
    expect(childCount(root)).toBe(3);
    expect(at(root, 0, 0)).toBe("Hello world");
    expect([at(root, 1, 0), at(root, 1, 1, 0), at(root, 1, 2)]).toEqual(["Hello ", "world", "!"]);
    expect(at(root, 2, 0)).toBe("a\n  b");
  });

  it("writes a text with styled spans as one line that renders the same text and spans", () => {
    const frame = frameOf(
      ["p"],
      [
        element("p", "p", { style: "font-size:16px" }, ["t1", "s1", "t2", "s2", "t3"]),
        text("t1", "  Ship "),
        element("s1", "span", { style: "font-weight:700;color:#2f6f4e" }, ["u1"]),
        text("u1", "twice  as fast"),
        text("t2", " & "),
        element("s2", "span", { style: "font-style:italic" }, ["u2"]),
        text("u2", "{safely}"),
        text("t3", " today "),
      ],
    );
    const code = exportCode(frame, "p");
    expect(parseErrors(code)).toEqual([]);
    expect(code).toContain(
      `Ship <span style={{ color: '#2f6f4e', fontWeight: 700 }}>twice as fast</span>{" & "}<span style={{ fontStyle: 'italic' }}>{"{safely}"}</span> today`,
    );
    const rendered = render(code);
    expect(rendered).toMatchObject({ tag: "p" });
    expect(childCount(rendered)).toBe(5);
    expect(at(rendered, 0)).toBe("Ship ");
    expect(at(rendered, 1)).toMatchObject({ tag: "span", children: ["twice as fast"] });
    expect(at(rendered, 2)).toBe(" & ");
    expect(at(rendered, 3)).toMatchObject({ tag: "span", children: ["{safely}"] });
    expect(at(rendered, 4)).toBe(" today");
    // Tailwind classes on the spans, on the same line.
    expect(exportCode(frame, "p", "tailwind")).toContain('Ship <span className="');
  });

  it("converts styles to Tailwind classes in declaration order with an inline fallback", () => {
    const frame = frameOf(
      ["card"],
      [
        element("card", "div", {
          class: "card",
          style:
            'display:flex;flex-direction:column;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;margin:0 auto;width:100%;height:24px;border-radius:8px;background-color:#fff;color:#111;font-size:14px;font-weight:600;line-height:20px;letter-spacing:0.02em;font-family:"Inter", sans-serif;box-shadow:0 1px 2px rgba(0, 0, 0, 0.1);border:1px solid #e5e5e5;opacity:0.5;transform:rotate(4deg)',
        }),
      ],
    );
    const code = exportCode(frame, null, "tailwind");
    expect(parseErrors(code)).toEqual([]);
    expect(code).toContain(
      `<div className="card flex flex-col items-center justify-between gap-[8px] py-[12px] px-[16px] my-0 mx-auto w-full h-[24px] rounded-[8px] bg-[#fff] text-[#111] text-[14px] font-semibold leading-[20px] tracking-[0.02em] font-['Inter',sans-serif] shadow-[0_1px_2px_rgba(0,0,0,0.1)] border-[1px] border-solid border-[#e5e5e5] opacity-[0.5]" style={{ transform: 'rotate(4deg)' }} />`,
    );
    expect(code).toContain(
      `<div className="w-[400px] h-[300px] relative overflow-hidden bg-[#fff] box-border">`,
    );
  });

  it("keeps values Tailwind can't express safely inline, with the longhands after them", () => {
    const frame = frameOf(
      ["box"],
      [
        element("box", "div", {}, ["swatch"]),
        element("swatch", "div", {
          style:
            'font-family:"Odd_Name";background:linear-gradient(red, blue);background-color:#fff;width:24px',
        }),
      ],
    );
    expect(exportCode(frame, "box", "tailwind")).toContain(
      `<div className="w-[24px]" style={{ background: 'linear-gradient(red, blue)', backgroundColor: '#fff', fontFamily: '"Odd_Name"' }} />`,
    );
  });
  it("exports inline SVG with React's attribute names, its title and per-SVG gradient IDs", () => {
    const icon = (prefix: string, color: string): DesignLayer[] => [
      element(`${prefix}svg`, "svg", { viewBox: "0 0 24 24", width: "24", "stroke-width": "2" }, [
        `${prefix}title`,
        `${prefix}space`,
        `${prefix}grad`,
        `${prefix}path`,
      ]),
      element(`${prefix}title`, "title", {}, [`${prefix}label`]),
      text(`${prefix}label`, "Star"),
      text(`${prefix}space`, "  "),
      element(`${prefix}grad`, "linearGradient", { id: "g", gradientUnits: "userSpaceOnUse" }, [
        `${prefix}stop`,
      ]),
      element(`${prefix}stop`, "stop", { offset: "0", "stop-color": color }),
      element(`${prefix}path`, "path", {
        d: "M0 0h24v24z",
        fill: "url(#g)",
        "fill-rule": "evenodd",
      }),
    ];
    const frame = frameOf(
      ["row"],
      [element("row", "div", {}, ["asvg", "bsvg"]), ...icon("a", "#f00"), ...icon("b", "#00f")],
    );
    const code = exportCode(frame, "row");
    expect(parseErrors(code)).toEqual([]);
    const row = render(code);
    const first = at(row, 0);
    const second = at(row, 1);
    if (typeof first === "string" || typeof second === "string") throw new Error("not elements");
    expect(first.tag).toBe("svg");
    expect(first.props).toMatchObject({ viewBox: "0 0 24 24", width: "24", strokeWidth: "2" });
    // Whitespace inside the SVG is not text; the title is.
    expect(first.children.map((child) => (typeof child === "string" ? child : child.tag))).toEqual([
      "title",
      "linearGradient",
      "path",
    ]);
    expect(at(first, 0, 0)).toBe("Star");
    const ids = [first, second].map((svg) => {
      const gradient = at(svg, 1);
      return typeof gradient === "string" ? "" : String(gradient.props.id);
    });
    expect(ids[0]).not.toBe(ids[1]);
    expect(at(first, 1, 0)).toMatchObject({ props: { offset: "0", stopColor: "#f00" } });
    expect(at(second, 2)).toMatchObject({
      props: { d: "M0 0h24v24z", fill: `url(#${ids[1]})`, fillRule: "evenodd" },
    });
    // A shape copied alone keeps its SVG's ID scope.
    expect(exportCode(frame, "apath")).toContain(`fill="url(#${ids[0]})"`);
  });
});
