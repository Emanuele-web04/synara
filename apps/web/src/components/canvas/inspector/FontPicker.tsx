// FILE: FontPicker.tsx
// Purpose: Searchable font family picker for the canvas inspector: fonts already in the work
//          first, then the Google Fonts catalog, with Favorites (a star per family, kept
//          per viewer). Picking a catalog font downloads it into the work before the family is
//          written.
// Layer: Canvas editor UI
// Depends on: ui/combobox + PickerPanelShell (same shell as ProjectPicker), react-query.

import type { CanvasFontCatalog, CanvasFontFamily, CanvasWork } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Schema from "effect/Schema";
import { useMemo, useState, type SyntheticEvent } from "react";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTranslation } from "~/i18n";
import { CentralIcon } from "~/lib/central-icons";
import { designFontFamily, registeredFontFamily } from "~/lib/designCanvas";
import { ChevronDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { PickerPanelShell } from "../../chat/PickerPanelShell";
import { SegmentedPicker } from "../../SegmentedPicker";
import {
  PICKER_PANEL_GROUP_LABEL_CLASS_NAME,
  PICKER_PANEL_PLAIN_SEARCH_INPUT_CLASS_NAME,
  PICKER_PANEL_ROW_GEOMETRY_CLASS_NAME,
  PICKER_PANEL_ROW_SELECTED_CLASS_NAME,
} from "../../chat/pickerPanelStyles";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../../ui/combobox";
import { selectTriggerVariants } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { toastManager } from "../../ui/toast";
import { runCanvasWrite } from "../canvasWorkCache";
import { fontFamilyValue, isMixed, searchFamilies, type MaybeMixed } from "./inspectorValues";

/** Catalog results shown per search; typing narrows the rest. */
const CATALOG_LIMIT = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const FAVORITES_STORAGE_KEY = "synara.canvas.fontFavorites";
const FavoritesSchema = Schema.Array(Schema.String);

/** Keeps a press on the star from also picking the row it sits in. */
const stopRowEvent = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

export const canvasFontCatalogQueryKey = ["canvas-font-catalog"] as const;

/** The Google Fonts catalog; fetched once per session and kept. */
export function useCanvasFontCatalog(enabled = true) {
  return useQuery<CanvasFontCatalog>({
    queryKey: canvasFontCatalogQueryKey,
    queryFn: () => ensureNativeApi().canvas.fontCatalog(),
    staleTime: DAY_MS,
    gcTime: DAY_MS,
    enabled,
  });
}

/** Families whose files are already stored in the work. */
export function installedFontFamilies(work: CanvasWork): string[] {
  const families = new Set<string>();
  for (const asset of work.assets ?? [])
    if (asset.mimeType === "font/woff2") families.add(designFontFamily(asset));
  return [...families].toSorted((a, b) => a.localeCompare(b));
}

export function FontPicker({
  work,
  value,
  disabled = false,
  onApply,
}: {
  work: CanvasWork;
  /** The family as designs name it ("Inter"), or MIXED. */
  value: MaybeMixed<string> | undefined;
  disabled?: boolean;
  /** Writes the `font-family` value; called after a catalog font is installed. */
  onApply: (fontFamily: string) => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const catalog = useCanvasFontCatalog();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"fonts" | "favorites">("fonts");
  const [favorites, setFavorites] = useLocalStorage<readonly string[], readonly string[]>(
    FAVORITES_STORAGE_KEY,
    [],
    FavoritesSchema,
  );
  const favorite = (family: string) =>
    favorites.some((item) => item.toLowerCase() === family.toLowerCase());
  const toggleFavorite = (family: string) =>
    setFavorites((current) =>
      current.some((item) => item.toLowerCase() === family.toLowerCase())
        ? current.filter((item) => item.toLowerCase() !== family.toLowerCase())
        : [...current, family].toSorted((a, b) => a.localeCompare(b)),
    );

  const installed = useMemo(() => installedFontFamilies(work), [work]);
  const families = catalog.data?.families;
  const byName = useMemo(
    () => new Map((families ?? []).map((family) => [family.family.toLowerCase(), family])),
    [families],
  );
  const installedMatches = useMemo(
    () =>
      searchFamilies(
        installed.map((family) => ({ family })),
        query,
        installed.length,
      ),
    [installed, query],
  );
  const catalogMatches = useMemo(() => {
    const local = new Set(installed.map((family) => family.toLowerCase()));
    return searchFamilies(
      (families ?? []).filter((family) => !local.has(family.family.toLowerCase())),
      query,
      CATALOG_LIMIT,
    );
  }, [families, installed, query]);
  const favoriteMatches = useMemo(
    () =>
      searchFamilies(
        favorites.map((family) => byName.get(family.toLowerCase()) ?? { family, category: "" }),
        query,
        favorites.length,
      ),
    [byName, favorites, query],
  );
  const showFavorites = tab === "favorites";
  const items = useMemo(
    () =>
      showFavorites
        ? favoriteMatches.map((item) => item.family)
        : [
            ...installedMatches.map((item) => item.family),
            ...catalogMatches.map((item) => item.family),
          ],
    [catalogMatches, favoriteMatches, installedMatches, showFavorites],
  );
  const star = (family: string) => {
    const on = favorite(family);
    return (
      <span
        role="button"
        tabIndex={-1}
        aria-pressed={on}
        aria-label={t(
          on ? "workspace:canvasInspectorUnfavoriteFont" : "workspace:canvasInspectorFavoriteFont",
          { name: family },
        )}
        className={cn(
          "ms-auto flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground",
          !on && "opacity-0 group-hover/font:opacity-100 group-data-highlighted/font:opacity-100",
        )}
        onPointerDown={stopRowEvent}
        onMouseDown={stopRowEvent}
        onMouseUp={stopRowEvent}
        onClick={(event) => {
          stopRowEvent(event);
          toggleFavorite(family);
        }}
      >
        <CentralIcon name="star" variant={on ? "fill" : "reversed"} className="size-3" />
      </span>
    );
  };

  const current = value === undefined || isMixed(value) ? null : value;

  const pick = async (family: string) => {
    setOpen(false);
    setQuery("");
    setError(null);
    const entry: CanvasFontFamily | undefined = byName.get(family.toLowerCase());
    if (installed.includes(family) || !entry) {
      onApply(fontFamilyValue(family, entry?.category));
      return;
    }
    setAdding(family);
    try {
      await runCanvasWrite(client, work.id, () =>
        ensureNativeApi().canvas.addFont({ workId: work.id, family }),
      );
      onApply(fontFamilyValue(family, entry.category));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : undefined;
      setError(t("workspace:canvasInspectorFontFailed", { name: family }));
      toastManager.add({
        type: "error",
        title: t("workspace:canvasInspectorFontFailed", { name: family }),
        description: message,
      });
    } finally {
      setAdding(null);
    }
  };

  const busy = adding !== null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Combobox
        items={items}
        filteredItems={items}
        filter={null}
        value={current}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery("");
            setTab("fonts");
          }
        }}
        inputValue={query}
        onInputValueChange={setQuery}
        onValueChange={(next) => {
          if (typeof next === "string" && next !== current) void pick(next);
        }}
        autoHighlight
        disabled={disabled || busy}
      >
        <ComboboxTrigger
          aria-label={t("workspace:canvasInspectorFontFamily")}
          // The app's select trigger, as every inspector select.
          className={cn(selectTriggerVariants({ size: "xs", variant: "filled" }), "min-w-0")}
          data-disabled={disabled || busy ? "" : undefined}
        >
          <span
            className="min-w-0 flex-1 truncate"
            style={
              current && !adding
                ? { fontFamily: `"${registeredFontFamily(current)}", "${current}", inherit` }
                : undefined
            }
          >
            {adding ?? (isMixed(value) ? "–" : (current ?? ""))}
          </span>
          {busy ? (
            <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
          )}
        </ComboboxTrigger>
        <ComboboxPopup align="start" className="w-64 p-0">
          <PickerPanelShell
            variant="plain"
            widthClassName="w-full"
            searchInput={
              <ComboboxInput
                inputClassName={PICKER_PANEL_PLAIN_SEARCH_INPUT_CLASS_NAME}
                placeholder={t(
                  showFavorites
                    ? "workspace:canvasInspectorSearchFavorites"
                    : "workspace:canvasInspectorSearchFonts",
                )}
                showTrigger={false}
                size="sm"
                unstyled
              />
            }
          >
            <div className="px-1.5 pt-1">
              <SegmentedPicker<"fonts" | "favorites">
                variant="buttons"
                size="sm"
                ariaLabel={t("workspace:canvasInspectorFontLists")}
                value={tab}
                options={[
                  { value: "fonts", label: t("workspace:canvasInspectorFontsTab") },
                  { value: "favorites", label: t("workspace:canvasInspectorFavoritesTab") },
                ]}
                onValueChange={setTab}
              />
            </div>
            <ComboboxEmpty>
              {showFavorites && favorites.length === 0
                ? t("workspace:canvasInspectorNoFavorites")
                : catalog.isLoading
                  ? t("workspace:canvasInspectorFontsLoading")
                  : t("workspace:canvasInspectorNoFonts")}
            </ComboboxEmpty>
            <ComboboxList className="max-h-72">
              {showFavorites ? (
                favoriteMatches.map(({ family }, index) => (
                  <ComboboxItem
                    key={`favorite:${family}`}
                    index={index}
                    value={family}
                    hideIndicator={family !== current}
                    className={cn(
                      "group/font",
                      PICKER_PANEL_ROW_GEOMETRY_CLASS_NAME,
                      family === current && PICKER_PANEL_ROW_SELECTED_CLASS_NAME,
                    )}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{family}</span>
                      {star(family)}
                    </span>
                  </ComboboxItem>
                ))
              ) : installedMatches.length > 0 ? (
                <ComboboxGroup>
                  <ComboboxGroupLabel className={PICKER_PANEL_GROUP_LABEL_CLASS_NAME}>
                    {t("workspace:canvasInspectorFontsInCanvas")}
                  </ComboboxGroupLabel>
                  {installedMatches.map(({ family }, index) => (
                    <ComboboxItem
                      key={`installed:${family}`}
                      index={index}
                      value={family}
                      hideIndicator={family !== current}
                      className={cn(
                        "group/font",
                        PICKER_PANEL_ROW_GEOMETRY_CLASS_NAME,
                        family === current && PICKER_PANEL_ROW_SELECTED_CLASS_NAME,
                      )}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          className="truncate"
                          style={{ fontFamily: `"${registeredFontFamily(family)}", inherit` }}
                        >
                          {family}
                        </span>
                        {star(family)}
                      </span>
                    </ComboboxItem>
                  ))}
                </ComboboxGroup>
              ) : null}
              {!showFavorites && catalogMatches.length > 0 ? (
                <ComboboxGroup>
                  <ComboboxGroupLabel className={PICKER_PANEL_GROUP_LABEL_CLASS_NAME}>
                    {t("workspace:canvasInspectorFontsCatalog")}
                  </ComboboxGroupLabel>
                  {catalogMatches.map(({ family, category }, index) => (
                    <ComboboxItem
                      key={`catalog:${family}`}
                      index={installedMatches.length + index}
                      value={family}
                      hideIndicator={family !== current}
                      className={cn(
                        "group/font",
                        PICKER_PANEL_ROW_GEOMETRY_CLASS_NAME,
                        family === current && PICKER_PANEL_ROW_SELECTED_CLASS_NAME,
                      )}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{family}</span>
                        <span className="shrink-0 text-ui-xs text-muted-foreground">
                          {category}
                        </span>
                        {star(family)}
                      </span>
                    </ComboboxItem>
                  ))}
                </ComboboxGroup>
              ) : null}
            </ComboboxList>
            {catalog.data && !catalog.data.available ? (
              <p className="px-2.5 py-1.5 text-ui-xs text-muted-foreground">
                {t("workspace:canvasInspectorFontsOffline")}
              </p>
            ) : null}
          </PickerPanelShell>
        </ComboboxPopup>
      </Combobox>
      {error ? <p className="text-ui-xs text-destructive">{error}</p> : null}
    </div>
  );
}
