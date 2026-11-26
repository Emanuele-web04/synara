import {
  DESIGN_CANVAS_MAX_SVG_LAYERS,
  type DesignFrame,
  type DesignFramePutInput,
  type DesignLayer,
  type DesignLayersEditInput,
  type DesignLayerTree,
} from "@synara/contracts";
import {
  applyDesignLayerEdits,
  designLayerSubtree,
  serializeDesignLayers,
  validateDesignLayers,
} from "@synara/shared/designCanvasLayers";
import { designTextBlockKind, designTextRuns } from "@synara/shared/designCanvasText";
import { describe, expect, it } from "vitest";
import { inlineDesignStyles } from "./designCanvasInline";
import { editDesignFrame, putDesignFrame } from "./designCanvasFrames";
import { importDesignLayers, reportSvgPart } from "./designCanvasLayers";

type Element = Extract<DesignLayer, { type: "element" }>;

function inline(html: string, css: string, size = { width: 1440, height: 1024 }) {
  let next = 0;
  const layers = importDesignLayers(html, () => `n${next++}`);
  return inlineDesignStyles({ layers, css, ...size });
}

/** Elements are addressed by a data-k attribute so selectors under test stay untouched. */
function elementOf(layers: DesignLayerTree, key: string): Element {
  const node = layers.nodes.find(
    (item): item is Element => item.type === "element" && item.attributes["data-k"] === key,
  );
  if (!node) throw new Error(`No element with data-k=${key}`);
  return node;
}
const styleOf = (layers: DesignLayerTree, key: string) =>
  elementOf(layers, key).attributes.style ?? "";
/** Effective declarations as a map, for assertions where serialization order is irrelevant. */
const declarationsOf = (layers: DesignLayerTree, key: string) =>
  Object.fromEntries(
    styleOf(layers, key)
      .split(";")
      .filter(Boolean)
      .map((item) => [item.slice(0, item.indexOf(":")), item.slice(item.indexOf(":") + 1)]),
  );

describe("inlineDesignStyles cascade", () => {
  it("orders matches by specificity, then source order, independent of rule position", () => {
    const html =
      '<div data-k="hero" id="hero" class="card big">' +
      '<p data-k="lead" class="lead">Lead</p>' +
      '<p data-k="second">Second</p>' +
      '<span data-k="span">Span</span>' +
      "</div>";
    const { layers } = inline(
      html,
      [
        "#hero{color:red}",
        ".card.big{color:blue}",
        "div{color:green}",
        // (0,1,1) beats (0,0,2) even though it comes first.
        ".card > p{margin:2px}",
        "div p{margin:1px}",
        // :first-child counts as a class: (0,1,1) beats p (0,0,1).
        "p:first-child{font-weight:700}",
        "p{font-weight:400}",
        // :not() takes its argument's specificity: (0,1,1) beats (0,0,2).
        "p:not(.lead){text-align:right}",
        "div p{text-align:left}",
        // :where() contributes nothing: (0,0,1) loses to (0,0,2) despite coming later.
        "div span{opacity:0.5}",
        ":where(.card) span{opacity:1}",
        // Equal specificity: the later rule wins.
        ".lead{letter-spacing:1px}",
        ".lead{letter-spacing:2px}",
      ].join("\n"),
    );
    expect(declarationsOf(layers, "hero")).toEqual({ color: "red" });
    expect(declarationsOf(layers, "lead")).toEqual({
      margin: "2px",
      "font-weight": "700",
      "text-align": "left",
      "letter-spacing": "2px",
    });
    expect(declarationsOf(layers, "second")).toEqual({
      margin: "2px",
      "font-weight": "400",
      "text-align": "right",
    });
    expect(declarationsOf(layers, "span")).toEqual({ opacity: "0.5" });
  });

  it("lets normal inline beat rules, important rules beat normal inline, and important inline win", () => {
    const { layers } = inline(
      '<p data-k="normal" id="a" style="color:black">A</p>' +
        '<p data-k="rule-important" id="b" style="color:black">B</p>' +
        '<p data-k="inline-important" id="c" style="color:black !important">C</p>',
      "#a{color:red} #b{color:red !important} #c{color:red !important}",
    );
    expect(styleOf(layers, "normal")).toBe("color:black");
    expect(styleOf(layers, "rule-important")).toBe("color:red !important");
    expect(styleOf(layers, "inline-important")).toBe("color:black !important");
  });

  it("keeps shorthands and longhands in cascade order so the browser resolves them", () => {
    const { layers } = inline(
      '<div data-k="longhand-wins" class="a"></div><div data-k="shorthand-wins" class="b"></div>',
      "div{margin:0} .a{margin-top:4px} .b{margin:0} div{margin-top:4px}",
    );
    expect(styleOf(layers, "longhand-wins")).toBe("margin:0;margin-top:4px");
    expect(styleOf(layers, "shorthand-wins")).toBe("margin-top:4px;margin:0");
  });

  it("applies html, body and :root rules to the frame instead of any layer", () => {
    const { layers, frameDeclarations } = inline(
      '<main data-k="main"><p data-k="copy">Hi</p></main>',
      ":root{--brand:#123456} html{color-scheme:light} body{background:var(--brand);margin:0} body > main{padding:8px}",
    );
    expect(frameDeclarations).toBe(
      "color-scheme:light;--brand:#123456;background:var(--brand);margin:0",
    );
    // The virtual body is the parent of root layers; nothing on it is copied down.
    expect(styleOf(layers, "main")).toBe("padding:8px");
    expect(styleOf(layers, "copy")).toBe("");
  });

  it("evaluates @media against the frame size and reports queries it cannot evaluate", () => {
    const css =
      "@media (max-width:600px){.a{display:none}} @media screen and (min-width: 1024px){.a{gap:8px}} @media (min-resolution:2dppx){.a{color:red}}";
    const mobile = inline('<div data-k="a" class="a"></div>', css, { width: 390, height: 844 });
    const desktop = inline('<div data-k="a" class="a"></div>', css, { width: 1440, height: 1024 });
    expect(styleOf(mobile.layers, "a")).toBe("display:none");
    expect(styleOf(desktop.layers, "a")).toBe("gap:8px");
    expect(desktop.dropped).toContainEqual(
      expect.stringContaining("@media (min-resolution:2dppx)"),
    );
  });

  it("drops live-browser rules and reports each of them", () => {
    const { layers, dropped } = inline(
      '<a data-k="link" class="link">Go</a>',
      [
        '@import url("https://fonts.example/x.css");',
        "@font-face{font-family:Brand;src:url(synara-asset:brand)}",
        "@keyframes spin{from{opacity:0}to{opacity:1}}",
        ".link{color:navy}",
        ".link:hover{color:red}",
        '.link::before{content:"→"}',
      ].join("\n"),
    );
    expect(styleOf(layers, "link")).toBe("color:navy");
    expect(dropped).toEqual(
      expect.arrayContaining([
        expect.stringContaining("@import"),
        expect.stringContaining("@font-face"),
        expect.stringContaining("@keyframes"),
        expect.stringMatching(/"\.link:hover".*interactive states/),
        expect.stringMatching(/"\.link::before".*pseudo-elements/),
      ]),
    );
  });

  it("drops external url() values and keeps work assets and inline image data", () => {
    const pixel = "data:image/png;base64,iVBORw0KGgo=";
    const { layers, dropped } = inline(
      '<div data-k="external" class="external"></div><div data-k="asset" class="asset"></div><div data-k="data" class="data"></div>',
      `.external{background-image:url(https://cdn.example/hero.png);color:red}
       .asset{background:url("synara-asset:x") center/cover}
       .data{background-image:url(${pixel})}`,
    );
    expect(styleOf(layers, "external")).toBe("color:red");
    expect(styleOf(layers, "asset")).toBe('background:url("synara-asset:x") center/cover');
    expect(styleOf(layers, "data")).toBe(`background-image:url(${pixel})`);
    expect(dropped).toContainEqual(
      expect.stringMatching(/background-image in "\.external".*external resource/),
    );
  });

  it("converts rem to px using the stylesheet's html font-size", () => {
    const html = '<div data-k="box" class="box" style="margin:.5rem"></div>';
    const scaled = inline(html, "html{font-size:62.5%} .box{padding:1.6rem 2rem}");
    expect(styleOf(scaled.layers, "box")).toBe("padding:16px 20px;margin:5px");
    expect(scaled.frameDeclarations).toBe("font-size:62.5%");
    const fallback = inline(html, ".box{padding:1rem}");
    expect(styleOf(fallback.layers, "box")).toBe("padding:16px;margin:8px");
  });
});

