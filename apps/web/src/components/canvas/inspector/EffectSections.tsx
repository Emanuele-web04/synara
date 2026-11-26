// FILE: EffectSections.tsx
// Purpose: Inspector Shadow, Inner shadow and Filters sections: shadow lists
//          (box shadows or drop-shadow filters; text shadows on text), inset shadows, and the
//          Layer and Backdrop filter stacks.
// Layer: Canvas editor UI
// Depends on: inspectorValues shadow and filter rules, ColorField, dnd-kit list.

import { useState, type ReactNode } from "react";
import { useTranslation } from "~/i18n";
import { AddPlusIcon, EllipsisIcon, MinusIcon } from "~/lib/icons";
import { IconButton } from "../../ui/icon-button";
import { Menu, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../ui/popover";
import { ColorField } from "./ColorField";
import {
  FieldLetter,
  INSPECTOR_FIELD_CLASS_NAME,
  InspectorIcon,
  InspectorMixedRow,
  InspectorNumberField,
  InspectorPropertyRow,
  InspectorRow,
  InspectorSection,
  InspectorSelect,
  InspectorSortableList,
  InspectorSubheader,
} from "./InspectorControls";
import {
  DEFAULT_SHADOW,
  defaultFilter,
  FILTER_TYPES,
  FILTER_UNITS,
  formatFilterList,
  formatNumber,
  formatTextShadow,
  isDropShadowFilter,
  joinBoxShadows,
  moveItem,
  parseBoxShadow,
  parseFilterList,
  replaceFilterGroup,
  splitBoxShadows,
  toCssColor,
  type FilterEntry,
  type FilterType,
  type Shadow,
  type StylePatch,
} from "./inspectorValues";
import { frameRootOf } from "./StyleSections";
import { resolveCssColor, type InspectorModel, type InspectorTarget } from "./useInspectorModel";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";

/** Text-only layers take text shadows. */
const isTextLayer = (target: InspectorTarget) =>
  !target.isFrame && target.hasText && !target.container;

/** Shadow colours are written as hex, as the rest of the inspector writes colours. */
function normalizeShadow(shadow: Shadow): Shadow {
  const rgba = resolveCssColor(shadow.color);
  return { ...shadow, color: rgba ? toCssColor(rgba) : shadow.color };
}

const sameList = <T,>(lists: readonly (readonly T[])[]) =>
  lists.every((list) => JSON.stringify(list) === JSON.stringify(lists[0]));

function shadowSummary(shadow: Shadow): string {
  const alpha = resolveCssColor(shadow.color)?.a ?? 1;
  return `${formatNumber(shadow.x)} ${formatNumber(shadow.y)} ${formatNumber(shadow.blur)} · ${Math.round(alpha * 100)}%`;
}

// ── Shadow ───────────────────────────────────────────────────────────────

/** A shadow: a box shadow, a drop-shadow filter, or (on text) a text shadow. */
type ShadowType = "box" | "drop" | "text";
type ShadowEntry = { shadow: Shadow; type: ShadowType };

function dropFiltersOf(target: InspectorTarget): Shadow[] {
  return parseFilterList(target.computed.filter).flatMap((entry) =>
    entry.kind === "drop-shadow" ? [normalizeShadow(entry.shadow)] : [],
  );
}

function shadowEntriesOf(target: InspectorTarget): ShadowEntry[] {
  if (isTextLayer(target))
    return parseBoxShadow(target.computed["text-shadow"]).map((shadow) => ({
      shadow: normalizeShadow({ ...shadow, spread: 0, inset: false }),
      type: "text",
    }));
  return [
    ...splitBoxShadows(target.computed["box-shadow"]).drop.map((shadow) => ({
      shadow: normalizeShadow(shadow),
      type: "box" as const,
    })),
    ...dropFiltersOf(target).map((shadow) => ({ shadow, type: "drop" as const })),
  ];
}

/** Writes `entries` to a target, as text shadows, box shadows or drop-shadow filters. */
function shadowEntriesPatch(target: InspectorTarget, entries: readonly ShadowEntry[]): StylePatch {
  if (isTextLayer(target))
    return { "text-shadow": formatTextShadow(entries.map((entry) => entry.shadow)) };
  const inner = splitBoxShadows(target.computed["box-shadow"]).inner.map(normalizeShadow);
  const box = entries.filter((entry) => entry.type !== "drop").map((entry) => entry.shadow);
  const drops: FilterEntry[] = entries
    .filter((entry) => entry.type === "drop")
    .map((entry) => ({ kind: "drop-shadow", shadow: entry.shadow }));
  const filters = parseFilterList(target.computed.filter);
  const nextFilters = replaceFilterGroup(filters, isDropShadowFilter, drops);
  return {
    "box-shadow": joinBoxShadows(inner, box),
    ...(filters.some(isDropShadowFilter) || drops.length > 0
      ? { filter: formatFilterList(nextFilters) }
      : {}),
  };
}

const SHADOW_LABEL_KEYS: Record<ShadowType, string> = {
  box: "workspace:canvasInspectorBoxShadow",
  drop: "workspace:canvasInspectorDropShadow",
  text: "workspace:canvasInspectorTextShadow",
};

export function ShadowSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const { targets, readOnly } = model;
  const lists = targets.map(shadowEntriesOf);
  const mixed = !sameList(lists);
  const shared = mixed ? [] : (lists[0] ?? []);
  const empty = lists.every((list) => list.length === 0);
  const textOnly = targets.length > 0 && targets.every(isTextLayer);
  const type: ShadowType | null = textOnly
    ? "text"
    : shared.length > 0 && shared.every((entry) => entry.type === "drop")
      ? "drop"
      : shared.length > 0 && shared.every((entry) => entry.type === "box")
        ? "box"
        : null;
  const commit = (next: readonly ShadowEntry[]) =>
    void model.commit((target) => shadowEntriesPatch(target, next));
  const preview = (next: readonly ShadowEntry[]) =>
    model.preview((target) => shadowEntriesPatch(target, next));
  const add = () => {
    if (mixed) return commit(lists[0] ?? []);
    commit([{ shadow: DEFAULT_SHADOW, type: type ?? "box" }, ...shared]);
  };
  const replace = (index: number, change: Partial<Shadow>) =>
    shared.map((entry, at) =>
      at === index ? { ...entry, shadow: { ...entry.shadow, ...change } } : entry,
    );
  return (
    <InspectorSection
      title={t("workspace:canvasInspectorShadow")}
      empty={empty}
      disabled={readOnly}
      onAdd={add}
      headerAction={
        <>
          {textOnly ? null : (
            <Menu>
              <MenuTrigger
                render={
                  <IconButton
                    label={t("workspace:canvasInspectorShadowType")}
                    tooltip={t("workspace:canvasInspectorShadowType")}
                    size="icon-xs"
                  >
                    <EllipsisIcon className="size-3.5" />
                  </IconButton>
                }
              />
              <ComposerPickerMenuPopup align="end">
                <MenuRadioGroup
                  value={type ?? ""}
                  onValueChange={(next) => {
                    if (next === "box" || next === "drop")
                      commit(shared.map((entry) => ({ ...entry, type: next })));
                  }}
                >
                  <MenuRadioItem closeOnClick value="box">
                    {t("workspace:canvasInspectorBoxShadow")}
                  </MenuRadioItem>
                  <MenuRadioItem closeOnClick value="drop">
                    {t("workspace:canvasInspectorDropShadow")}
                  </MenuRadioItem>
                </MenuRadioGroup>
              </ComposerPickerMenuPopup>
            </Menu>
          )}
          <IconButton
            label={t("workspace:canvasInspectorAddShadow")}
            tooltip={t("workspace:canvasInspectorAddShadow")}
            size="icon-xs"
            onClick={add}
          >
            <AddPlusIcon className="size-3.5" />
          </IconButton>
        </>
      }
    >
      {mixed ? (
        <InspectorMixedRow
          label={t("workspace:canvasInspectorMixedShadows")}
          disabled={readOnly}
          onReplace={() => commit(lists[0] ?? [])}
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          {shared.map((entry, index) => (
            <ShadowRow
              // Shadows are positional, like the CSS list they come from.
              // oxlint-disable-next-line no-array-index-key
              key={index}
              model={model}
              shadow={entry.shadow}
              title={t(SHADOW_LABEL_KEYS[entry.type])}
              spread={entry.type === "box"}
              onPreview={(change) => preview(replace(index, change))}
              onCommit={(change) => commit(replace(index, change))}
              onRemove={() => commit(shared.filter((_, at) => at !== index))}
            />
          ))}
        </div>
      )}
    </InspectorSection>
  );
}

