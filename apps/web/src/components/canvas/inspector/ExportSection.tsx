// FILE: ExportSection.tsx
// Purpose: The inspector's Export section: rows saved on each selected node (size, format,
//          suffix, PDF quality), the copy menu, Export, and Export combined PDF.
// Layer: Canvas editor UI
// Exports: ExportSection

import type { CanvasExportEntry, CanvasExportFormat } from "@synara/contracts";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "~/i18n";
import { canEncodeAvif } from "~/lib/canvasExport";
import {
  EXPORT_SCALE_PRESETS,
  addExportEntry,
  exportRowsState,
  normalizeExportSuffix,
  parseExportScale,
  preferredExportFormat,
  rememberExportFormat,
  stepExportScale,
  withExportFormat,
  withExportScale,
  type CanvasExportQuality,
} from "~/lib/canvasExportSettings";
import { AddPlusIcon, ChevronDownIcon, CopyIcon, EllipsisIcon, MinusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import { ShortcutKbd } from "../../ui/kbd";
import { Menu, MenuItem, MenuSeparator, MenuShortcut, MenuTrigger } from "../../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../ui/popover";
import { Spinner } from "../../ui/spinner";
import { toastManager } from "../../ui/toast";
import { selectionKey } from "../canvasStores";
import { exportEntriesOf, makeCanvasExportActions } from "../editor/canvasSelectionExport";
import {
  INSPECTOR_FIELD_CLASS_NAME,
  INSPECTOR_INPUT_CLASS_NAME,
  InspectorMixedRow,
  InspectorRow,
  InspectorSection,
  InspectorSelect,
} from "./InspectorControls";
import { canvasShortcutLabelFor } from "../editor/canvasShortcuts";
import { selectionName, type InspectorModel } from "./useInspectorModel";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";

const FORMAT_LABELS: Record<CanvasExportFormat, string> = {
  png: "PNG",
  jpg: "JPG",
  avif: "AVIF",
  webp: "WebP",
  pdf: "PDF",
};

export function ExportSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const { editor, readOnly } = model;
  const items = useMemo(() => model.targets.map((target) => target.item), [model.targets]);
  const lists = items.map((item) => exportEntriesOf(editor, item));
  const state = exportRowsState(lists);
  const actions = useMemo(() => makeCanvasExportActions(editor, t), [editor, t]);
  const [pending, setPending] = useState<"files" | "pdf" | null>(null);
  const avif = useAvifSupport();

  /** Writes each node's rows; an empty list removes them, and the section dims. */
  const save = (next: (current: readonly CanvasExportEntry[]) => readonly CanvasExportEntry[]) =>
    void editor.run({
      kind: "exports",
      settings: items.map((item) => {
        const entries = next(exportEntriesOf(editor, item) ?? []);
        return { key: selectionKey(item), entries: entries.length > 0 ? entries : null };
      }),
    });
  // Editing a row rewrites the whole list on every selected node.
  const shared = state.kind === "rows" ? state.entries : [];
  const replaceRow = (index: number, entry: CanvasExportEntry) =>
    save(() => shared.map((row, at) => (at === index ? entry : row)));
  const add = () => {
    if (state.kind === "mixed") save(() => state.first);
    else save((current) => addExportEntry(current, preferredExportFormat()));
  };
  const run = async (kind: "files" | "pdf", task: () => Promise<unknown>) => {
    if (pending) return;
    setPending(kind);
    try {
      await task();
    } finally {
      setPending(null);
    }
  };
  const single = items.length === 1 ? items[0]! : null;
  const formats = (Object.keys(FORMAT_LABELS) as CanvasExportFormat[])
    .filter((format) => format !== "avif" || avif || shared.some((row) => row.format === "avif"))
    .map((format) => ({ value: format, label: FORMAT_LABELS[format] }));
  const hasPdf = lists.some((list) => list?.some((entry) => entry.format === "pdf"));

  const copyMenu = (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            label={t("workspace:canvasCopyMenu")}
            tooltip={t("workspace:canvasCopyMenu")}
            size="icon-xs"
          >
            <CopyIcon className="size-3.5" />
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup align="end" size="small">
        <MenuItem onClick={() => void actions.copyPng(items)}>
          {t("workspace:canvasCopyPng")}
          <MenuShortcut>{canvasShortcutLabelFor({ id: "copy-png" })}</MenuShortcut>
        </MenuItem>
        {single ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => void actions.copyCode(single, "tailwind")}>
              {t("workspace:canvasCopyTailwind")}
              <MenuShortcut>
                {canvasShortcutLabelFor({ id: "copy-code", format: "tailwind" })}
              </MenuShortcut>
            </MenuItem>
            <MenuItem onClick={() => void actions.copyCode(single, "css")}>
              {t("workspace:canvasCopyReact")}
              <MenuShortcut>
                {canvasShortcutLabelFor({ id: "copy-code", format: "css" })}
              </MenuShortcut>
            </MenuItem>
          </>
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
  const name = selectionName(model);

  return (
    <InspectorSection
      title={t("workspace:canvasExportSection")}
      empty={state.kind === "empty"}
      disabled={readOnly}
      onAdd={add}
      headerMenu={copyMenu}
      headerAction={
        <IconButton
          label={t("workspace:canvasExportAddEntry")}
          tooltip={t("workspace:canvasExportAddEntry")}
          size="icon-xs"
          onClick={add}
        >
          <AddPlusIcon className="size-3.5" />
        </IconButton>
      }
    >
      <div className="-mt-1 flex flex-col gap-1">
        {state.kind === "mixed" ? (
          <InspectorMixedRow
            label={t("workspace:canvasExportMixed")}
            disabled={readOnly}
            onReplace={add}
          />
        ) : (
          shared.map((entry, index) => (
            // Rows are positional; two rows may hold the same values.
            // oxlint-disable-next-line no-array-index-key
            <div key={index} className="flex h-6 min-w-0 items-center gap-1">
              <ExportSizeField
                scale={entry.scale}
                disabled={readOnly || entry.format === "pdf"}
                onCommit={(scale) => replaceRow(index, withExportScale(entry, scale))}
              />
              <InspectorSelect
                ariaLabel={t("workspace:canvasExportFormat")}
                className="w-16 shrink-0"
                value={entry.format}
                options={formats}
                disabled={readOnly}
                onChange={(format) => {
                  rememberExportFormat(format);
                  replaceRow(index, withExportFormat(entry, format));
                }}
              />
              <ExportRowSettings
                entry={entry}
                disabled={readOnly}
                onChange={(next) => replaceRow(index, next)}
              />
              <IconButton
                label={t("workspace:canvasExportRemoveEntry")}
                tooltip={t("workspace:canvasExportRemoveEntry")}
                size="icon-xs"
                disabled={readOnly}
                onClick={() => save(() => shared.filter((_, at) => at !== index))}
              >
                <MinusIcon className="size-3.5" />
              </IconButton>
            </div>
          ))
        )}
        <Button
          size="xs"
          variant="secondary"
          className="mt-1 w-full"
          disabled={pending !== null}
          onClick={() => void run("files", () => actions.exportFiles(items))}
        >
          {pending === "files" ? <Spinner className="size-3.5" /> : null}
          <span className="truncate">
            {name !== null
              ? t("workspace:canvasExportNamed", { name })
              : t("workspace:canvasExportElements", { count: items.length })}
          </span>
          {name !== null ? (
            <ShortcutKbd
              shortcutLabel={canvasShortcutLabelFor({ id: "export-files" }) ?? ""}
              className="shrink-0"
            />
          ) : null}
        </Button>
        {items.length > 1 && hasPdf ? (
          <Button
            size="xs"
            variant="ghost"
            className="w-full"
            disabled={pending !== null}
            onClick={() => void run("pdf", () => actions.exportCombinedPdf(items))}
          >
            {pending === "pdf" ? <Spinner className="size-3.5" /> : null}
            <span className="truncate">{t("workspace:canvasExportCombinedPdf")}</span>
          </Button>
        ) : null}
      </div>
    </InspectorSection>
  );
}

function useAvifSupport() {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    void canEncodeAvif().then((value) => {
      if (live) setSupported(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return supported;
}

/** The Size field: free text with x, w, h and p units, arrow steps and a preset menu. */
function ExportSizeField({
  scale,
  disabled,
  onCommit,
}: {
  scale: string;
  disabled: boolean;
  onCommit: (scale: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string) => {
    setDraft(null);
    const parsed = parseExportScale(text);
    if ("error" in parsed) {
      if (parsed.error === "zero")
        toastManager.add({ type: "error", title: t("workspace:canvasExportScaleZero") });
      return;
    }
    if (parsed.scale !== scale) onCommit(parsed.scale);
  };
  return (
    <div
      className={cn(INSPECTOR_FIELD_CLASS_NAME, "flex-1 pe-0.5")}
      data-disabled={disabled ? "" : undefined}
    >
      <input
        aria-label={t("workspace:canvasExportSize")}
        className={INSPECTOR_INPUT_CLASS_NAME}
        disabled={disabled}
        value={draft ?? scale}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          if (draft !== null) commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(event.currentTarget.value);
          } else if (event.key === "Escape") {
            setDraft(null);
            event.currentTarget.blur();
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            commit(stepExportScale(draft ?? scale, event.key === "ArrowUp" ? 1 : -1));
          }
        }}
      />
      <Menu>
        <MenuTrigger
          disabled={disabled}
          render={
            <IconButton
              label={t("workspace:canvasExportSizePresets")}
              tooltip={t("workspace:canvasExportSizePresets")}
              size="chip"
              className="shrink-0"
            >
              <ChevronDownIcon />
            </IconButton>
          }
        />
        <ComposerPickerMenuPopup align="start" size="small">
          {EXPORT_SCALE_PRESETS.map((group, at) => (
            <Fragment key={group[0]}>
              {at > 0 ? <MenuSeparator /> : null}
              {group.map((preset) => (
                <MenuItem key={preset} onClick={() => commit(preset)}>
                  {preset}
                </MenuItem>
              ))}
            </Fragment>
          ))}
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  );
}

const QUALITIES: readonly CanvasExportQuality[] = ["high", "medium", "low"];

/** A row's settings: file suffix, colour space (display only) and PDF quality. */
function ExportRowSettings({
  entry,
  disabled,
  onChange,
}: {
  entry: CanvasExportEntry;
  disabled: boolean;
  onChange: (entry: CanvasExportEntry) => void;
}) {
  const { t } = useTranslation();
  const [suffix, setSuffix] = useState<string | null>(null);
  const commitSuffix = (text: string) => {
    setSuffix(null);
    const next = normalizeExportSuffix(text);
    if (next !== entry.suffix) onChange({ ...entry, suffix: next });
  };
  const qualityLabels: Record<CanvasExportQuality, string> = {
    high: t("workspace:canvasExportQualityHigh"),
    medium: t("workspace:canvasExportQualityMedium"),
    low: t("workspace:canvasExportQualityLow"),
  };
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        render={
          <IconButton
            label={t("workspace:canvasExportRowSettings")}
            tooltip={t("workspace:canvasExportRowSettings")}
            size="icon-xs"
          >
            <EllipsisIcon className="size-3.5" />
          </IconButton>
        }
      />
      <PopoverPopup side="left" align="start" sideOffset={12}>
        <div className="flex w-48 flex-col gap-1.5">
          <PopoverTitle className="pb-0.5 text-ui font-medium">
            {t("workspace:canvasExportSettings")}
          </PopoverTitle>
          <InspectorRow label={t("workspace:canvasExportSuffix")} columns={1}>
            <span className={INSPECTOR_FIELD_CLASS_NAME}>
              <input
                aria-label={t("workspace:canvasExportSuffix")}
                className={INSPECTOR_INPUT_CLASS_NAME}
                placeholder={t("workspace:canvasExportNoSuffix")}
                value={suffix ?? entry.suffix}
                maxLength={60}
                onChange={(event) => setSuffix(event.target.value)}
                onBlur={(event) => {
                  if (suffix !== null) commitSuffix(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitSuffix(event.currentTarget.value);
                }}
              />
            </span>
          </InspectorRow>
          <InspectorRow label={t("workspace:canvasExportColorSpace")} columns={1}>
            <span className={INSPECTOR_FIELD_CLASS_NAME} data-disabled="">
              {entry.format === "pdf" ? "sRGB" : "Display P3"}
            </span>
          </InspectorRow>
          {entry.format === "pdf" ? (
            <InspectorRow label={t("workspace:canvasExportQuality")} columns={1}>
              <InspectorSelect
                ariaLabel={t("workspace:canvasExportQuality")}
                value={entry.quality ?? "high"}
                options={QUALITIES.map((value) => ({ value, label: qualityLabels[value] }))}
                onChange={(quality) => onChange({ ...entry, quality })}
              />
            </InspectorRow>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