const putInput = (overrides: Partial<DesignFramePutInput> = {}): DesignFramePutInput => ({
  id: "home",
  title: "Home",
  html: '<main data-k="main"><h1 data-k="title" class="title">Hello</h1><section data-k="cards"><div data-k="card"><p data-k="card-copy">Card</p></div></section></main><style>.title{color:green}</style>',
  css: "body{background:#fafafa} main{display:flex}",
  width: 390,
  height: 844,
  expectedRevision: 0,
  ...overrides,
});
const textId = (frame: DesignFrame, text: string) =>
  frame.layers.nodes.find((node) => node.type === "text" && node.text === text)!.id;

describe("putDesignFrame", () => {
  it("creates frames from HTML plus stylesheets and places new ones to the right", () => {
    const { frame, dropped } = putDesignFrame([], putInput({ style: "padding:24px" }));
    expect(dropped).toEqual([]);
    expect(frame).toMatchObject({
      id: "home",
      revision: 1,
      x: 0,
      y: 0,
      width: 390,
      height: 844,
      style: "background:#fafafa;padding:24px",
      lastLayerEdit: { mutationId: "put_1", createdNodeIds: [] },
    });
    // <style> blocks are inlined, never stored as layers.
    expect(frame.layers.nodes.some((node) => node.type === "element" && node.tag === "style")).toBe(
      false,
    );
    expect(styleOf(frame.layers, "title")).toBe("color:green");
    expect(styleOf(frame.layers, "main")).toBe("display:flex");
    const second = putDesignFrame([frame], putInput({ id: "detail" })).frame;
    expect(second.x).toBe(390 + 80);
  });

  it("returns the stored frame for an identical retry and refuses stale revisions", () => {
    const created = putDesignFrame([], putInput()).frame;
    expect(putDesignFrame([created], putInput())).toEqual({ frame: created, dropped: [] });
    expect(() => putDesignFrame([created], putInput({ html: "<p>Different</p>" }))).toThrow(
      "revision conflict",
    );
    expect(() => putDesignFrame([], putInput({ expectedRevision: 1 }))).toThrow(
      "revision conflict",
    );
    const replaced = putDesignFrame(
      [created],
      putInput({ html: "<p>Replaced</p>", expectedRevision: 1, x: 999, y: 999 }),
    ).frame;
    expect(replaced).toMatchObject({ revision: 2, x: created.x, y: created.y });
    expect(replaced.lastLayerEdit?.mutationId).toBe("put_2");
  });

  it("refuses frames over the inline-styled size limit and pages over the frame limit", () => {
    expect(() =>
      putDesignFrame(
        [],
        putInput({
          html: "<div></div>".repeat(2000),
          css: `div{background:#123456;border:1px solid #abcdef;box-shadow:0 0 0 1px #fedcba;padding:12px 16px}`,
        }),
      ),
    ).toThrow("KiB of inline-styled HTML");
    const one = putDesignFrame([], putInput()).frame;
    const full = Array.from({ length: 48 }, (_, index) => ({ ...one, id: `f${index}` }));
    expect(() => putDesignFrame(full, putInput({ id: "extra" }))).toThrow("48-view limit");
  });
});