// ── Inner shadow ─────────────────────────────────────────────────────────

/** Inner shadow is shown for everything but text-only layers. */
const innerShadowTargets = (model: InspectorModel) =>
  model.targets.filter((target) => !isTextLayer(target));

const innerShadowsOf = (target: InspectorTarget) =>
  splitBoxShadows(target.computed["box-shadow"]).inner.map(normalizeShadow);

export function InnerShadowSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const targets = innerShadowTargets(model);
  if (targets.length === 0) return null;
  const lists = targets.map(innerShadowsOf);
  const mixed = !sameList(lists);
  const shared = mixed ? [] : (lists[0] ?? []);
  const empty = lists.every((list) => list.length === 0);
  const patch = (target: InspectorTarget, inner: readonly Shadow[]): StylePatch => ({
    "box-shadow": joinBoxShadows(
      inner,
      splitBoxShadows(target.computed["box-shadow"]).drop.map(normalizeShadow),
    ),
  });
  const commit = (next: readonly Shadow[]) =>
    void model.commit((target) => patch(target, next), targets);
  const preview = (next: readonly Shadow[]) =>
    model.preview((target) => patch(target, next), targets);
  const add = () => {
    if (mixed) return commit(lists[0] ?? []);
    commit([{ ...DEFAULT_SHADOW, inset: true }, ...shared]);
  };
  const replace = (index: number, change: Partial<Shadow>) =>
    shared.map((shadow, at) => (at === index ? { ...shadow, ...change } : shadow));
  return (
    <InspectorSection
      title={t("workspace:canvasInspectorInnerShadow")}
      empty={empty}
      disabled={model.readOnly}
      onAdd={add}
      headerAction={
        <IconButton
          label={t("workspace:canvasInspectorAddInnerShadow")}
          tooltip={t("workspace:canvasInspectorAddInnerShadow")}
          size="icon-xs"
          onClick={add}
        >
          <AddPlusIcon className="size-3.5" />
        </IconButton>
      }
    >
      {mixed ? (
        <InspectorMixedRow
          label={t("workspace:canvasInspectorMixedInnerShadows")}
          disabled={model.readOnly}
          onReplace={() => commit(lists[0] ?? [])}
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          {shared.map((shadow, index) => (
            <ShadowRow
              // oxlint-disable-next-line no-array-index-key
              key={index}
              model={model}
              shadow={shadow}
              title={t("workspace:canvasInspectorInnerShadow")}
              spread
              onPreview={(change) => preview(replace(index, change))}
              onCommit={(change) => commit(replace(index, change))}
              onRemove={() => commit(shared.filter((_, at) => at !== index))}
            />
          ))}
        </div>
      )}
    </InspectorSection>
  );
}

