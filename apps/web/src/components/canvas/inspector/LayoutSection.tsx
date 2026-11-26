// FILE: LayoutSection.tsx
// Purpose: Inspector Layout section: frame geometry or layer X, Y and
//          rotation, W/H with sizing modes, constraints, Flex (direction, wrap, alignment grid,
//          gaps, padding), absolute position and clip content. The header holds Resize to
//          fit / fill, or align and distribute for several freely placed items.
// Layer: Canvas editor UI

import {
  DESIGN_FRAME_MAX_HEIGHT,
  DESIGN_FRAME_MAX_WIDTH,
  DESIGN_FRAME_MIN_SIZE,
  type CanvasFrameLayoutPatch,
} from "@synara/contracts";
import { useState } from "react";
import { selectionKey } from "../canvasStores";
import { useCanvasLiveGeometry } from "../editor/canvasLiveGeometry";
import { useTranslation } from "~/i18n";
import { EllipsisIcon, MinusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { IconButton } from "../../ui/icon-button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuSub,
  MenuShortcut,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import {
  FieldLetter,
  InspectorActionRow,
  InspectorCheckbox,
  InspectorExpand,
  InspectorIcon,
  InspectorNumberField,
  InspectorRow,
  InspectorSection,
  InspectorSelect,
  InspectorSubheader,
  InspectorToggle,
  InspectorToggleGroup,
} from "./InspectorControls";
import {
  alignmentPatch,
  clamp,
  formatLength,
  formatNumber,
  insetExpansion,
  isAlignmentCell,
  isMixed,
  mergeValues,
  mixedNumber,
  normalizeDegrees,
  parsePercent,
  pinPatch,
  readAlignment,
  rotateDegrees,
  rotationPatch,
  single,
  sizingPatch,
  SIDES,
  transformRotation,
  type AlignMode,
  type AlignmentState,
  type CssInput,
  type GridPosition,
  type Pin,
  type PinAxis,
  type SizingAxis,
  type SizingMode,
  type StylePatch,
} from "./inspectorValues";
import {
  previewFrameGeometry,
  restoreFrameGeometry,
  type InspectorModel,
  type InspectorTarget,
} from "./useInspectorModel";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "../../chat/ComposerPickerMenuPopup";
import { canvasShortcutLabelFor } from "../editor/canvasShortcuts";
import { ShortcutTooltip } from "../editor/ShortcutTooltip";
import {
  containerSize,
  insetOf,
  pinOf,
  positionPatch,
  sizeInputPatch,
  sizingModeOf,
} from "./layoutPatches";
import {
  alignSelection,
  distributeSelection,
  isFreeformSelection,
  resizeSelectionTo,
} from "./layoutActions";

const isFlexDisplay = (display: string) => display === "flex" || display === "inline-flex";
const isGridDisplay = (display: string) => display === "grid" || display === "inline-grid";
const isColumn = (target: InspectorTarget) =>
  target.computed["flex-direction"].startsWith("column");
const isWrapping = (target: InspectorTarget) => target.computed["flex-wrap"] !== "nowrap";
const pxOf = (value: string) => parseFloat(value) || 0;

const isAbsolute = (target: InspectorTarget) =>
  target.computed.position === "absolute" || target.computed.position === "fixed";

export function LayoutSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const frames = model.targets.filter((target) => target.isFrame);
  const layers = model.targets.filter((target) => !target.isFrame);
  const containers = model.targets.filter((target) => target.container);
  const flex =
    containers.length > 0 && containers.every((target) => isFlexDisplay(target.computed.display));
  const plain = containers.filter(
    (target) => !isFlexDisplay(target.computed.display) && !isGridDisplay(target.computed.display),
  );
  const grid = containers.length > 0 && !flex && plain.length === 0;
  const onlyFrames = frames.length > 0 && layers.length === 0;
  const onlyLayers = layers.length > 0 && frames.length === 0;
  // Freeform items: frames on the page, or absolutely placed layers.
  const freeform = isFreeformSelection(model);
  const wrapsLayers = onlyLayers && layers.length > 1;
  const readOnly = model.readOnly;
  return (
    <InspectorSection
      title={t("workspace:canvasInspectorLayout")}
      headerAction={
        readOnly ? null : freeform ? (
          <AlignActions model={model} />
        ) : onlyLayers ? (
          <ResizeActions model={model} />
        ) : null
      }
    >
      {onlyFrames ? <FrameGeometry model={model} /> : null}
      {onlyLayers ? <LayerGeometry model={model} /> : null}
      {flex ? (
        <FlexGroup model={model} targets={containers} />
      ) : (
        <>
          {!readOnly && (plain.length > 0 || wrapsLayers) ? (
            <InspectorActionRow
              label={t(
                wrapsLayers
                  ? "workspace:canvasInspectorWrapInFlex"
                  : "workspace:canvasInspectorAddFlex",
              )}
              hint={canvasShortcutLabelFor({ id: "add-flex" }) ?? undefined}
              onClick={() => void model.editor.commands.addFlex()}
            />
          ) : null}
          {grid ? (
            <span className="text-ui-xs text-muted-foreground">
              {t("workspace:canvasInspectorGridLayout")}
            </span>
          ) : null}
          <PaddingRows model={model} targets={model.targets} />
        </>
      )}
      {onlyLayers ? <LayerOptions model={model} /> : null}
    </InspectorSection>
  );
}