describe("editDesignFrame", () => {
  const created = () => putDesignFrame([], putInput()).frame;

  it("merges editor edits without expectedRevision onto the latest revision", () => {
    const base = created();
    const agent = editDesignFrame(base, {
      frameId: "home",
      expectedRevision: 1,
      mutationId: "agent-1",
      operations: [{ type: "set_text", nodeId: textId(base, "Hello"), text: "Agent title" }],
    }).frame;
    const editor = editDesignFrame(agent, {
      frameId: "home",
      mutationId: "editor-1",
      operations: [
        { type: "set_styles", nodeId: elementOf(base.layers, "card").id, styles: { gap: "4px" } },
      ],
    }).frame;
    expect(editor.revision).toBe(3);
    expect(textId(editor, "Agent title")).toBe(textId(base, "Hello"));
    expect(styleOf(editor.layers, "card")).toBe("gap:4px");
    expect(() =>
      editDesignFrame(editor, {
        frameId: "home",
        expectedRevision: 2,
        mutationId: "agent-2",
        operations: [{ type: "set_text", nodeId: textId(base, "Card"), text: "late" }],
      }),
    ).toThrow("revision conflict");
  });

  it("replays a repeated mutationId and refuses its reuse for a different edit", () => {
    const base = created();
    const input = {
      frameId: "home",
      expectedRevision: 1,
      mutationId: "m1",
      operations: [{ type: "insert_html" as const, parentId: null, html: "<p>New</p>" }],
    };
    const first = editDesignFrame(base, input);
    expect(first.createdNodeIds).toHaveLength(2);
    const retry = editDesignFrame(first.frame, input);
    expect(retry.frame).toBe(first.frame);
    expect(retry.createdNodeIds).toEqual(first.createdNodeIds);
    expect(() =>
      editDesignFrame(first.frame, {
        ...input,
        operations: [{ type: "insert_html", parentId: null, html: "<p>Other</p>" }],
      }),
    ).toThrow("Mutation ID was already used");
  });

  it("restores a deleted subtree with its original IDs through insert_layers", () => {
    const base = created();
    const cards = elementOf(base.layers, "cards");
    const card = elementOf(base.layers, "card");
    const subtreeIds = new Set([card.id, ...card.children]);
    for (const child of card.children) {
      const node = base.layers.nodes.find((item) => item.id === child)!;
      if (node.type === "element") node.children.forEach((id) => subtreeIds.add(id));
    }
    const removed = editDesignFrame(base, {
      frameId: "home",
      mutationId: "delete-card",
      operations: [{ type: "delete", nodeId: card.id }],
    }).frame;
    expect(removed.layers.nodes.some((node) => subtreeIds.has(node.id))).toBe(false);
    const subtree = {
      roots: [card.id],
      nodes: base.layers.nodes.filter((node) => subtreeIds.has(node.id)),
    };
    const restored = editDesignFrame(removed, {
      frameId: "home",
      mutationId: "undo-delete",
      operations: [{ type: "insert_layers", parentId: cards.id, layers: subtree }],
    });
    expect(restored.createdNodeIds.toSorted()).toEqual([...subtreeIds].toSorted());
    expect(restored.frame.layers.nodes.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
      base.layers.nodes.toSorted((a, b) => a.id.localeCompare(b.id)),
    );
    expect(restored.frame.layers.roots).toEqual(base.layers.roots);
    expect(() =>
      editDesignFrame(restored.frame, {
        frameId: "home",
        mutationId: "insert-again",
        operations: [{ type: "insert_layers", parentId: null, layers: subtree }],
      }),
    ).toThrow("Layer ID already exists");
  });

  it("patches frame styles, inlines inserted CSS and reports ignored frame rules", () => {
    const base = created();
    const styled = editDesignFrame(base, {
      frameId: "home",
      mutationId: "frame-style",
      operations: [
        { type: "set_frame_styles", styles: { background: null, padding: "2rem" } },
        {
          type: "insert_html",
          parentId: null,
          html: '<p data-k="inserted" class="x">Hi</p>',
          css: ".x{color:red} .x:hover{color:blue} body{margin:0}",
        },
      ],
    });
    expect(styled.frame.style).toBe("padding:32px");
    expect(styleOf(styled.frame.layers, "inserted")).toBe("color:red");
    expect(styled.dropped).toEqual(
      expect.arrayContaining([
        expect.stringContaining("interactive states"),
        "Ignored html/body/:root rules in inserted HTML; use set_frame_styles",
      ]),
    );
    const cleared = editDesignFrame(styled.frame, {
      frameId: "home",
      mutationId: "frame-style-clear",
      operations: [{ type: "set_frame_styles", styles: { padding: null } }],
    }).frame;
    expect(cleared.style).toBeUndefined();
  });

  it("stores every declaration the inspector's sections write, unchanged", () => {
    // One value per control: rotation, constraints, fill stacks, underline, outline, text
    // stroke, shadows, filters, text formatting, flex and a wide-gamut colour.
    const styles: Record<string, string> = {
      rotate: "45deg",
      left: "calc(50% - 20px)",
      right: "110px",
      "background-image":
        'linear-gradient(in oklab 90deg, #FF0000 0%, #0000FF00 100%), radial-gradient(circle at center, #FFFFFF 0%, #000000 100%), conic-gradient(from 90deg at 50% 50%, #FF0000 0%, #00FF00 100%), url("synara-asset:a1")',
      "background-blend-mode": "multiply, normal, screen, normal",
      "background-size": "auto, auto, auto, cover",
      "background-position": "0% 0%, 0% 0%, 0% 0%, 50% 50%",
      "background-repeat": "repeat, repeat, repeat, no-repeat",
      "background-color": "transparent",
      "text-decoration-line": "underline",
      "text-decoration-style": "wavy",
      "text-decoration-color": "#FF0000",
      "text-decoration-thickness": "2px",
      "text-underline-offset": "10%",
      "text-decoration-skip-ink": "none",
      "outline-style": "dashed",
      "outline-width": "2px",
      "outline-color": "#333333",
      "outline-offset": "4px",
      "-webkit-text-stroke-width": "1px",
      "-webkit-text-stroke-color": "#000000",
      "paint-order": "stroke fill",
      "box-shadow": "inset 0px 4px 12px 0px #00000040, 0px 1px 2px 0px #000000",
      "text-shadow": "1px 2px 3px #000000",
      filter: "blur(4px) grayscale(50%) drop-shadow(0px 4px 12px #00000040)",
      "backdrop-filter": "blur(4px) saturate(150%)",
      "text-wrap": "balance",
      "word-break": "keep-all",
      display: "-webkit-box",
      "-webkit-box-orient": "vertical",
      "-webkit-line-clamp": "2",
      "text-overflow": "ellipsis",
      "align-content": "end",
      "font-style": "italic",
      "align-items": "last baseline",
      "row-gap": "12px",
      color: "oklch(0.7 0.35 150)",
    };
    const base = created();
    const card = elementOf(base.layers, "card").id;
    // Editor edits are strict: a value the sanitizer refused would refuse the whole batch.
    const edited = editDesignFrame(base, {
      frameId: "home",
      mutationId: "inspector-sections",
      operations: [
        { type: "set_styles", nodeId: card, styles },
        {
          type: "set_frame_styles",
          styles: { "background-color": "transparent", filter: "sepia(100%)" },
        },
      ],
    });
    expect(edited.dropped).toEqual([]);
    expect(declarationsOf(edited.frame.layers, "card")).toEqual(styles);
    expect(edited.frame.style).toContain("filter:sepia(100%)");
    // Prefixed names beyond the inspector's few stay refused, and app-region is never kept.
    for (const styles of [
      { "-webkit-app-region": "drag" },
      { "-webkit-user-modify": "read-write" },
    ])
      expect(() =>
        editDesignFrame(base, {
          frameId: "home",
          mutationId: `prefixed-${Object.keys(styles)[0]}`,
          operations: [{ type: "set_styles", nodeId: card, styles }],
        }),
      ).toThrow(/Invalid CSS property/);
    const imported = inline(
      '<div data-k="drag" style="-webkit-app-region:drag;app-region:drag;color:red"></div>',
      "",
    );
    expect(declarationsOf(imported.layers, "drag")).toEqual({ color: "red" });
    // The guard against external resources still holds inside a fill stack.
    expect(() =>
      editDesignFrame(base, {
        frameId: "home",
        mutationId: "inspector-sections-external",
        operations: [
          {
            type: "set_styles",
            nodeId: card,
            styles: {
              "background-image": "linear-gradient(red, blue), url(https://tracker.example/x.png)",
            },
          },
        ],
      }),
    ).toThrow(/Unsupported CSS/);
  });

  it("refuses unsafe style values in every write path and leaves the frame unchanged", () => {
    const base = created();
    const card = elementOf(base.layers, "card");
    const unsafe = "url(https://tracker.example/pixel.png)";
    for (const operation of [
      { type: "set_styles" as const, nodeId: card.id, styles: { background: unsafe } },
      { type: "set_frame_styles" as const, styles: { "background-image": unsafe } },
      { type: "set_styles" as const, nodeId: card.id, styles: { behavior: "url(x.htc)" } },
      {
        type: "insert_layers" as const,
        parentId: null,
        layers: {
          roots: ["evil"],
          nodes: [
            {
              id: "evil",
              type: "element" as const,
              tag: "div",
              attributes: { style: `background:${unsafe}` },
              children: [],
            },
          ],
        },
      },
    ]) {
      expect(() =>
        editDesignFrame(base, { frameId: "home", mutationId: "unsafe", operations: [operation] }),
      ).toThrow(/Unsupported CSS/);
    }
    expect(base.revision).toBe(1);
  });

  it("refuses an edit that grows the frame past its size limit", () => {
    const base = created();
    expect(() =>
      editDesignFrame(base, {
        frameId: "home",
        mutationId: "huge",
        operations: [{ type: "set_text", nodeId: textId(base, "Card"), text: "x".repeat(200_000) }],
      }),
    ).toThrow("KiB of inline-styled HTML");
  });
});

const nodesOf = (frame: DesignFrame) => new Map(frame.layers.nodes.map((node) => [node.id, node]));