/** One shadow: a summary row that opens X, Y, blur, spread and colour. */
function ShadowRow({
  model,
  shadow,
  title,
  spread,
  onPreview,
  onCommit,
  onRemove,
}: {
  model: InspectorModel;
  shadow: Shadow;
  title: string;
  /** Box shadows spread; drop-shadow filters and text shadows cannot. */
  spread: boolean;
  onPreview: (change: Partial<Shadow>) => void;
  onCommit: (change: Partial<Shadow>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const field = (
    key: "x" | "y" | "blur" | "spread",
    label: ReactNode,
    ariaLabel: string,
    min?: number,
  ) => (
    <InspectorNumberField
      label={label}
      ariaLabel={ariaLabel}
      value={shadow[key]}
      {...(min === undefined ? {} : { min })}
      disabled={model.readOnly}
      onPreview={(value) => onPreview({ [key]: value })}
      onCommit={(input) => {
        if (input.kind === "length")
          onCommit({ [key]: min === undefined ? input.value : Math.max(min, input.value) });
      }}
    />
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <InspectorPropertyRow
        active={open}
        disabled={model.readOnly}
        removeLabel={t("workspace:canvasInspectorRemove", { name: title })}
        onRemove={onRemove}
      >
        <PopoverTrigger className="flex h-full min-w-0 flex-1 items-center gap-2 text-start outline-none">
          <span
            aria-hidden
            className="size-4 shrink-0 rounded-sm bg-background"
            style={{
              boxShadow: `inset 0 0 0 1px rgb(0 0 0 / 0.08), ${shadow.inset ? "inset " : ""}0 1px 2px ${shadow.color}`,
            }}
          />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <span className="shrink-0 text-ui-xs text-muted-foreground tabular-nums">
            {shadowSummary(shadow)}
          </span>
        </PopoverTrigger>
      </InspectorPropertyRow>
      <PopoverPopup side="left" align="start" sideOffset={12}>
        <div className="flex w-56 flex-col gap-1.5">
          <PopoverTitle className="pb-0.5 text-ui-xs font-semibold">{title}</PopoverTitle>
          <InspectorRow label={t("workspace:canvasInspectorShadowOffset")}>
            {field(
              "x",
              <FieldLetter>{t("workspace:canvasInspectorAxisX")}</FieldLetter>,
              t("workspace:canvasInspectorShadowX"),
            )}
            {field(
              "y",
              <FieldLetter>{t("workspace:canvasInspectorAxisY")}</FieldLetter>,
              t("workspace:canvasInspectorShadowY"),
            )}
          </InspectorRow>
          <InspectorRow label={t("workspace:canvasInspectorShadowBlur")}>
            {field(
              "blur",
              <InspectorIcon name="drop" />,
              t("workspace:canvasInspectorShadowBlur"),
              0,
            )}
            {spread
              ? field(
                  "spread",
                  <InspectorIcon name="arrows-all-sides" />,
                  t("workspace:canvasInspectorShadowSpread"),
                )
              : null}
          </InspectorRow>
          <InspectorRow label={t("workspace:canvasInspectorColor")} columns={1}>
            <ColorField
              value={shadow.color}
              ariaLabel={t("workspace:canvasInspectorShadowColor")}
              disabled={model.readOnly}
              frameRoot={frameRootOf(model)}
              onPreview={(color) => onPreview({ color })}
              onCommit={(color) => onCommit({ color })}
            />
          </InspectorRow>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────

const FILTER_KEYS: Record<FilterType, string> = {
  blur: "workspace:canvasInspectorFilterBlur",
  brightness: "workspace:canvasInspectorFilterBrightness",
  contrast: "workspace:canvasInspectorFilterContrast",
  grayscale: "workspace:canvasInspectorFilterGrayscale",
  "hue-rotate": "workspace:canvasInspectorFilterHueRotate",
  invert: "workspace:canvasInspectorFilterInvert",
  saturate: "workspace:canvasInspectorFilterSaturate",
  sepia: "workspace:canvasInspectorFilterSepia",
};

type FilterGroup = "layer" | "backdrop";

/** A group's entries: layer filters leave drop shadows to the Shadow section. */
function filterGroupOf(target: InspectorTarget, group: FilterGroup): FilterEntry[] {
  return group === "layer"
    ? parseFilterList(target.computed.filter).filter((entry) => !isDropShadowFilter(entry))
    : parseFilterList(target.computed["backdrop-filter"]);
}

function filterGroupPatch(
  target: InspectorTarget,
  group: FilterGroup,
  next: readonly FilterEntry[],
): StylePatch {
  if (group === "backdrop")
    return { "-webkit-backdrop-filter": null, "backdrop-filter": formatFilterList(next) };
  const current = parseFilterList(target.computed.filter);
  return {
    filter: formatFilterList(
      replaceFilterGroup(current, (entry) => !isDropShadowFilter(entry), next),
    ),
  };
}

export function FiltersSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const layerLists = model.targets.map((target) => filterGroupOf(target, "layer"));
  const backdropLists = model.targets.map((target) => filterGroupOf(target, "backdrop"));
  const empty = [...layerLists, ...backdropLists].every((list) => list.length === 0);
  const addLayer = () =>
    void model.commit((target) =>
      filterGroupPatch(target, "layer", [defaultFilter("blur"), ...filterGroupOf(target, "layer")]),
    );
  return (
    <InspectorSection
      title={t("workspace:canvasInspectorFilters")}
      empty={empty}
      disabled={model.readOnly}
      onAdd={addLayer}
    >
      <FilterGroupRows model={model} group="layer" lists={layerLists} />
      <FilterGroupRows model={model} group="backdrop" lists={backdropLists} />
    </InspectorSection>
  );
}

function FilterGroupRows({
  model,
  group,
  lists,
}: {
  model: InspectorModel;
  group: FilterGroup;
  lists: readonly FilterEntry[][];
}) {
  const { t } = useTranslation();
  const disabled = model.readOnly;
  const mixed = !sameList(lists);
  const shared = mixed ? [] : (lists[0] ?? []);
  const title = t(
    group === "layer"
      ? "workspace:canvasInspectorFiltersLayer"
      : "workspace:canvasInspectorFiltersBackdrop",
  );
  const commit = (next: readonly FilterEntry[]) =>
    void model.commit((target) => filterGroupPatch(target, group, next));
  const preview = (next: readonly FilterEntry[]) =>
    model.preview((target) => filterGroupPatch(target, group, next));
  const add = () => commit(mixed ? (lists[0] ?? []) : [defaultFilter("blur"), ...shared]);
  const replace = (index: number, entry: FilterEntry) =>
    shared.map((item, at) => (at === index ? entry : item));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <InspectorSubheader title={title} dimmed={!mixed && shared.length === 0}>
        {disabled ? null : (
          <IconButton
            label={t("workspace:canvasInspectorAdd", { name: title })}
            tooltip={t("workspace:canvasInspectorAdd", { name: title })}
            onClick={add}
          >
            <AddPlusIcon />
          </IconButton>
        )}
      </InspectorSubheader>
      {mixed ? (
        <InspectorMixedRow
          label={t(
            group === "layer"
              ? "workspace:canvasInspectorMixedFilters"
              : "workspace:canvasInspectorMixedBackdropFilters",
          )}
          disabled={disabled}
          onReplace={() => commit(lists[0] ?? [])}
        />
      ) : shared.length > 0 ? (
        <InspectorSortableList
          ids={shared.map((_, index) => `${group}-${index}`)}
          reorderLabel={(index) =>
            t("workspace:canvasInspectorReorderFilter", { number: index + 1 })
          }
          disabled={disabled}
          onReorder={(from, to) => commit(moveItem(shared, from, to))}
        >
          {(index) => (
            <FilterRow
              entry={shared[index]!}
              disabled={disabled}
              onPreview={(entry) => preview(replace(index, entry))}
              onCommit={(entry) => commit(replace(index, entry))}
              onRemove={() => commit(shared.filter((_, at) => at !== index))}
            />
          )}
        </InspectorSortableList>
      ) : null}
    </div>
  );
}

function FilterRow({
  entry,
  disabled,
  onPreview,
  onCommit,
  onRemove,
}: {
  entry: FilterEntry;
  disabled: boolean;
  onPreview: (entry: FilterEntry) => void;
  onCommit: (entry: FilterEntry) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const remove = disabled ? null : (
    <IconButton
      label={t("workspace:canvasInspectorRemoveFilter")}
      tooltip={t("workspace:canvasInspectorRemoveFilter")}
      size="icon-xs"
      onClick={onRemove}
    >
      <MinusIcon className="size-3.5" />
    </IconButton>
  );
  if (entry.kind !== "filter")
    return (
      <div className="flex min-w-0 items-center gap-0.5">
        <span
          className={`${INSPECTOR_FIELD_CLASS_NAME} flex-1 truncate font-chat-code text-ui-xs text-muted-foreground`}
          title={entry.kind === "other" ? entry.value : undefined}
        >
          {entry.kind === "other" ? entry.value : t("workspace:canvasInspectorDropShadow")}
        </span>
        {remove}
      </div>
    );
  const unit = entry.unit;
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
        <InspectorSelect<FilterType>
          ariaLabel={t("workspace:canvasInspectorFilterType")}
          value={entry.type}
          disabled={disabled}
          options={FILTER_TYPES.map((type) => ({ value: type, label: t(FILTER_KEYS[type]) }))}
          onChange={(type) => onCommit(defaultFilter(type))}
        />
        <InspectorNumberField
          ariaLabel={t("workspace:canvasInspectorFilterAmount", {
            name: t(FILTER_KEYS[entry.type]),
          })}
          suffix={unit === "deg" ? "°" : unit}
          value={entry.amount}
          unit={unit}
          min={entry.type === "hue-rotate" ? -3600 : 0}
          max={entry.type === "blur" ? 1000 : entry.type === "hue-rotate" ? 3600 : 1000}
          disabled={disabled}
          onPreview={(amount) => onPreview({ ...entry, amount })}
          onCommit={(input) => {
            if (input.kind !== "length") return;
            const allowed = entry.type === "blur" ? ["px", "em"] : [FILTER_UNITS[entry.type]];
            if (!allowed.includes(input.unit)) return;
            const amount = entry.type === "hue-rotate" ? input.value : Math.max(0, input.value);
            onCommit({ ...entry, amount, unit: input.unit });
          }}
        />
      </div>
      {remove}
    </div>
  );
}
