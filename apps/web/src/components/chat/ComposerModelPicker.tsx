// FILE: ComposerModelPicker.tsx
// Purpose: Single composer picker — provider tabs, searchable model rows, starred
//   model + trait presets, and per-trait rows (effort, speed, …) in one panel.
// Layer: Chat composer presentation
// Depends on: the picker's tabs/row/trait-row pieces, composer trait helpers, starred
//   model storage, and shared menu primitives.

import {
  type ModelSlug,
  type ProviderAgentDescriptor,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ProviderModelOptions,
  type ServerProviderStatus,
  type ThreadId,
} from "@synara/contracts";
import { resolveSelectableModel } from "@synara/shared/model";
import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { appHistory } from "../../appNavigation";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStarredModels } from "../../hooks/useStarredModels";
import {
  buildNextProviderOptions,
  type ProviderModelOption,
  type ProviderOptions,
} from "../../providerModelOptions";
import { SearchIcon } from "~/lib/icons";
import { starredModelKey } from "~/lib/starredModels";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";
import { Input } from "../ui/input";
import { Menu, MenuGroup, MenuGroupLabel } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { ComposerModelMenuTrigger } from "./ComposerModelMenuTrigger";
import {
  buildProviderTabRows,
  buildStarredModelOptionsPatch,
  buildStarredTabRows,
  type ComposerModelPickerRow as PickerRow,
  type ComposerModelPickerTab,
  MODEL_PICKER_POPUP_ATTRIBUTE,
  MODEL_PICKER_SHORTCUT_ROW_LIMIT,
  modelPickerShortcutRowIndex,
  resolveStarredTraits,
  STARRED_TAB,
} from "./ComposerModelPicker.logic";
import { ComposerModelPickerRow } from "./ComposerModelPickerRow";
import {
  ComposerModelPickerTabs,
  resolveComposerModelPickerProviderTabs,
} from "./ComposerModelPickerTabs";
import {
  type ComposerEffortControl,
  ComposerModelPickerTraitRows,
} from "./ComposerModelPickerTraitRows";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME } from "./composerPickerStyles";
import {
  getComposerTraitSelection,
  planComposerEffortChange,
  resolveComposerTraitStatusLabel,
  showsComposerFastModeBadge,
} from "./composerTraits";
import { MENU_NAVIGATION_KEYS } from "./PickerPanelShell";
import {
  PICKER_PANEL_GROUP_LABEL_CLASS_NAME,
  PICKER_PANEL_PLAIN_SEARCH_ICON_CLASS_NAME,
  PICKER_PANEL_PLAIN_SEARCH_INPUT_CLASS_NAME,
} from "./pickerPanelStyles";
import { resolveProviderModelLabel, resolveVisibleProviderOptions } from "./ProviderModelPicker";
import { resolveRuntimeModelDescriptor } from "./runtimeModelCapabilities";

export type ComposerModelSelectionOptions = {
  /** Provider options to commit together with the model (starred presets, row effort). */
  modelOptions?: ProviderOptions;
};

type ComposerModelPickerProps = {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  discoveryErrorsByProvider?: Partial<Record<ProviderKind, string | undefined>>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  // Narrow-composer degradation: drop the model name (provider icon stays)
  // and/or the effort/status label; both remain available to assistive tech.
  hideModelLabel?: boolean;
  hideStatusLabel?: boolean;
  disabled?: boolean;
  // "menu" (default) lists effort as a footer row; "slider" renders the ladder as a
  // stepped slider card in the footer instead.
  effortControl?: ComposerEffortControl;
  onProviderModelChange: (
    provider: ProviderKind,
    model: ModelSlug,
    options?: ComposerModelSelectionOptions,
  ) => void;
  onSelectionCommitted?: () => void;

  threadId: ThreadId;
  runtimeModel?: ProviderModelDescriptor | undefined;
  runtimeModelsByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor> | null | undefined>
  >;
  runtimeAgents?: ReadonlyArray<ProviderAgentDescriptor> | null | undefined;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;

  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutLabel?: string | null;
};

// Rows arrive ordered by group; wrap each run of equal labels in one labelled menu group.
function groupRowElements(
  rows: ReadonlyArray<PickerRow>,
  renderRow: (row: PickerRow, index: number) => ReactNode,
): ReactNode[] {
  const groups: Array<{ key: string; label: string | null; items: ReactNode[] }> = [];
  rows.forEach((row, index) => {
    const lastGroup = groups.at(-1);
    const group =
      lastGroup && lastGroup.label === row.groupLabel
        ? lastGroup
        : { key: row.key, label: row.groupLabel, items: [] };
    if (group !== lastGroup) groups.push(group);
    group.items.push(renderRow(row, index));
  });
  return groups.map((group) => (
    <MenuGroup key={group.key} className="flex flex-col gap-px">
      {group.label !== null ? (
        <MenuGroupLabel className={PICKER_PANEL_GROUP_LABEL_CLASS_NAME}>
          {group.label}
        </MenuGroupLabel>
      ) : null}
      {group.items}
    </MenuGroup>
  ));
}