describe("styled text ranges", () => {
  const rich = () =>
    editDesignFrame(putDesignFrame([], putInput()).frame, {
      frameId: "home",
      mutationId: "rich",
      operations: [
        {
          type: "insert_html",
          parentId: null,
          html: '<p data-k="pitch">Ship <span style="font-weight:700;color:#2f6f4e">twice as fast</span> today</p>',
        },
      ],
    }).frame;

  it("stores a span from insert_html as an ordinary inline layer of a rich text block", () => {
    const frame = rich();
    const pitch = elementOf(frame.layers, "pitch");
    expect(designTextBlockKind(nodesOf(frame), pitch.id)).toBe("rich");
    expect(
      designTextRuns(nodesOf(frame), pitch.id).map(({ text, style }) => [text, style]),
    ).toEqual([
      ["Ship ", ""],
      ["twice as fast", "font-weight:700;color:#2f6f4e"],
      [" today", ""],
    ]);
    expect(serializeDesignLayers(designLayerSubtree(frame.layers, pitch.id), false)).toBe(
      '<p data-k="pitch">Ship <span style="font-weight:700;color:#2f6f4e">twice as fast</span> today</p>',
    );
  });

  it("sanitizes spans like any layer: the editor refuses, agents drop and report", () => {
    const frame = rich();
    const pitch = elementOf(frame.layers, "pitch");
    const span = {
      id: "evil",
      type: "element" as const,
      tag: "span",
      attributes: { style: "color:red;background:url(https://tracker.example/x.png)" },
      children: ["evil-text"],
    };
    const layers = {
      roots: ["evil"],
      nodes: [span, { id: "evil-text", type: "text" as const, text: "x" }],
    };
    expect(() =>
      editDesignFrame(frame, {
        frameId: "home",
        mutationId: "evil",
        operations: [{ type: "insert_layers", parentId: pitch.id, layers }],
      }),
    ).toThrow(/Unsupported CSS/);
    const agent = editDesignFrame(
      frame,
      {
        frameId: "home",
        mutationId: "evil-agent",
        operations: [
          {
            type: "insert_html",
            parentId: pitch.id,
            html: '<span style="color:red;background:url(https://tracker.example/x.png)">x</span>',
          },
        ],
      },
      { agent: true },
    );
    expect(agent.dropped).toContainEqual(expect.stringContaining("background"));
    expect(JSON.stringify(agent.frame.layers)).not.toContain("tracker.example");
  });

  it("set_text on a text block writes one plain text and replays to the stored tree", () => {
    const frame = rich();
    const pitch = elementOf(frame.layers, "pitch");
    const input = {
      frameId: "home",
      mutationId: "plain",
      operations: [{ type: "set_text" as const, nodeId: pitch.id, text: "Ship today" }],
    };
    const agent = editDesignFrame(frame, input, { agent: true });
    expect(agent.dropped).toEqual([
      `set_text on text block ${pitch.id} (operations[0]) removed 1 styled span; the block is plain text now`,
    ]);
    const plain = elementOf(agent.frame.layers, "pitch");
    expect(plain.children).toEqual([pitch.children[0]]);
    expect(designTextRuns(nodesOf(agent.frame), pitch.id)).toEqual([
      { text: "Ship today", style: "" },
    ]);
    // Clients replay the applied edits to exactly the stored layers.
    expect(applyDesignLayerEdits(frame.layers, agent.applied!)).toEqual(agent.frame.layers);
    // The editor's strict path accepts it too, without a report.
    expect(editDesignFrame(frame, input).dropped).toEqual([]);
    // An empty text block gets a text layer; an element holding other layers is refused.
    const empty = editDesignFrame(agent.frame, {
      frameId: "home",
      mutationId: "empty",
      operations: [{ type: "insert_html", parentId: null, html: '<h2 data-k="empty"></h2>' }],
    }).frame;
    const filled = editDesignFrame(empty, {
      frameId: "home",
      mutationId: "fill",
      operations: [{ type: "set_text", nodeId: elementOf(empty.layers, "empty").id, text: "Hi" }],
    });
    expect(designTextRuns(nodesOf(filled.frame), elementOf(empty.layers, "empty").id)).toEqual([
      { text: "Hi", style: "" },
    ]);
    expect(filled.createdNodeIds).toHaveLength(1);
    expect(() =>
      editDesignFrame(frame, {
        frameId: "home",
        mutationId: "card",
        operations: [{ type: "set_text", nodeId: elementOf(frame.layers, "cards").id, text: "x" }],
      }),
    ).toThrow("set_text requires a text-layer ID, or the ID of an element");
  });

  it("counts spans toward the frame's layer and size limits", () => {
    const frame = rich();
    const pitch = elementOf(frame.layers, "pitch");
    const many = Array.from(
      { length: 1600 },
      (_, index) => `<span style="color:red">${index}</span>`,
    );
    expect(() =>
      editDesignFrame(frame, {
        frameId: "home",
        mutationId: "many",
        operations: [{ type: "insert_html", parentId: pitch.id, html: many.join("") }],
      }),
    ).toThrow("3,000-layer limit");
    const long = `<span style="font-family:${"x".repeat(1000)}">y</span>`.repeat(220);
    expect(() =>
      editDesignFrame(frame, {
        frameId: "home",
        mutationId: "long",
        operations: [{ type: "insert_html", parentId: pitch.id, html: long }],
      }),
    ).toThrow("KiB of inline-styled HTML");
  });
});

const svgTags = (layers: DesignLayerTree) =>
  layers.nodes.flatMap((node) => (node.type === "element" ? [node.tag] : []));
const layer = (node: DesignLayer) => ({ roots: [node.id], nodes: [node] });