// ── Header actions ───────────────────────────────────────────────────────

/** Resize to fit and Resize to fill: both axes hug the content, or fill the parent. */
function ResizeActions({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  return (
    <>
      <IconButton
        label={t("workspace:canvasInspectorResizeToFit")}
        tooltip={
          <ShortcutTooltip
            label={t("workspace:canvasInspectorResizeToFit")}
            shortcut={canvasShortcutLabelFor({ id: "resize-to", mode: "fit" })}
          />
        }
        size="icon-xs"
        onClick={() => void resizeSelectionTo(model, "fit")}
      >
        <InspectorIcon name="minimize" />
      </IconButton>
      <IconButton
        label={t("workspace:canvasInspectorResizeToFill")}
        tooltip={
          <ShortcutTooltip
            label={t("workspace:canvasInspectorResizeToFill")}
            shortcut={canvasShortcutLabelFor({ id: "resize-to", mode: "fill" })}
          />
        }
        size="icon-xs"
        onClick={() => void resizeSelectionTo(model, "fill")}
      >
        <InspectorIcon name="expand" />
      </IconButton>
    </>
  );
}

const ALIGN_BUTTONS: ReadonlyArray<{ mode: AlignMode; icon: string; label: string }> = [
  { mode: "left", icon: "layout-align-left", label: "workspace:canvasInspectorAlignLeft" },
  {
    mode: "center",
    icon: "align-horizontal-center",
    label: "workspace:canvasInspectorAlignHorizontalCenters",
  },
  { mode: "right", icon: "layout-align-right", label: "workspace:canvasInspectorAlignRight" },
  { mode: "top", icon: "layout-align-top", label: "workspace:canvasInspectorAlignTop" },
  {
    mode: "middle",
    icon: "align-vertical-center",
    label: "workspace:canvasInspectorAlignVerticalCenters",
  },
  { mode: "bottom", icon: "layout-align-bottom", label: "workspace:canvasInspectorAlignBottom" },
];

/** Six align buttons and the Distribute menu, for several freely placed items. */
function AlignActions({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  return (
    // One tight cluster, so seven 24px buttons fit the header beside the title.
    <div className="-me-1 flex items-center">
      {ALIGN_BUTTONS.map((button) => (
        <IconButton
          key={button.mode}
          label={t(button.label)}
          tooltip={
            <ShortcutTooltip
              label={t(button.label)}
              shortcut={canvasShortcutLabelFor({ id: "align", mode: button.mode })}
            />
          }
          onClick={() => void alignSelection(model, button.mode)}
        >
          <InspectorIcon name={button.icon} />
        </IconButton>
      ))}
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              label={t("workspace:canvasInspectorMoreAlign")}
              tooltip={t("workspace:canvasInspectorMoreAlign")}
            >
              <EllipsisIcon className="size-3.5" />
            </IconButton>
          }
        />
        <ComposerPickerMenuPopup align="end">
          <MenuItem
            disabled={model.targets.length < 3}
            onClick={() => void distributeSelection(model, "y")}
          >
            {t("workspace:canvasInspectorDistributeVertically")}
            <MenuShortcut>{canvasShortcutLabelFor({ id: "distribute", axis: "y" })}</MenuShortcut>
          </MenuItem>
          <MenuItem
            disabled={model.targets.length < 3}
            onClick={() => void distributeSelection(model, "x")}
          >
            {t("workspace:canvasInspectorDistributeHorizontally")}
            <MenuShortcut>{canvasShortcutLabelFor({ id: "distribute", axis: "x" })}</MenuShortcut>
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  );
}

// ── Frames ───────────────────────────────────────────────────────────────

type GeometryKey = "x" | "y" | "width" | "height";

function clampGeometry(key: GeometryKey, value: number): number {
  if (key === "width")
    return clamp(Math.round(value), DESIGN_FRAME_MIN_SIZE, DESIGN_FRAME_MAX_WIDTH);
  if (key === "height")
    return clamp(Math.round(value), DESIGN_FRAME_MIN_SIZE, DESIGN_FRAME_MAX_HEIGHT);
  return Math.round(value);
}

function FrameGeometry({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const { editor, targets } = model;
  // A canvas drag or resize shows here as it happens, before it is saved.
  const live = useCanvasLiveGeometry();
  const field = (key: GeometryKey, letter: string, ariaLabel: string) => {
    const merged = mixedNumber(
      model.value((target) => live.get(selectionKey(target.item))?.[key] ?? target.frame[key]),
    );
    const sized = key === "width" || key === "height";
    return (
      <InspectorNumberField
        label={<FieldLetter>{letter}</FieldLetter>}
        ariaLabel={ariaLabel}
        {...merged}
        min={sized ? DESIGN_FRAME_MIN_SIZE : -1_000_000}
        max={
          key === "width"
            ? DESIGN_FRAME_MAX_WIDTH
            : key === "height"
              ? DESIGN_FRAME_MAX_HEIGHT
              : 1_000_000
        }
        disabled={model.readOnly}
        onPreview={(value) => {
          for (const target of targets)
            previewFrameGeometry(editor, target.frame.id, { [key]: clampGeometry(key, value) });
        }}
        onCommit={(input) => {
          if (input.kind !== "length") return;
          const value = clampGeometry(key, input.value);
          const frames: CanvasFrameLayoutPatch[] = targets.map((target) => ({
            id: target.frame.id,
            ...(key === "x" ? { x: value } : {}),
            ...(key === "y" ? { y: value } : {}),
            ...(key === "width" ? { width: value } : {}),
            ...(key === "height" ? { height: value } : {}),
          }));
          void editor.run({ kind: "layout", frames }).then((result) => {
            if (!result) for (const target of targets) restoreFrameGeometry(editor, target.frame);
          });
        }}
      />
    );
  };
  return (
    <>
      <InspectorRow>
        {field("x", t("workspace:canvasInspectorAxisX"), t("workspace:canvasInspectorX"))}
        {field("y", t("workspace:canvasInspectorAxisY"), t("workspace:canvasInspectorY"))}
      </InspectorRow>
      <InspectorRow>
        {field("width", t("workspace:canvasInspectorAxisW"), t("workspace:canvasInspectorWidth"))}
        {field("height", t("workspace:canvasInspectorAxisH"), t("workspace:canvasInspectorHeight"))}
      </InspectorRow>
    </>
  );
}

// ── Layer geometry: position, rotation, size, constraints ────────────────

/** X/Y, rotation, W/H and constraints of layers, in this row order. */
function LayerGeometry({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const absolute = model.value(isAbsolute) === true;
  const rotation = <RotationField model={model} />;
  const rotate90 = model.readOnly ? null : <Rotate90Button model={model} />;
  return (
    <>
      {absolute ? (
        <InspectorRow columns={3} dense trailing={rotate90}>
          <PositionField model={model} axis="x" />
          <PositionField model={model} axis="y" />
          {rotation}
        </InspectorRow>
      ) : (
        <InspectorRow trailing={rotate90}>{rotation}</InspectorRow>
      )}
      <InspectorRow>
        <SizeField model={model} axis="width" />
        <SizeField model={model} axis="height" />
      </InspectorRow>
      {absolute ? (
        <InspectorRow>
          <PinSelect
            model={model}
            axis="x"
            ariaLabel={t("workspace:canvasInspectorPinHorizontal")}
          />
          <PinSelect model={model} axis="y" ariaLabel={t("workspace:canvasInspectorPinVertical")} />
        </InspectorRow>
      ) : null}
    </>
  );
}

const rotationOf = (target: InspectorTarget) =>
  Number(
    formatNumber(
      rotateDegrees(target.computed.rotate) + transformRotation(target.computed.transform),
    ),
  );

const rotationTargetPatch = (target: InspectorTarget, degrees: number) =>
  rotationPatch(
    degrees,
    target.declared.get("transform"),
    transformRotation(target.computed.transform),
  );

function RotationField({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  return (
    <InspectorNumberField
      label={<InspectorIcon name="arrow-rotate-clockwise" className="size-3" />}
      suffix="°"
      ariaLabel={t("workspace:canvasInspectorRotation")}
      {...mixedNumber(model.value(rotationOf))}
      unit="deg"
      min={-3600}
      max={3600}
      disabled={model.readOnly}
      onPreview={(value) => model.preview((target) => rotationTargetPatch(target, value))}
      onCommit={(input) => {
        if (input.kind === "length" && (input.unit === "deg" || input.unit === ""))
          void model.commit((target) => rotationTargetPatch(target, input.value));
      }}
    />
  );
}

/** The rotate-90° button; Alt turns the other way. */
function Rotate90Button({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  return (
    <IconButton
      label={t("workspace:canvasInspectorRotate90")}
      tooltip={t("workspace:canvasInspectorRotate90Hint")}
      size="icon-xs"
      onClick={(event) => {
        const step = event.altKey ? -90 : 90;
        void model.commit((target) =>
          rotationTargetPatch(target, normalizeDegrees(rotationOf(target) + step)),
        );
      }}
    >
      <InspectorIcon name="rotate-360-right" />
    </IconButton>
  );
}

/** X and Y of absolutely positioned layers, as the distance from the containing block. */
function PositionField({ model, axis }: { model: InspectorModel; axis: PinAxis }) {
  const { t } = useTranslation();
  const live = useCanvasLiveGeometry();
  const offset = (target: InspectorTarget) =>
    live.get(selectionKey(target.item))?.[axis] ?? insetOf(target, axis).start;
  const patch = (target: InspectorTarget, value: number) => ({
    ...insetExpansion(target.declared, target.specified),
    ...positionPatch(target, axis, value),
  });
  return (
    <InspectorNumberField
      label={
        <FieldLetter>
          {t(axis === "x" ? "workspace:canvasInspectorAxisX" : "workspace:canvasInspectorAxisY")}
        </FieldLetter>
      }
      ariaLabel={t(axis === "x" ? "workspace:canvasInspectorX" : "workspace:canvasInspectorY")}
      {...mixedNumber(model.value(offset))}
      disabled={model.readOnly}
      onPreview={(value) => model.preview((target) => patch(target, value))}
      onCommit={(input) => {
        if (input.kind === "length" && input.unit === "px")
          void model.commit((target) => patch(target, input.value));
        else if (input.kind === "length")
          void model.commit({
            [axis === "x" ? "left" : "top"]: formatLength(input.value, input.unit),
          });
        else if (input.keyword === "auto")
          void model.commit({ [axis === "x" ? "left" : "top"]: null });
      }}
    />
  );
}

/** Constraints: the edge (or both, or the centre) an absolute layer is pinned to. */
function PinSelect({
  model,
  axis,
  ariaLabel,
}: {
  model: InspectorModel;
  axis: PinAxis;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  const pin = model.value((target) => pinOf(target, axis));
  const options =
    axis === "x"
      ? [
          { value: "start" as const, label: t("workspace:canvasInspectorLeft") },
          { value: "end" as const, label: t("workspace:canvasInspectorRight") },
          { value: "stretch" as const, label: t("workspace:canvasInspectorPinLeftRight") },
          { value: "center" as const, label: t("workspace:canvasInspectorCenter") },
        ]
      : [
          { value: "start" as const, label: t("workspace:canvasInspectorTop") },
          { value: "end" as const, label: t("workspace:canvasInspectorBottom") },
          { value: "stretch" as const, label: t("workspace:canvasInspectorPinTopBottom") },
          { value: "center" as const, label: t("workspace:canvasInspectorCenter") },
        ];
  return (
    <InspectorSelect<Pin>
      ariaLabel={ariaLabel}
      value={single(pin)}
      mixed={isMixed(pin)}
      disabled={model.readOnly}
      options={options}
      onChange={(next) =>
        void model.commit((target) => {
          const inset = insetOf(target, axis);
          return {
            ...insetExpansion(target.declared, target.specified),
            ...pinPatch({
              axis,
              pin: next,
              current: pinOf(target, axis),
              start: inset.start,
              end: inset.end,
              size: axis === "x" ? target.size.width : target.size.height,
              container: containerSize(target, axis),
            }),
          };
        })
      }
    />
  );
}

// ── Layer sizing ─────────────────────────────────────────────────────────

/** The W/H field: the size, then the sizing mode as a small chip inside the field. */
function SizeField({ model, axis }: { model: InspectorModel; axis: SizingAxis }) {
  const { t } = useTranslation();
  const live = useCanvasLiveGeometry();
  const mode = model.value((target) => sizingModeOf(target, axis));
  const relative = mode === "relative";
  const number = mixedNumber(
    model.value((target) =>
      relative
        ? (parsePercent(target.declared.get(axis)) ?? 100)
        : (live.get(selectionKey(target.item))?.[axis] ?? target.size[axis]),
    ),
  );
  const unit = relative ? "%" : "px";
  const name = t(
    isWidth(axis) ? "workspace:canvasInspectorWidth" : "workspace:canvasInspectorHeight",
  );
  return (
    <InspectorNumberField
      label={
        <FieldLetter>
          {t(isWidth(axis) ? "workspace:canvasInspectorAxisW" : "workspace:canvasInspectorAxisH")}
        </FieldLetter>
      }
      ariaLabel={name}
      {...number}
      unit={unit}
      min={0}
      disabled={model.readOnly}
      onPreview={(value) =>
        model.preview((target) => sizeInputPatch(target, axis, { kind: "length", value, unit }))
      }
      onCommit={(input) => void model.commit((target) => sizeInputPatch(target, axis, input))}
      trailing={
        <InspectorSelect<SizingMode>
          chip
          ariaLabel={t("workspace:canvasInspectorSizingMode", { name })}
          value={single(mode)}
          mixed={isMixed(mode)}
          disabled={model.readOnly}
          options={[
            { value: "fixed", label: t("workspace:canvasInspectorSizingFixed") },
            { value: "fit", label: t("workspace:canvasInspectorSizingFit") },
            { value: "fill", label: t("workspace:canvasInspectorSizingFill") },
            { value: "relative", label: t("workspace:canvasInspectorSizingRelative") },
          ]}
          onChange={(next) =>
            void model.commit((target) =>
              sizingPatch({
                axis,
                mode: next,
                current: sizingModeOf(target, axis),
                size: target.size[axis],
                parentSize: target.parent?.[axis] ?? 0,
                parent: target.parent,
              }),
            )
          }
        />
      }
    />
  );
}

const isWidth = (axis: SizingAxis) => axis === "width";

// ── Absolute position and clipping ───────────────────────────────────────

/** Absolute position and Clip content, at the foot of Layout. */
function LayerOptions({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const absolute = model.value(isAbsolute);
  const clipped = model.value((target) =>
    [target.computed["overflow-x"], target.computed["overflow-y"]].some(
      (value) => value === "hidden" || value === "clip",
    ),
  );
  return (
    <div className="flex flex-col gap-2 pt-0.5">
      <InspectorCheckbox
        label={t("workspace:canvasInspectorAbsolute")}
        checked={absolute === true}
        indeterminate={isMixed(absolute)}
        disabled={model.readOnly}
        onChange={(checked) =>
          void model.commit((target) =>
            checked
              ? {
                  position: "absolute",
                  left: `${target.offset.left}px`,
                  top: `${target.offset.top}px`,
                }
              : { position: null, inset: null, left: null, top: null, right: null, bottom: null },
          )
        }
      />
      <InspectorCheckbox
        label={t("workspace:canvasInspectorClipContent")}
        checked={clipped === true}
        indeterminate={isMixed(clipped)}
        disabled={model.readOnly}
        onChange={(checked) =>
          void model.commit(
            checked
              ? { "overflow-x": null, "overflow-y": null, overflow: "hidden" }
              : { overflow: null, "overflow-x": null, "overflow-y": null },
          )
        }
      />
    </div>
  );
}

// ── Flex ─────────────────────────────────────────────────────────────────

const FLEX_RESET: StylePatch = {
  display: null,
  "flex-direction": null,
  "flex-wrap": null,
  "flex-flow": null,
  "justify-content": null,
  "align-items": null,
  "align-content": null,
  gap: null,
  "row-gap": null,
  "column-gap": null,
};

/** Direction and wrap written as longhands, so a `flex-flow` shorthand never drops one. */
function flowPatch(target: InspectorTarget, change: { column?: boolean; wrap?: boolean }) {
  const direction =
    change.column === undefined
      ? target.computed["flex-direction"]
      : change.column
        ? "column"
        : "row";
  const wrap =
    change.wrap === undefined ? target.computed["flex-wrap"] : change.wrap ? "wrap" : "nowrap";
  return {
    "flex-flow": null,
    "flex-direction": direction === "row" ? null : direction,
    "flex-wrap": wrap === "nowrap" ? null : wrap,
  };
}

function flexState(targets: readonly InspectorTarget[]) {
  const merge = <T,>(read: (target: InspectorTarget) => T) => mergeValues(targets.map(read));
  const column = merge(isColumn);
  return {
    direction: column === true ? "column" : column === false ? "row" : null,
    column: column === true,
    wrap: merge(isWrapping),
    mainSpread: merge((target) => target.computed["justify-content"] === "space-between"),
    crossSpread: merge((target) => target.computed["align-content"] === "space-between"),
    baseline: merge((target) => {
      const value = target.computed["align-items"];
      return value.includes("last baseline") ? "last" : value.includes("baseline") ? "first" : null;
    }),
  } as const;
}

/** The Flex group inside Layout: its label row, then the alignment pad and spacing. */
function FlexGroup({
  model,
  targets,
}: {
  model: InspectorModel;
  targets: readonly InspectorTarget[];
}) {
  const { t } = useTranslation();
  const disabled = model.readOnly;
  const state = flexState(targets);
  const commit = (source: StylePatch | ((target: InspectorTarget) => StylePatch)) =>
    void model.commit(source, targets);
  // "Horizontally" is the main axis of a row and the cross axis (between lines) of a column.
  const horizontal = state.column ? state.crossSpread : state.mainSpread;
  const vertical = state.column ? state.mainSpread : state.crossSpread;
  const spread = (axis: "horizontal" | "vertical", on: boolean) =>
    commit((target) =>
      (axis === "horizontal") === !isColumn(target)
        ? { "justify-content": on ? "space-between" : null }
        : { "align-content": on ? "space-between" : null },
    );
  const crossDisabled = state.wrap !== true;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <InspectorSubheader title={t("workspace:canvasInspectorFlex")}>
        <InspectorToggleGroup<"row" | "column">
          compact
          ariaLabel={t("workspace:canvasInspectorDirection")}
          value={state.direction}
          disabled={disabled}
          options={[
            {
              value: "row",
              label: t("workspace:canvasInspectorDirectionRow"),
              icon: <InspectorIcon name="arrow-right" className="size-3" />,
            },
            {
              value: "column",
              label: t("workspace:canvasInspectorDirectionColumn"),
              icon: <InspectorIcon name="arrow-down" className="size-3" />,
            },
          ]}
          onChange={(next) => commit((target) => flowPatch(target, { column: next === "column" }))}
        />
        <InspectorToggle
          label={t("workspace:canvasInspectorWrap")}
          pressed={state.wrap === true}
          disabled={disabled}
          onPressedChange={(pressed) => commit((target) => flowPatch(target, { wrap: pressed }))}
        >
          <InspectorIcon name="arrow-loop-down-left" className="size-3" />
        </InspectorToggle>
        {disabled ? null : (
          <>
            <Menu>
              <MenuTrigger
                render={
                  <IconButton
                    label={t("workspace:canvasInspectorMoreFlex")}
                    tooltip={t("workspace:canvasInspectorMoreFlex")}
                    size="icon-xs"
                  >
                    <EllipsisIcon className="size-3.5" />
                  </IconButton>
                }
              />
              <ComposerPickerMenuPopup align="end">
                <MenuCheckboxItem
                  checked={horizontal === true}
                  disabled={state.column && crossDisabled}
                  onCheckedChange={(checked) => spread("horizontal", checked)}
                >
                  {t("workspace:canvasInspectorSpaceBetweenHorizontally")}
                </MenuCheckboxItem>
                <MenuCheckboxItem
                  checked={vertical === true}
                  disabled={!state.column && crossDisabled}
                  onCheckedChange={(checked) => spread("vertical", checked)}
                >
                  {t("workspace:canvasInspectorSpaceBetweenVertically")}
                </MenuCheckboxItem>
                <MenuSub>
                  <MenuSubTrigger>{t("workspace:canvasInspectorAlignBaseline")}</MenuSubTrigger>
                  <ComposerPickerMenuSubPopup>
                    <MenuCheckboxItem
                      checked={state.baseline === "first"}
                      onCheckedChange={(checked) =>
                        commit({ "align-items": checked ? "baseline" : null })
                      }
                    >
                      {t("workspace:canvasInspectorBaselineFirst")}
                    </MenuCheckboxItem>
                    <MenuCheckboxItem
                      checked={state.baseline === "last"}
                      onCheckedChange={(checked) =>
                        commit({ "align-items": checked ? "last baseline" : null })
                      }
                    >
                      {t("workspace:canvasInspectorBaselineLast")}
                    </MenuCheckboxItem>
                  </ComposerPickerMenuSubPopup>
                </MenuSub>
              </ComposerPickerMenuPopup>
            </Menu>
            <IconButton
              label={t("workspace:canvasInspectorRemoveFlex")}
              tooltip={
                <ShortcutTooltip
                  label={t("workspace:canvasInspectorRemoveFlex")}
                  shortcut={canvasShortcutLabelFor({ id: "remove-flex" })}
                />
              }
              size="icon-xs"
              onClick={() => commit(FLEX_RESET)}
            >
              <MinusIcon className="size-3.5" />
            </IconButton>
          </>
        )}
      </InspectorSubheader>
      <FlexBody model={model} targets={targets} />
    </div>
  );
}

/** The spacing block: the alignment pad beside the gaps and the padding pair. */
function FlexBody({
  model,
  targets,
}: {
  model: InspectorModel;
  targets: readonly InspectorTarget[];
}) {
  const { t } = useTranslation();
  const disabled = model.readOnly;
  const { column, wrap } = flexState(targets);
  const alignment = single(
    mergeValues(
      targets.map((target) =>
        readAlignment({
          direction: target.computed["flex-direction"],
          justifyContent: target.computed["justify-content"],
          alignItems: target.computed["align-items"],
        }),
      ),
      (a, b) => a.x === b.x && a.y === b.y,
    ),
  );
  const mainGapOf = (target: InspectorTarget) =>
    pxOf(target.computed[isColumn(target) ? "row-gap" : "column-gap"]);
  const crossGapOf = (target: InspectorTarget) =>
    pxOf(target.computed[isColumn(target) ? "column-gap" : "row-gap"]);
  /** One gap for a single line; with wrapping, the main and cross axes are separate longhands. */
  const gapPatch = (target: InspectorTarget, axis: "main" | "cross", value: string | null) => {
    if (!isWrapping(target)) return { gap: value, "row-gap": null, "column-gap": null };
    const mainProperty = isColumn(target) ? "row-gap" : "column-gap";
    const crossProperty = isColumn(target) ? "column-gap" : "row-gap";
    return { [axis === "main" ? mainProperty : crossProperty]: value };
  };
  const gapField = (axis: "main" | "cross") => (
    <InspectorNumberField
      label={
        <InspectorIcon
          name={(axis === "main") === column ? "dot-grid-1x3-vertical" : "dot-grid-1x3-horizontal"}
        />
      }
      suffix={t(
        axis === "main" ? "workspace:canvasInspectorGap" : "workspace:canvasInspectorLineGap",
      )}
      ariaLabel={t(
        axis === "main" ? "workspace:canvasInspectorGap" : "workspace:canvasInspectorLineGap",
      )}
      {...mixedNumber(mergeValues(targets.map(axis === "main" ? mainGapOf : crossGapOf)))}
      min={0}
      disabled={disabled}
      onPreview={(value) =>
        model.preview((target) => gapPatch(target, axis, formatLength(value, "px")), targets)
      }
      onCommit={(input) => {
        const value =
          input.kind === "length"
            ? formatLength(Math.max(0, input.value), input.unit)
            : input.keyword === "normal" || input.keyword === "none"
              ? null
              : undefined;
        if (value !== undefined)
          void model.commit((target) => gapPatch(target, axis, value), targets);
      }}
    />
  );
  return (
    <div className="flex min-w-0 gap-2">
      <AlignmentGrid
        state={alignment}
        column={column}
        disabled={disabled}
        onPick={(cell) =>
          void model.commit(
            (target) =>
              alignmentPatch(
                target.computed["flex-direction"],
                cell,
                readAlignment({
                  direction: target.computed["flex-direction"],
                  justifyContent: target.computed["justify-content"],
                  alignItems: target.computed["align-items"],
                }),
              ),
            targets,
          )
        }
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {gapField("main")}
        {wrap === true ? gapField("cross") : null}
        <PaddingRows model={model} targets={targets} dense />
      </div>
    </div>
  );
}

const GRID_POSITIONS: readonly GridPosition[] = ["start", "center", "end"];
const VERTICAL_KEYS = {
  start: "workspace:canvasInspectorTop",
  center: "workspace:canvasInspectorMiddle",
  end: "workspace:canvasInspectorBottom",
} as const;
const HORIZONTAL_KEYS = {
  start: "workspace:canvasInspectorLeft",
  center: "workspace:canvasInspectorCenter",
  end: "workspace:canvasInspectorRight",
} as const;

/**
 * The 3×3 alignment pad. Active cells show a bar along the cross axis; with space-between
 * the bars span the main axis, and with baseline alignment they sit on a shared baseline.
 */
function AlignmentGrid({
  state,
  column,
  disabled,
  onPick,
}: {
  state: AlignmentState | null;
  column: boolean;
  disabled: boolean;
  onPick: (cell: { x: GridPosition; y: GridPosition }) => void;
}) {
  const { t } = useTranslation();
  const baseline = state !== null && (column ? state.x : state.y) === "baseline";
  return (
    <div
      role="group"
      aria-label={t("workspace:canvasInspectorAlignment")}
      data-variant={baseline ? "baseline" : undefined}
      // On the fields' soft fill and radius, like the inputs beside it.
      className="grid h-15.5 w-16 shrink-0 grid-cols-3 grid-rows-3 rounded-sm bg-[var(--color-background-button-secondary)] p-0.5"
    >
      {GRID_POSITIONS.map((y) =>
        GRID_POSITIONS.map((x) => {
          const active = state !== null && isAlignmentCell(state, x, y);
          return (
            <button
              key={`${x}-${y}`}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              aria-label={t("workspace:canvasInspectorAlignCell", {
                vertical: t(VERTICAL_KEYS[y]),
                horizontal: t(HORIZONTAL_KEYS[x]),
              })}
              className={cn(
                "flex justify-center rounded-[calc(var(--radius-sm)-2px)] outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none",
                active && baseline ? "items-end pb-1" : "items-center",
              )}
              onClick={() => onPick({ x, y })}
            >
              <span
                className={cn(
                  "rounded-full transition-[width,height,background-color] duration-150 motion-reduce:transition-none",
                  active
                    ? cn(
                        "bg-foreground",
                        baseline ? "h-0.5 w-2.5" : column ? "h-1 w-2.5" : "h-2.5 w-1",
                      )
                    : "size-1 bg-muted-foreground/45",
                )}
              />
            </button>
          );
        }),
      )}
    </div>
  );
}

// ── Padding ──────────────────────────────────────────────────────────────

function PaddingRows({
  model,
  targets,
  dense = false,
}: {
  model: InspectorModel;
  targets: readonly InspectorTarget[];
  dense?: boolean;
}) {
  const { t } = useTranslation();
  const sides = (target: InspectorTarget) =>
    Object.fromEntries(
      SIDES.map((side) => [side, pxOf(target.computed[`padding-${side}`])]),
    ) as Record<(typeof SIDES)[number], number>;
  const asymmetric = targets.some((target) => {
    const value = sides(target);
    return value.left !== value.right || value.top !== value.bottom;
  });
  const [individual, setIndividual] = useState(asymmetric);
  const merge = (read: (target: InspectorTarget) => number) =>
    mixedNumber(mergeValues(targets.map(read)));
  const pair = (a: "left" | "top", b: "right" | "bottom") =>
    merge((target) => {
      const value = sides(target);
      return value[a] === value[b] ? value[a] : Number.NaN;
    });
  const write = (properties: readonly string[], input: CssInput) => {
    const value =
      input.kind === "length" ? formatLength(Math.max(0, input.value), input.unit) : null;
    if (input.kind === "keyword" && input.keyword !== "none" && input.keyword !== "auto") return;
    void model.commit(Object.fromEntries(properties.map((property) => [property, value])), targets);
  };
  const field = (
    properties: readonly string[],
    icon: string,
    ariaLabel: string,
    number: { value: number | null; mixed: boolean },
  ) => (
    <InspectorNumberField
      label={<InspectorIcon name={icon} />}
      ariaLabel={ariaLabel}
      {...number}
      min={0}
      disabled={model.readOnly}
      onPreview={(value) =>
        model.preview(
          Object.fromEntries(properties.map((property) => [property, `${value}px`])),
          targets,
        )
      }
      onCommit={(input) => write(properties, input)}
    />
  );
  const side = (name: (typeof SIDES)[number]) => merge((target) => sides(target)[name]);
  return (
    <div className="flex min-w-0 flex-col">
      <InspectorRow
        dense={dense}
        trailing={
          <InspectorToggle
            label={t("workspace:canvasInspectorIndividualPadding")}
            pressed={individual}
            onPressedChange={setIndividual}
          >
            <InspectorIcon name="arrows-all-sides" />
          </InspectorToggle>
        }
      >
        {field(
          ["padding-left", "padding-right"],
          "arrow-left-right",
          t("workspace:canvasInspectorPaddingHorizontal"),
          pair("left", "right"),
        )}
        {field(
          ["padding-top", "padding-bottom"],
          "arrow-top-bottom",
          t("workspace:canvasInspectorPaddingVertical"),
          pair("top", "bottom"),
        )}
      </InspectorRow>
      <InspectorExpand open={individual} dense={dense}>
        <InspectorRow dense={dense}>
          {field(
            ["padding-left"],
            "arrow-wall-left",
            t("workspace:canvasInspectorPaddingLeft"),
            side("left"),
          )}
          {field(
            ["padding-top"],
            "arrow-wall-up",
            t("workspace:canvasInspectorPaddingTop"),
            side("top"),
          )}
        </InspectorRow>
        <InspectorRow dense={dense}>
          {field(
            ["padding-right"],
            "arrow-wall-right",
            t("workspace:canvasInspectorPaddingRight"),
            side("right"),
          )}
          {field(
            ["padding-bottom"],
            "arrow-wall-down",
            t("workspace:canvasInspectorPaddingBottom"),
            side("bottom"),
          )}
        </InspectorRow>
      </InspectorExpand>
    </div>
  );
}
