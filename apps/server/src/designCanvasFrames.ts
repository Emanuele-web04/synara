import { createHash } from "node:crypto";
import {
  DESIGN_CANVAS_MAX_FRAMES,
  DESIGN_CANVAS_MAX_SOURCE_BYTES,
  type DesignFrame,
  type DesignFramePutInput,
  type DesignLayerAppliedEdit,
  type DesignLayerDuplicate,
  type DesignLayersEditInput,
} from "@synara/contracts";
import { stableJsonStringify } from "@synara/shared/browserAutomationCatalogue";
import { serializeDesignLayers, validateDesignLayers } from "@synara/shared/designCanvasLayers";
import { inlineDesignStyles, parseDeclarations } from "./designCanvasInline";
import {
  DESIGN_MAPPED_TAG_CSS,
  editDesignLayers,
  importDesignLayers,
  patchStyles,
  reportSvgPart,
  reportTo,
  type DesignLayerEditOptions,
} from "./designCanvasLayers";

const FRAME_GAP = 80;

function assertSourceSize(frame: Pick<DesignFrame, "layers" | "style">) {
  const bytes =
    Buffer.byteLength(serializeDesignLayers(frame.layers, false)) +
    Buffer.byteLength(frame.style ?? "");
  if (bytes > DESIGN_CANVAS_MAX_SOURCE_BYTES)
    throw new Error(
      `View exceeds ${DESIGN_CANVAS_MAX_SOURCE_BYTES / 1024} KiB of inline-styled HTML. Split it into smaller views.`,
    );
}

/** Explicit frame declarations win over html/body/:root rules found in the stylesheet. */
function mergeFrameStyle(fromRules: string, explicit: string | undefined): string {
  return patchStyles("", {
    ...Object.fromEntries(declarations(fromRules)),
    ...Object.fromEntries(declarations(explicit ?? "")),
  });
}

function declarations(source: string): [string, string][] {
  return parseDeclarations(source).map((declaration) => [
    declaration.prop,
    `${declaration.value}${declaration.important ? " !important" : ""}`,
  ]);
}

export function validateDesignFrame(frame: DesignFrame): DesignFrame {
  validateDesignLayers(frame.layers);
  return frame;
}

/** HTML is parsed once; its stylesheets are resolved into inline element styles. */
export function importDesignFrameSource(input: {
  html: string;
  css?: string | undefined;
  style?: string | undefined;
  width: number;
  height: number;
}) {
  const sheets = input.css ? [input.css] : [];
  // Frames are put by agents only, so SVG parts outside the subset are reported, not refused,
  // and every change the import makes to the HTML is reported too.
  const svgDropped: string[] = [];
  const sourceTags = new Map<string, string>();
  const parsed = importDesignLayers(
    input.html,
    undefined,
    undefined,
    sheets,
    reportSvgPart(svgDropped),
    {
      note: reportTo(svgDropped),
      sourceTags,
      ancestors: [{ tag: "div", style: input.style ?? "" }],
    },
  );
  const inlined = inlineDesignStyles({
    layers: parsed,
    css: [...(sourceTags.size > 0 ? [DESIGN_MAPPED_TAG_CSS] : []), ...sheets].join("\n"),
    width: input.width,
    height: input.height,
    sourceTags,
  });
  return {
    layers: inlined.layers,
    style: mergeFrameStyle(inlined.frameDeclarations, input.style),
    dropped: [...new Set([...svgDropped, ...inlined.dropped])],
  };
}

export function putDesignFrame(
  frames: readonly DesignFrame[],
  input: DesignFramePutInput,
): { frame: DesignFrame; dropped: string[] } {
  const previous = frames.find((frame) => frame.id === input.id);
  const { expectedRevision, ...source } = input;
  const fingerprint = createHash("sha256").update(stableJsonStringify(source)).digest("hex");
  if (
    previous &&
    previous.revision === expectedRevision + 1 &&
    previous.lastLayerEdit?.mutationId === `put_${previous.revision}` &&
    previous.lastLayerEdit.fingerprint === fingerprint
  )
    return { frame: previous, dropped: [] };
  if ((previous?.revision ?? 0) !== expectedRevision)
    throw new Error(
      "View revision conflict. Read the canvas and retry against the current revision.",
    );
  if (!previous && frames.length >= DESIGN_CANVAS_MAX_FRAMES)
    throw new Error(`Canvas page has reached its ${DESIGN_CANVAS_MAX_FRAMES}-view limit.`);
  const imported = importDesignFrameSource(source);
  const revision = expectedRevision + 1;
  const frame: DesignFrame = {
    id: source.id,
    title: source.title,
    width: source.width,
    height: source.height,
    revision,
    x:
      previous?.x ??
      source.x ??
      frames.reduce((right, item) => Math.max(right, item.x + item.width + FRAME_GAP), 0),
    y: previous?.y ?? source.y ?? 0,
    ...(imported.style ? { style: imported.style } : {}),
    layers: imported.layers,
    lastLayerEdit: { mutationId: `put_${revision}`, fingerprint, createdNodeIds: [] },
  };
  assertSourceSize(frame);
  return { frame, dropped: imported.dropped };
}

/** `applied` is null for a retried mutation ID, which returns the stored result unchanged. */
export function editDesignFrame(
  frame: DesignFrame,
  input: DesignLayersEditInput,
  options: DesignLayerEditOptions = {},
): {
  frame: DesignFrame;
  createdNodeIds: string[];
  dropped: string[];
  duplicates: DesignLayerDuplicate[];
  applied: DesignLayerAppliedEdit[] | null;
} {
  const fingerprint = createHash("sha256").update(stableJsonStringify(input)).digest("hex");
  if (frame.lastLayerEdit?.mutationId === input.mutationId) {
    if (frame.lastLayerEdit.fingerprint !== fingerprint)
      throw new Error("Mutation ID was already used for a different edit.");
    return {
      frame,
      createdNodeIds: [...frame.lastLayerEdit.createdNodeIds],
      dropped: [...(frame.lastLayerEdit.dropped ?? [])],
      duplicates: [...(frame.lastLayerEdit.duplicates ?? [])],
      applied: null,
    };
  }
  if (input.expectedRevision !== undefined && frame.revision !== input.expectedRevision)
    throw new Error(
      "View revision conflict. Read the canvas and retry against the current revision, or omit expectedRevision to apply the edit to the latest revision.",
    );
  const edited = editDesignLayers(
    frame.layers,
    input.operations,
    { style: frame.style ?? "", width: frame.width, height: frame.height },
    options,
  );
  const { style: _style, ...rest } = frame;
  const next: DesignFrame = {
    ...rest,
    ...(edited.frameStyle ? { style: edited.frameStyle } : {}),
    layers: edited.layers,
    revision: frame.revision + 1,
    lastLayerEdit: {
      mutationId: input.mutationId,
      fingerprint,
      createdNodeIds: edited.createdNodeIds,
      ...(edited.duplicates.length > 0 ? { duplicates: edited.duplicates } : {}),
      ...(edited.dropped.length > 0 ? { dropped: edited.dropped.slice(0, 100) } : {}),
    },
  };
  assertSourceSize(next);
  return {
    frame: next,
    createdNodeIds: edited.createdNodeIds,
    dropped: edited.dropped,
    duplicates: edited.duplicates,
    applied: edited.applied,
  };
}