describe("inline SVG subset", () => {
  const ICON =
    '<svg viewBox="0 0 24 24" width="24" height="24" preserveAspectRatio="xMidYMid meet" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-label="Search">' +
    "<title>Search</title>" +
    '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" gradientTransform="rotate(45)" x1="0" y1="0" x2="24" y2="24" spreadMethod="pad"><stop offset="0%" stop-color="#ff0000" stop-opacity=".5"/><stop offset="1" stop-color="currentColor"/></linearGradient>' +
    '<radialGradient id="r" href="#g" cx="50%" cy="50%" r="50%" fx="40%" fy="40%"/>' +
    '<clipPath id="c" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="1" height="1" rx="0.2"/></clipPath>' +
    '<mask id="m" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><circle cx="12" cy="12" r="10" fill="#fff"/></mask></defs>' +
    '<g clip-path="url(#c)" mask="url(#m)" transform="translate(1 1) scale(0.9)" opacity="0.8">' +
    '<path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35" fill="url(#g) #000" fill-rule="evenodd" vector-effect="non-scaling-stroke"/>' +
    '<ellipse cx="12" cy="12" rx="3" ry="2" stroke-dasharray="2 1" stroke-dashoffset="1"/>' +
    '<line x1="0" y1="0" x2="4" y2="4" stroke-linejoin="round" stroke-miterlimit="4"/>' +
    '<polyline points="1,2 3,4 5,6"/><polygon points="0 0 4 0 2 3" fill="url(\'#r\')"/>' +
    "</g></svg>";
  let next = 0;
  const ids = () => `s${next++}`;
  const strict = (html: string) => importDesignLayers(html, ids);
  const agent = (html: string) => {
    const reports: string[] = [];
    const layers = importDesignLayers(html, ids, undefined, [], reportSvgPart(reports));
    return { layers, reports };
  };
  const stored = (layers: DesignLayerTree) => serializeDesignLayers(layers, false);

  it("stores the allowed subset as written, case-sensitive names included", () => {
    const layers = strict(`<button>${ICON} Find</button>`);
    expect(svgTags(layers)).toEqual([
      "button",
      "svg",
      "title",
      "defs",
      "linearGradient",
      "stop",
      "stop",
      "radialGradient",
      "clipPath",
      "rect",
      "mask",
      "circle",
      "g",
      "path",
      "ellipse",
      "line",
      "polyline",
      "polygon",
    ]);
    const svg = layers.nodes.find(
      (node): node is Element => node.type === "element" && node.tag === "svg",
    )!;
    expect(svg.attributes).toEqual({
      viewBox: "0 0 24 24",
      width: "24",
      height: "24",
      preserveAspectRatio: "xMidYMid meet",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "aria-label": "Search",
    });
    const gradient = layers.nodes.find(
      (node): node is Element => node.type === "element" && node.tag === "linearGradient",
    )!;
    expect(gradient.attributes).toMatchObject({
      id: "g",
      gradientUnits: "userSpaceOnUse",
      gradientTransform: "rotate(45)",
      spreadMethod: "pad",
    });
    // Whitespace between shapes is not kept; the title's text is.
    expect(
      layers.nodes
        .filter((node) => node.type === "text")
        .map((node) => node.type === "text" && node.text),
    ).toEqual(["Search", " Find"]);
    // The model round-trips through the HTML parser unchanged (the nesting check).
    const reparsed = strict(stored(layers));
    expect(stored(reparsed)).toBe(stored(layers));
    expect(stored(layers)).toContain("fill=\"url('#r')\"");
  });

  it("refuses every construct outside the subset in the editor, naming it", () => {
    const refused: Array<[html: string, reason: RegExp]> = [
      ["<svg><script>alert(1)</script></svg>", /<script>.*scripts never run/],
      ["<svg><foreignObject><div>x</div></foreignObject></svg>", /<foreignObject>.*embed HTML/],
      ["<svg><style>path{fill:red}</style></svg>", /<style>.*stylesheets/],
      ['<svg><use href="#a"/></svg>', /<use>/],
      ['<svg><use href="https://evil.example/s.svg#a"/></svg>', /<use>/],
      ['<svg><image href="https://evil.example/x.png"/></svg>', /<image>/],
      ['<svg><a href="https://evil.example"><path d="M0 0"/></a></svg>', /<a>.*links/],
      ['<svg><animate attributeName="x" to="5"/></svg>', /<animate>.*static/],
      ['<svg><animateTransform attributeName="transform"/></svg>', /<animateTransform>/],
      ['<svg><set attributeName="fill" to="red"/></svg>', /<set>.*static/],
      ['<svg><iframe src="https://evil.example"></iframe></svg>', /<iframe>/],
      ['<svg><filter id="f"><feImage href="https://evil.example/x"/></filter></svg>', /<filter>/],
      ["<svg><text>Hi</text></svg>", /<text>/],
      ['<svg onload="alert(1)"></svg>', /onload on <svg>.*event handlers/],
      ['<svg><path onclick="x()" d="M0 0"/></svg>', /onclick on <path>/],
      [
        '<svg><linearGradient href="https://evil.example/g.svg#g"/></svg>',
        /href on <linearGradient>/,
      ],
      ['<svg><path href="#a" d="M0 0"/></svg>', /href on <path>/],
      [
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><linearGradient xlink:href="https://evil.example/#g"/></svg>',
        /href on <linearGradient>/,
      ],
      ['<svg><path xlink:title="x" d="M0 0"/></svg>', /xlink:title on <path>.*namespace/],
      ['<svg><path fill="url(https://evil.example/p.svg#a)"/></svg>', /fill on <path>.*own SVG/],
      ['<svg><path fill="url(other.svg#a)"/></svg>', /fill on <path>/],
      ['<svg><g clip-path="url(https://evil.example/#c)"/></svg>', /clip-path on <g>/],
      ['<svg><g mask="url(data:image/svg+xml,x)"/></svg>', /mask on <g>/],
      ['<svg><path fill="var(--brand)"/></svg>', /fill on <path>.*var\(\)/],
      ['<svg><path stroke="expression(alert(1))"/></svg>', /stroke on <path>/],
      ['<svg><path fill="red;background:url(x)"/></svg>', /fill on <path>/],
      ['<svg><rect width="50vw"/></svg>', /width on <rect>/],
      ['<svg><rect width="2rem"/></svg>', /width on <rect>/],
      ['<svg><path d="M0 0 url(x)"/></svg>', /d on <path>.*path data/],
      ['<svg><g transform="translate(1px) url(x)"/></svg>', /transform on <g>/],
      ['<svg><g filter="url(#f)"/></svg>', /filter on <g>/],
      ['<svg xml:base="https://evil.example/"></svg>', /xml:base on <svg>.*namespace/],
      ['<svg xml:space="preserve"></svg>', /xml:space on <svg>/],
      ['<svg xmlns="http://www.w3.org/1999/xhtml"></svg>', /xmlns on <svg>/],
      ['<svg xmlns:html="http://www.w3.org/1999/xhtml"></svg>', /xmlns:html on <svg>/],
      ['<svg><path inkscape:label="x" d="M0 0"/></svg>', /inkscape:label on <path>/],
      ['<svg><path id="a.b" d="M0 0"/></svg>', /id on <path>.*identifier/],
      ['<svg><path data-synara-layer-id="forged" d="M0 0"/></svg>', /data-synara-layer-id/],
      ["<svg><title>a<b>b</b></title></svg>", /<b>.*markup/],
      [
        '<!DOCTYPE svg [<!ENTITY ext SYSTEM "file:///etc/passwd">]><svg><title>&ext;</title></svg>',
        /<!DOCTYPE>.*entity/,
      ],
    ];
    for (const [html, reason] of refused) expect(() => strict(html), html).toThrow(reason);
    // The HTML parser ends the SVG at an <embed>; as HTML it is dropped like any unknown tag.
    expect(stored(strict('<svg><embed src="https://evil.example/x.swf"/></svg>'))).toBe(
      "<svg></svg>",
    );
  });

  it("drops and reports the same constructs for agents, and never stores them", () => {
    const { layers, reports } = agent(
      '<!DOCTYPE svg [<!ENTITY ext SYSTEM "file:///etc/passwd">]>' +
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" focusable="false" viewBox="0 0 8 8" onload="alert(1)">' +
        "<script>alert(1)</script><foreignObject><div>x</div></foreignObject>" +
        '<use xlink:href="https://evil.example/s.svg#a"/><image href="x.png"/><style>*{}</style>' +
        '<linearGradient id="g" xlink:href="#h"/><linearGradient id="h"/>' +
        '<path d="M0 0h8v8z" fill="url(https://evil.example/#g)" stroke="url(#g)"/>' +
        "<title>&ext;</title></svg>",
    );
    expect(reports).toEqual([
      "Dropped <!DOCTYPE> in an SVG: XML entity declarations are not supported",
      "Dropped onload on <svg> in an SVG: event handlers never run on the canvas",
      "Dropped <script> in an SVG: scripts never run on the canvas",
      "Dropped <foreignObject> in an SVG: it would embed HTML inside the SVG",
      "Dropped <use> in an SVG: references to other content are not supported",
      "Dropped <image> in an SVG: images inside an SVG are not supported; use an img layer with a canvas asset",
      "Dropped <style> in an SVG: SVG stylesheets are not supported; use presentation attributes or inline styles",
      "Dropped fill on <path> in an SVG: may only reference an element of its own SVG",
    ]);
    const html = stored(layers);
    for (const forbidden of [
      "script",
      "alert",
      "foreignObject",
      "evil.example",
      "<use",
      "<image",
      "<style",
      "onload",
      "xmlns",
      "version",
      "focusable",
    ])
      expect(html, forbidden).not.toContain(forbidden);
    // The same-SVG references stay, xlink:href as plain href; the entity is never expanded.
    expect(html).toContain('<linearGradient id="g" href="#h">');
    expect(html).toContain('stroke="url(#g)"');
    expect(html).toContain("<title>&amp;ext;</title>");
  });

  it("follows the agent rule in edits and puts, and the strict rule in editor edits", () => {
    const base = putDesignFrame([], putInput()).frame;
    const insert = (agentEdit: boolean) =>
      editDesignFrame(
        base,
        {
          frameId: "home",
          mutationId: `svg-${agentEdit}`,
          operations: [
            {
              type: "insert_html",
              parentId: null,
              html: '<svg viewBox="0 0 4 4"><path d="M0 0h4v4z" onclick="x()"/></svg>',
            },
          ],
        },
        { agent: agentEdit },
      );
    expect(() => insert(false)).toThrow(/Unsupported SVG: onclick on <path>/);
    const applied = insert(true);
    expect(applied.dropped).toEqual([
      "Dropped onclick on <path> in an SVG: event handlers never run on the canvas",
    ]);
    expect(applied.frame.lastLayerEdit?.dropped).toEqual(applied.dropped);
    expect(serializeDesignLayers(applied.frame.layers, false)).toContain(
      '<svg viewBox="0 0 4 4"><path d="M0 0h4v4z"></path></svg>',
    );
    const put = putDesignFrame(
      [],
      putInput({
        html: '<svg viewBox="0 0 4 4"><script>x</script><rect width="4" height="4"/></svg>',
      }),
    );
    expect(put.dropped).toEqual(["Dropped <script> in an SVG: scripts never run on the canvas"]);
    expect(serializeDesignLayers(put.frame.layers, false)).toBe(
      '<svg viewBox="0 0 4 4"><rect width="4" height="4"></rect></svg>',
    );
  });

  it("validates SVG structure, attributes and limits on every write path", () => {
    const base = putDesignFrame(
      [],
      putInput({
        html: '<div><svg viewBox="0 0 4 4"><g><path d="M0 0h4v4z" fill="#000"/></g></svg></div>',
      }),
    ).frame;
    const find = (tag: string) =>
      base.layers.nodes.find(
        (node): node is Element => node.type === "element" && node.tag === tag,
      )!;
    const edit = (operations: DesignLayersEditInput["operations"], agentEdit = false) =>
      editDesignFrame(
        base,
        { frameId: "home", mutationId: `m-${Math.random()}`, operations },
        { agent: agentEdit },
      );
    // SVG elements never outside an svg layer; HTML never inside one; text only in title/desc.
    for (const [operation, reason] of [
      [
        {
          type: "insert_layers",
          parentId: null,
          layers: layer({ id: "p", type: "element", tag: "path", attributes: {}, children: [] }),
        },
        /belong inside an <svg>/,
      ],
      [
        {
          type: "insert_layers",
          parentId: find("g").id,
          layers: layer({ id: "d", type: "element", tag: "div", attributes: {}, children: [] }),
        },
        /Unsupported SVG element/,
      ],
      [
        {
          type: "insert_layers",
          parentId: find("g").id,
          layers: layer({ id: "t", type: "text", text: "x" }),
        },
        /Text inside an SVG/,
      ],
      [
        {
          type: "insert_layers",
          parentId: find("g").id,
          layers: layer({
            id: "x",
            type: "element",
            tag: "path",
            attributes: { fill: "url(https://evil.example/#a)" },
            children: [],
          }),
        },
        /Unsupported SVG attribute fill on <path>/,
      ],
      [{ type: "move", nodeId: find("path").id, parentId: null }, /belong inside an <svg>/],
      [
        { type: "set_attributes", nodeId: find("path").id, attributes: { onclick: "x()" } },
        /Unsupported SVG attribute onclick on <path>: event handlers/,
      ],
      [
        {
          type: "set_attributes",
          nodeId: find("path").id,
          attributes: { fill: "url(other.svg#a)" },
        },
        /Unsupported SVG attribute fill/,
      ],
    ] as const)
      for (const agentEdit of [false, true])
        expect(() =>
          edit([operation as DesignLayersEditInput["operations"][number]], agentEdit),
        ).toThrow(reason);
    // Removing an SVG attribute is always allowed; valid values are set as written.
    const recolored = edit([
      {
        type: "set_attributes",
        nodeId: find("path").id,
        attributes: { fill: "currentColor", "stroke-width": "1.5" },
      },
      {
        type: "set_attributes",
        nodeId: find("svg").id,
        attributes: { width: null, viewBox: "0 0 8 8" },
      },
    ]).frame;
    expect(serializeDesignLayers(recolored.layers, false)).toBe(
      '<div><svg viewBox="0 0 8 8"><g><path d="M0 0h4v4z" fill="currentColor" stroke-width="1.5"></path></g></svg></div>',
    );
    // Inserting into an SVG parses the HTML as SVG, as a browser does there.
    const inserted = edit(
      [
        {
          type: "insert_html",
          parentId: find("g").id,
          html: '<circle cx="2" cy="2" r="1"/><linearGradient id="q"/>',
        },
      ],
      true,
    );
    expect(serializeDesignLayers(inserted.frame.layers, false)).toContain(
      '<circle cx="2" cy="2" r="1"></circle><linearGradient id="q"></linearGradient>',
    );
    // A duplicate is a whole SVG with its own layer IDs (scoped apart when rendered).
    const duplicated = edit([{ type: "duplicate", nodeId: find("svg").id }]);
    expect(
      duplicated.frame.layers.nodes.filter(
        (node) => node.type === "element" && node.tag === "path",
      ),
    ).toHaveLength(2);
  });

  it("caps one SVG's layers and counts SVG toward the frame's depth and source limits", () => {
    const many = `<svg>${'<rect width="1" height="1"/>'.repeat(DESIGN_CANVAS_MAX_SVG_LAYERS)}</svg>`;
    expect(() => strict(many)).toThrow(/<svg>.*more than 1,000 nodes/);
    const capped = agent(many);
    expect(capped.layers.nodes).toEqual([]);
    expect(capped.reports).toEqual(["Dropped <svg> in an SVG: it holds more than 1,000 nodes"]);
    const fits = strict(
      `<svg>${'<rect width="1" height="1"/>'.repeat(DESIGN_CANVAS_MAX_SVG_LAYERS - 1)}</svg>`,
    );
    expect(fits.nodes).toHaveLength(DESIGN_CANVAS_MAX_SVG_LAYERS);
    // The cap is enforced on stored trees too, whatever wrote them.
    const tree = {
      roots: ["root"],
      nodes: [
        {
          id: "root",
          type: "element" as const,
          tag: "svg",
          attributes: {},
          children: Array.from({ length: DESIGN_CANVAS_MAX_SVG_LAYERS }, (_, at) => `r${at}`),
        },
        ...Array.from({ length: DESIGN_CANVAS_MAX_SVG_LAYERS }, (_, at) => ({
          id: `r${at}`,
          type: "element" as const,
          tag: "rect",
          attributes: {},
          children: [],
        })),
      ],
    };
    expect(() => validateDesignLayers(tree)).toThrow(/An SVG exceeds its 1,000-layer limit/);
    const deep = `<svg>${"<g>".repeat(70)}${"</g>".repeat(70)}</svg>`;
    expect(() => strict(deep)).toThrow("Layer nesting exceeds 64 levels.");
    const path = `M${"1 1 ".repeat(50_000)}`;
    expect(() =>
      putDesignFrame([], putInput({ html: `<svg viewBox="0 0 4 4"><path d="${path}"/></svg>` })),
    ).toThrow("KiB of inline-styled HTML");
  });
});