export function ComposerModelPicker(props: ComposerModelPickerProps) {
  const { onOpenChange, open, lockedProvider, threadId } = props;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isMenuOpen = open ?? uncontrolledOpen;
  const activeProvider = lockedProvider ?? props.provider;
  const effortControl = props.effortControl ?? "menu";
  const usesEffortSlider = effortControl === "slider";

  const { starredModels, toggleStarredModel } = useStarredModels();
  // A locked thread can only ever run its own provider's presets.
  const usableStarredModels =
    lockedProvider === null
      ? starredModels
      : starredModels.filter((entry) => entry.provider === lockedProvider);
  const hiddenStarredCount = starredModels.length - usableStarredModels.length;

  const [tab, setTab] = useState<ComposerModelPickerTab>(activeProvider);
  const [query, setQuery] = useState("");
  const normalizedQuery = useDeferredValue(query).trim().toLowerCase();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Reset to the fastest starting point on every open: presets when the user has any.
  const [wasMenuOpen, setWasMenuOpen] = useState(isMenuOpen);
  if (wasMenuOpen !== isMenuOpen) {
    setWasMenuOpen(isMenuOpen);
    if (isMenuOpen) {
      setTab(usableStarredModels.length > 0 ? STARRED_TAB : activeProvider);
      setQuery("");
    }
  }

  // A model picked while the panel stays open (slider mode) still owes the composer its
  // focus hand-off; it is paid when the panel finally closes.
  const selectionCommittedWhileOpenRef = useRef(false);
  const setMenuOpen = (nextOpen: boolean) => {
    if (open === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
    if (!nextOpen && selectionCommittedWhileOpenRef.current) {
      selectionCommittedWhileOpenRef.current = false;
      props.onSelectionCommitted?.();
    }
  };

  useEffect(() => {
    if (!isMenuOpen) return;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isMenuOpen, tab]);

  // Options a provider's models would run with: the composer's own for the selected
  // provider, otherwise that provider's draft / sticky selection.
  const draftSelectionByProvider = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.modelSelectionByProvider,
  );
  const stickySelectionByProvider = useComposerDraftStore(
    (store) => store.stickyModelSelectionByProvider,
  );
  const providerOptionsFor = (provider: ProviderKind): ProviderOptions | undefined =>
    provider === props.provider
      ? props.modelOptions
      : (draftSelectionByProvider?.[provider]?.options ??
        stickySelectionByProvider[provider]?.options);
  const promptFor = (provider: ProviderKind) => (provider === props.provider ? props.prompt : "");
  const traitSelectionFor = (provider: ProviderKind, model: string) =>
    getComposerTraitSelection(
      provider,
      model,
      promptFor(provider),
      providerOptionsFor(provider),
      resolveRuntimeModelDescriptor({
        provider,
        model,
        runtimeModels: props.runtimeModelsByProvider?.[provider],
      }),
    );

  const modelLabel = resolveProviderModelLabel({
    provider: props.provider,
    lockedProvider,
    model: props.model,
    modelOptionsByProvider: props.modelOptionsByProvider,
  });
  const currentTraitSelection = getComposerTraitSelection(
    props.provider,
    props.model,
    props.prompt,
    props.modelOptions,
    props.runtimeModel,
  );

  const providerTabs = resolveComposerModelPickerProviderTabs(
    resolveVisibleProviderOptions({
      provider: props.provider,
      lockedProvider,
      providers: props.providers,
      hiddenProviders: props.hiddenProviders,
      providerOrder: props.providerOrder,
    }).filter((option) => lockedProvider === null || option.value === lockedProvider),
    props.providers,
  );

  const rows =
    tab === STARRED_TAB
      ? buildStarredTabRows({
          starredModels: usableStarredModels,
          modelOptionsByProvider: props.modelOptionsByProvider,
          query: normalizedQuery,
          current: {
            provider: activeProvider,
            model: props.model,
            ...resolveStarredTraits(currentTraitSelection),
          },
          effortLevelsFor: (provider, model) => traitSelectionFor(provider, model).effortLevels,
        })
      : buildProviderTabRows({
          provider: tab,
          options: props.modelOptionsByProvider[tab],
          query: normalizedQuery,
          selectedModel: tab === activeProvider ? props.model : null,
        });
  const starredKeySet = new Set(starredModels.map(starredModelKey));

  // Commit a row: `patch` carries the traits to apply on top of the provider's options.
  // `keepOpen` leaves the panel up so the footer slider can tune the model just picked.
  const commitRow = (
    row: PickerRow,
    model: ModelSlug,
    patch: Record<string, unknown>,
    keepOpen = false,
  ) => {
    if (Object.keys(patch).length > 0) {
      props.onProviderModelChange(row.provider, model, {
        modelOptions: buildNextProviderOptions(
          row.provider,
          providerOptionsFor(row.provider),
          patch,
        ),
      });
    } else {
      props.onProviderModelChange(row.provider, model);
    }
    if (keepOpen) {
      selectionCommittedWhileOpenRef.current = true;
      return;
    }
    selectionCommittedWhileOpenRef.current = false;
    setMenuOpen(false);
    props.onSelectionCommitted?.();
  };

  const selectRow = (row: PickerRow) => {
    if (props.disabled) return;
    const resolvedModel = resolveSelectableModel(
      row.provider,
      row.model,
      props.modelOptionsByProvider[row.provider],
    );
    // A starred model may be missing until its provider's catalog is discovered.
    const model = (resolvedModel ?? (row.preset ? row.model : null)) as ModelSlug | null;
    if (!model) return;
    const selection = traitSelectionFor(row.provider, model);
    // Slider mode: switching to a model with an effort ladder keeps the panel open so the
    // footer slider can set its effort. Presets already carry their effort, and picking
    // the current model again is the "done" gesture, so both close.
    const keepOpen =
      usesEffortSlider && row.preset === null && !row.selected && selection.effortLevels.length > 0;
    commitRow(
      row,
      model,
      row.preset
        ? buildStarredModelOptionsPatch({ provider: row.provider, selection, starred: row.preset })
        : {},
      keepOpen,
    );
  };

  // Pick a model and its effort in one gesture from the row's side block.
  const selectRowWithEffort = (row: PickerRow, value: string) => {
    if (props.disabled) return;
    const model = resolveSelectableModel(
      row.provider,
      row.model,
      props.modelOptionsByProvider[row.provider],
    );
    if (!model) return;
    const plan = planComposerEffortChange({
      provider: row.provider,
      selection: traitSelectionFor(row.provider, model),
      prompt: promptFor(row.provider),
      value,
    });
    if (!plan) return;
    if (plan.kind === "options") {
      commitRow(row, model, plan.patch);
      return;
    }
    // Prompt-injected levels (Ultrathink) only make sense for the composer's own prompt.
    if (row.provider !== props.provider) return;
    props.onPromptChange(plan.prompt);
    commitRow(row, model, {});
  };

  const openTabs: ComposerModelPickerTab[] = [
    STARRED_TAB,
    ...providerTabs
      .filter((providerTab) => providerTab.unavailableLabel === null)
      .map((providerTab) => providerTab.provider),
  ];
  const cycleTab = (direction: 1 | -1) => {
    const index = openTabs.indexOf(tab);
    setTab(openTabs[(index + direction + openTabs.length) % openTabs.length] ?? STARRED_TAB);
  };

  // mod+1…9 picks a visible row. Registered on window capture because thread-jump
  // owns the same chord globally (the sidebar yields while this picker is open).
  const onShortcutKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const rowIndex = modelPickerShortcutRowIndex(event);
    if (rowIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    const row = rows[rowIndex];
    if (row) selectRow(row);
  });
  useEffect(() => {
    if (!isMenuOpen) return;
    const listener = (event: KeyboardEvent) => onShortcutKeyDown(event);
    window.addEventListener("keydown", listener, { capture: true });
    return () => window.removeEventListener("keydown", listener, { capture: true });
  }, [isMenuOpen]);

  const shortcutModifierLabel = isMacNavigatorPlatform() ? "⌘" : "Ctrl ";
  const isTabLoading =
    tab !== STARRED_TAB && (props.loadingModelProviders?.[tab] ?? false) && rows.length === 0;
  const discoveryError = tab === STARRED_TAB ? undefined : props.discoveryErrorsByProvider?.[tab];

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(nextOpen) => setMenuOpen(props.disabled ? false : nextOpen)}
    >
      <ComposerModelMenuTrigger
        provider={activeProvider}
        modelLabel={modelLabel}
        statusLabel={resolveComposerTraitStatusLabel(currentTraitSelection)}
        showsFastBadge={showsComposerFastModeBadge(currentTraitSelection)}
        hideModelLabel={props.hideModelLabel}
        hideStatusLabel={props.hideStatusLabel}
        disabled={props.disabled}
        isMenuOpen={isMenuOpen}
        shortcutLabel={props.shortcutLabel}
      />
      <ComposerPickerMenuPopup
        align="start"
        side="top"
        // Glassier than the stock picker shell: thinner fill over a deeper, more saturated blur.
        className="w-[min(18.5rem,92vw)] bg-popover/55 [--picker-option-min-h:1.75rem] before:backdrop-blur-3xl before:backdrop-saturate-200"
        {...{ [MODEL_PICKER_POPUP_ATTRIBUTE]: "" }}
        onKeyDownCapture={(event) => {
          // Tab walks the provider tabs instead of leaving (and closing) the menu.
          if (event.key !== "Tab") return;
          event.preventDefault();
          event.stopPropagation();
          cycleTab(event.shiftKey ? -1 : 1);
        }}
      >
        {/* -m-1 bleeds over the popup body padding so headers/dividers run edge to edge. */}
        <div className="-m-1 flex flex-col">
          <ComposerModelPickerTabs
            tab={tab}
            providerTabs={providerTabs}
            onTabChange={setTab}
            onAddProviders={
              lockedProvider === null
                ? () => {
                    setMenuOpen(false);
                    appHistory.push("/settings?section=providers");
                  }
                : undefined
            }
          />
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 *:min-w-0">
            <SearchIcon aria-hidden="true" className={PICKER_PANEL_PLAIN_SEARCH_ICON_CLASS_NAME} />
            <Input
              className={PICKER_PANEL_PLAIN_SEARCH_INPUT_CLASS_NAME}
              nativeInput
              unstyled
              ref={searchInputRef}
              size="sm"
              type="search"
              aria-label="Search models"
              placeholder={tab === STARRED_TAB ? "Search starred…" : "Search models…"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDownCapture={(event) => {
                if (event.key === "Enter") {
                  // Focus is still in the field, so no row is highlighted: take the top hit.
                  event.preventDefault();
                  event.stopPropagation();
                  const firstRow = rows[0];
                  if (firstRow) selectRow(firstRow);
                  return;
                }
                if (event.key === "Tab" || MENU_NAVIGATION_KEYS.has(event.key)) return;
                // Keep typing out of the menu's typeahead.
                event.stopPropagation();
              }}
            />
          </div>
          <div
            role="tabpanel"
            className={cn(
              "max-h-[min(12.5rem,40vh)] min-h-20 overflow-y-auto overscroll-contain p-1",
              COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
            )}
          >
            {discoveryError ? (
              <div className="px-2 py-1.5 text-xs text-destructive">{discoveryError}</div>
            ) : null}
            {isTabLoading ? (
              <div className="space-y-2 px-2 py-2" aria-label="Loading models">
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton
                    key={index}
                    className={cn("h-3.5 rounded-full", index % 3 === 0 ? "w-32" : "w-44")}
                  />
                ))}
              </div>
            ) : rows.length > 0 ? (
              <div className="flex flex-col gap-px">
                {groupRowElements(rows, (row, index) => (
                  <ComposerModelPickerRow
                    key={row.key}
                    row={row}
                    shortcutHint={
                      index < MODEL_PICKER_SHORTCUT_ROW_LIMIT
                        ? `${shortcutModifierLabel}${index + 1}`
                        : null
                    }
                    providerOptions={providerOptionsFor(row.provider)}
                    runtimeModels={props.runtimeModelsByProvider?.[row.provider]}
                    prompt={promptFor(row.provider)}
                    starredKeySet={starredKeySet}
                    onSelect={selectRow}
                    // The footer slider owns effort in slider mode; rows stay plain.
                    onSelectEffort={usesEffortSlider ? null : selectRowWithEffort}
                    onToggleStar={toggleStarredModel}
                  />
                ))}
              </div>
            ) : (
              <div className="px-2 py-3 text-muted-foreground text-xs leading-relaxed">
                {normalizedQuery.length > 0
                  ? "No matches"
                  : tab === STARRED_TAB
                    ? "Star a model to pin it here together with its effort and speed, then pick it in one click."
                    : "No models found"}
              </div>
            )}
            {tab === STARRED_TAB && hiddenStarredCount > 0 ? (
              <div className="px-2 pt-1.5 pb-1 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
                {hiddenStarredCount} starred from other providers — this thread stays on its
                provider.
              </div>
            ) : null}
          </div>
          <ComposerModelPickerTraitRows
            provider={props.provider}
            threadId={threadId}
            model={props.model}
            runtimeModel={props.runtimeModel}
            runtimeAgents={props.runtimeAgents}
            modelOptions={props.modelOptions}
            prompt={props.prompt}
            onPromptChange={props.onPromptChange}
            modelLabel={modelLabel}
            effortControl={effortControl}
          />
        </div>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