describe("inline SVG import cost", () => {
  it("strips entity DOCTYPEs in one pass, even many unterminated ones", () => {
    const hostile = "<!DOCTYPE x [".repeat(15_000);
    const started = performance.now();
    const reports: string[] = [];
    expect(
      importDesignLayers(hostile, undefined, undefined, [], reportSvgPart(reports)).nodes,
    ).toEqual([]);
    expect(reports).toEqual([
      "Dropped <!DOCTYPE> in an SVG: XML entity declarations are not supported",
    ]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

const texts = (layers: DesignLayerTree) =>
  layers.nodes.flatMap((node) => (node.type === "text" ? [node.text] : []));

describe("HTML import: rewritten tags, removed tags, reports and whitespace", () => {
  let next = 0;
  const ids = () => `h${next++}`;
  const stored = (layers: DesignLayerTree) => serializeDesignLayers(layers, false);
  /** The editor's import: no notes, the strict SVG rule. */
  const editor = (html: string) => importDesignLayers(html, ids);
  /** The agent's import: every change noted, as `dropped` receives it. */
  const agent = (html: string, options: { parentTag?: string | undefined } = {}) => {
    const notes: string[] = [];
    const sourceTags = new Map<string, string>();
    const layers = importDesignLayers(html, ids, options.parentTag, [], reportSvgPart(notes), {
      note: (message) => notes.push(message),
      sourceTags,
    });
    return { layers, notes, sourceTags };
  };
  const edit = (
    frame: DesignFrame,
    agentEdit: boolean,
    ...operations: DesignLayersEditInput["operations"]
  ) =>
    editDesignFrame(
      frame,
      { frameId: frame.id, mutationId: `m-${next++}`, operations },
      { agent: agentEdit },
    );

  it("keeps the content of tags Synara has no layer for, under the nearest neutral tag", () => {
    const html =
      '<form data-k="f"><fieldset><legend>Plan</legend><p>Pay <time datetime="2025-01-01">today</time> or press <kbd>⌘K</kbd></p></fieldset></form>' +
      "<menu><li>One</li></menu><my-card><p>Hi</p></my-card><xmp><b>raw</b></xmp>";
    const expected =
      '<div data-k="f"><div><div>Plan</div><p>Pay <span>today</span> or press <span>⌘K</span></p></div></div>' +
      "<ul><li>One</li></ul><div><p>Hi</p></div><pre>&lt;b&gt;raw&lt;/b&gt;</pre>";
    // The same tree for the editor and for agents; nothing of the text is lost.
    expect(stored(editor(html))).toBe(expected);
    const { layers, notes, sourceTags } = agent(html);
    expect(stored(layers)).toBe(expected);
    expect(texts(layers)).toEqual([
      "Plan",
      "Pay ",
      "today",
      " or press ",
      "⌘K",
      "One",
      "Hi",
      "<b>raw</b>",
    ]);
    expect(notes).toEqual([
      "Replaced tags the canvas has no layer for, keeping their content: <form> as <div>, <fieldset> as <div>, <legend> as <div>, <time> as <span>, <kbd> as <span>, <menu> as <ul>, <my-card> as <div>, <xmp> as <pre>",
      "Dropped attributes canvas layers do not keep: datetime on <time>",
    ]);
    // The tag each layer was written with, for the stylesheet.
    expect([...sourceTags.values()]).toEqual([
      "form",
      "fieldset",
      "legend",
      "time",
      "kbd",
      "menu",
      "my-card",
      "xmp",
    ]);
    // Every rewrite survives the parser's nesting rules, so the stored tree reparses as itself.
    expect(stored(editor(stored(layers)))).toBe(expected);
    validateDesignLayers(layers);
  });

  it("nests a rewritten block inside a paragraph as a block span and unwraps it in a table", () => {
    const { layers, notes } = agent("<p>Lead <legend>Inline legend</legend></p>");
    expect(stored(layers)).toBe('<p>Lead <span style="display:block">Inline legend</span></p>');
    expect(notes[0]).toContain('<legend> as <span style="display:block">');
    const table = agent("<table><form><tr><td>1</td></tr></form></table>");
    expect(stored(table.layers)).toBe("<table><tbody><tr><td>1</td></tr></tbody></table>");
    expect(table.notes[0]).toContain("<form> by its content (inside <table>)");
    // Both land through the edit path, whose nesting check would refuse a div inside a p.
    const base = putDesignFrame([], putInput({ html: "<p>Start</p>" })).frame;
    const paragraph = base.layers.roots[0]!;
    for (const agentEdit of [false, true])
      expect(
        stored(
          edit(base, agentEdit, {
            type: "insert_html",
            parentId: paragraph,
            html: " <my-note>aside</my-note> <b>bold</b>",
          }).frame.layers,
        ),
        // Spaces beside a block collapse in the browser, so they are not stored.
      ).toBe('<p>Start<span style="display:block">aside</span><b>bold</b></p>');
    // Inserted after existing text, a leading space is a space between words.
    expect(
      stored(
        edit(base, true, { type: "insert_html", parentId: paragraph, html: " <b>now</b>" }).frame
          .layers,
      ),
    ).toBe("<p>Start <b>now</b></p>");
  });

  it("removes what runs, loads or embeds, with its content, and reports it for agents only", () => {
    const html =
      '<div><script>alert(1)</script><iframe src="https://evil.example">fallback</iframe><object data="x.swf"><p>fb</p></object>' +
      '<noscript><p>ns</p></noscript><template><p>t</p></template><meta charset="utf-8"><link rel="stylesheet" href="https://evil.example/x.css">' +
      '<video src="https://evil.example/x.mp4" style="width:320px;height:180px"><source src="x.webm"></video><math><mi>x</mi></math></div>';
    const expected = '<div><div style="width:320px;height:180px"></div></div>';
    expect(stored(editor(html))).toBe(expected);
    const { layers, notes } = agent(html);
    expect(stored(layers)).toBe(expected);
    for (const gone of ["alert", "evil.example", "fallback", "fb", "ns", "<p>"])
      expect(stored(layers), gone).not.toContain(gone);
    expect(notes).toEqual([
      "Replaced tags the canvas has no layer for, keeping their content: <video> as <div>",
      "Dropped tags with everything inside them: <script> (scripts never run on the canvas), <iframe> (embedded documents never load on the canvas), <object> (embedded documents never load on the canvas), <noscript> (scripts never run on the canvas), <template> (scripts never run on the canvas), <meta> (document metadata is not part of a frame), <link> (document metadata is not part of a frame), <source> (media sources never load on the canvas), <math> (MathML is not supported; write the formula as text or inline SVG)",
      "Dropped external sources (only an img src loads, and only synara-asset:ID or data:image; import files with synara_import_canvas_asset): src on <video>",
    ]);
  });

  it("reports stripped attributes once per kind, listing at most ten of each", () => {
    const { layers, notes } = agent(
      '<a href="https://example.com" target="_blank" onclick="x()">Go</a>' +
        '<img src="https://example.com/a.png" data-synara-layer-id="forged" alt="A">' +
        '<img src="data:image/png;base64,iVBORw0KGgo=">' +
        Array.from({ length: 12 }, (_, index) => `<div x-${index}="1"></div>`).join(""),
    );
    expect(stored(layers)).toContain(
      '<a>Go</a><img alt="A"><img src="data:image/png;base64,iVBORw0KGgo=">',
    );
    expect(notes).toEqual([
      "Dropped link targets (links never navigate on the canvas): href on <a>",
      "Dropped external sources (only an img src loads, and only synara-asset:ID or data:image; import files with synara_import_canvas_asset): src on <img>",
      "Dropped event handlers (scripts never run on the canvas): onclick on <a>",
      "Dropped layer IDs written in the HTML (Synara gives new layers new IDs): data-synara-layer-id on <img>",
      `Dropped attributes canvas layers do not keep: target on <a>, ${Array.from({ length: 9 }, (_, index) => `x-${index} on <div>`).join(", ")}, and 3 more`,
    ]);
    // Agent edits: the same lines under dropped, once per batch; editor edits: none, as before.
    const base = putDesignFrame([], putInput({ html: "" })).frame;
    const insert = { type: "insert_html" as const, parentId: null, html: '<a href="#top">Top</a>' };
    const agentEdit = edit(base, true, insert, insert);
    expect(agentEdit.dropped).toEqual([
      "Dropped link targets (links never navigate on the canvas): href on <a>",
    ]);
    expect(agentEdit.frame.lastLayerEdit?.dropped).toEqual(agentEdit.dropped);
    expect(edit(base, false, insert).dropped).toEqual([]);
    // Frame puts are agent writes.
    expect(putDesignFrame([], putInput({ html: '<a href="#top">Top</a>' })).dropped).toContain(
      "Dropped link targets (links never navigate on the canvas): href on <a>",
    );
  });

  it("keeps the strict SVG rule in editor edits beside the silent HTML rewrites", () => {
    const base = putDesignFrame([], putInput({ html: "" })).frame;
    const html =
      '<form><p>Kept</p></form><svg viewBox="0 0 4 4"><path onclick="x()" d="M0 0"/></svg>';
    expect(() => edit(base, false, { type: "insert_html", parentId: null, html })).toThrow(
      /Unsupported SVG: onclick on <path>/,
    );
    const applied = edit(base, true, { type: "insert_html", parentId: null, html });
    expect(stored(applied.frame.layers)).toBe(
      '<div><p>Kept</p></div><svg viewBox="0 0 4 4"><path d="M0 0"></path></svg>',
    );
    expect(applied.dropped).toEqual([
      "Dropped onclick on <path> in an SVG: event handlers never run on the canvas",
      "Replaced tags the canvas has no layer for, keeping their content: <form> as <div>",
    ]);
  });

  it("gives a rewritten tag its look, under the design's own rules for that tag", () => {
    const { frame } = putDesignFrame(
      [],
      putInput({
        html: '<p data-k="p"><kbd>⌘K</kbd> to search, <del>$12</del> <time>today</time></p>',
        css: "kbd{font-family:'JetBrains Mono',monospace} time{color:#c00} p del{color:#888}",
      }),
    );
    const nodes = new Map(frame.layers.nodes.map((node) => [node.id, node]));
    /** The span that holds this text: stored without attributes but its style, as a range. */
    const span = (text: string) =>
      frame.layers.nodes.find(
        (node): node is Element =>
          node.type === "element" &&
          node.children.some((child) => {
            const layer = nodes.get(child);
            return layer?.type === "text" && layer.text === text;
          }),
      )!;
    expect(span("⌘K")).toMatchObject({
      tag: "span",
      // The design's rule for kbd wins over kbd's own monospace look.
      attributes: { style: "font-family:'JetBrains Mono',monospace" },
    });
    expect(span("$12").attributes).toEqual({
      style: "text-decoration-line:line-through;color:#888",
    });
    expect(span("today").attributes).toEqual({ style: "color:#c00" });
    // Spans with typography only: one rich text block the user edits in place.
    expect(designTextBlockKind(nodes, elementOf(frame.layers, "p").id)).toBe("rich");
  });

  it("stores whitespace only where it shows", () => {
    const cases: Array<[html: string, stored: string, parentTag?: string]> = [
      // Indentation between blocks is not a layer.
      [
        "<section>\n  <h2>Title</h2>\n  <p>Body</p>\n</section>",
        "<section><h2>Title</h2><p>Body</p></section>",
      ],
      // Between two inline elements it is a space; at a block's edges it is not.
      ["<p>\n  <b>Bold</b>\n  <i>it</i>\n</p>", "<p><b>Bold</b>\n  <i>it</i></p>"],
      // Inside inline text it is kept as written.
      ["<p>a<span> </span>b</p>", "<p>a<span> </span>b</p>"],
      // pre and preserved white space keep every character.
      ["<pre>\n  <code>x</code>\n</pre>", "<pre>  <code>x</code>\n</pre>"],
      [
        '<div style="white-space:pre-wrap">\n  <span>a</span>\n</div>',
        '<div style="white-space:pre-wrap">\n  <span>a</span>\n</div>',
      ],
      // Flex, grid, table and select children never show it.
      [
        '<div style="display:flex">\n <span>a</span>\n <span>b</span>\n</div>',
        '<div style="display:flex"><span>a</span><span>b</span></div>',
      ],
      [
        "<table>\n <tr>\n  <td>1</td>\n </tr>\n</table>",
        "<table><tbody><tr><td>1</td></tr></tbody></table>",
      ],
      ["<select>\n <option>A</option>\n</select>", "<select><option>A</option></select>"],
      // A button lays out its own line: the space between icon and label stays, its edges go.
      [
        '<button>\n  <svg viewBox="0 0 4 4"></svg>\n  <span>Go</span>\n</button>',
        '<button><svg viewBox="0 0 4 4"></svg>\n  <span>Go</span></button>',
      ],
      // A no-break space is content.
      ["<div> </div>", "<div> </div>"],
      // Inserted into a pre, or into inline text, whitespace stays; into a block, it is nothing.
      ["  ", "  ", "pre"],
      [" ", " ", "span"],
      ["\n  <p>x</p>\n", "<p>x</p>", "div"],
    ];
    for (const [html, expected, parentTag] of cases) {
      expect(stored(agent(html, { parentTag }).layers), JSON.stringify(html)).toBe(expected);
      expect(stored(importDesignLayers(html, ids, parentTag)), JSON.stringify(html)).toBe(expected);
    }
    // The edit path knows the parent's style: a flex row takes no whitespace between items.
    const base = putDesignFrame(
      [],
      putInput({ html: '<div style="display:flex;gap:8px"></div><pre></pre>' }),
    ).frame;
    const [row, pre] = base.layers.roots as [string, string];
    const applied = edit(
      base,
      true,
      { type: "insert_html", parentId: row, html: "\n  <span>a</span>\n  <span>b</span>\n" },
      { type: "insert_html", parentId: pre, html: "\n  indented" },
    );
    // (The serializer doubles a pre's leading newline, which the parser strips.)
    expect(stored(applied.frame.layers)).toBe(
      '<div style="display:flex;gap:8px"><span>a</span><span>b</span></div><pre>\n\n  indented</pre>',
    );
    expect(texts(applied.frame.layers)).toEqual(["a", "b", "\n  indented"]);
    expect(applied.dropped).toEqual([]);
  });

  it("still enforces depth, layer and size limits on rewritten content", () => {
    expect(() => agent(`${"<time>".repeat(70)}x${"</time>".repeat(70)}`)).toThrow(
      "Layer nesting exceeds 64 levels.",
    );
    expect(() => agent("<kbd>x</kbd>".repeat(1_501))).toThrow("3,000-layer limit");
    // Indentation no longer counts: 1,400 indented blocks are 2,800 layers, not 4,200.
    const indented = agent("<div>x</div>\n  ".repeat(1_400)).layers;
    expect(indented.nodes).toHaveLength(2_800);
    // Removed content is never parsed into layers, however large.
    expect(agent(`<template>${"<p>x</p>".repeat(5_000)}</template>`).layers.nodes).toEqual([]);
  });
});
