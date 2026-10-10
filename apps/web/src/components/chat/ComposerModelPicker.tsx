// FILE: ComposerModelPicker.tsx
// Purpose: Single composer picker — provider tabs, searchable model rows, starred
//   model + trait presets, and per-trait rows (effort, speed, …) in one panel.
// Layer: Chat composer presentation
// Depends on: the picker's tabs/row/trait-row pieces, composer trait helpers, starred
//   model storage, and shared menu primitives.

import {
  type ModelSlug,
  type ProviderAgentDescriptor,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ProviderModelOptions,
  type ServerProviderStatus,
  type ThreadId,
} from "@synara/contracts";
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
import type { ProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import {
  buildNextProviderOptions,
  type ProviderModelOption,
  type ProviderOptions,
} from "../../providerModelOptions";
import { SearchIcon } from "~/lib/icons";
import { starredModelInstanceId, starredModelSlotKey } from "~/lib/starredModels";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";
import { ProviderAccountAvatar } from "../ProviderAccountMark";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuGroup, MenuGroupLabel } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { ComposerModelMenuTrigger } from "./ComposerModelMenuTrigger";
import { ModelCatalogRefresh } from "./ModelCatalogRefresh";
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
import {
  AVAILABLE_PROVIDER_OPTIONS,
  findProviderStatusForInstance,
  type ProviderModelOptionsByProviderInstance,
  type ProviderModelPickerInstance,
  resolveProviderModelLabel,
  resolveVisibleProviderOptions,
} from "./ProviderModelPicker";
import { resolveRuntimeModelDescriptor } from "./runtimeModelCapabilities";

export type ComposerModelSelectionOptions = {
  /** Provider options to commit together with the model (starred presets, row effort). */
  modelOptions?: ProviderOptions;
  /** Provider instance (account) the model is committed for. */
  instanceId?: ProviderInstanceId;
};

type ComposerModelPickerProps = {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  // Set when other providers are open for a same-thread handoff: the thread's
  // own provider still cannot switch to a sibling account.
  boundProviderInstance?: {
    readonly provider: ProviderKind;
    readonly instanceId: ProviderInstanceId;
  } | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  onRefreshModels?: ProviderModelCatalog["refreshModels"];
  discoveryErrorsByProvider?: Partial<Record<ProviderKind, string | undefined>>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance>;
  selectedProviderInstanceId?: ProviderInstanceId;
  modelOptionsByProviderInstance?: ProviderModelOptionsByProviderInstance;
  // Narrow-composer degradation: drop the model name (provider icon stays)
  // and/or the effort/status label; both remain available to assistive tech.
  hideModelLabel?: boolean;
  hideStatusLabel?: boolean;
  contextWindowLabel?: string | null;
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

  const { starredModels, toggleStarredModel, unstarModel } = useStarredModels();
  const instancesFor = (provider: ProviderKind): ReadonlyArray<ProviderModelPickerInstance> =>
    (props.providerInstances ?? []).filter((instance) => instance.provider === provider);
  const selectedInstanceIdFor = (provider: ProviderKind): ProviderInstanceId => {
    const instances = instancesFor(provider);
    if (
      provider === props.provider &&
      props.selectedProviderInstanceId !== undefined &&
      instances.some((instance) => instance.instanceId === props.selectedProviderInstanceId)
    ) {
      return props.selectedProviderInstanceId;
    }
    return (
      instances.find((instance) => instance.isDefault)?.instanceId ??
      instances[0]?.instanceId ??
      provider
    );
  };
  const activeInstanceId = selectedInstanceIdFor(activeProvider);

  // A locked thread can only ever run its own account's presets, and a preset of a
  // removed or disabled account cannot run at all.
  const knownInstances = props.providerInstances;
  const usableStarredModels = starredModels.filter((entry) => {
    if (lockedProvider !== null && entry.provider !== lockedProvider) return false;
    const instanceId = starredModelInstanceId(entry);
    const status = findProviderStatusForInstance({
      providers: props.providers,
      provider: entry.provider,
      instanceId,
    });
    if (status?.enabled === false) return false;
    if (knownInstances?.some((instance) => instance.instanceId === instanceId && !instance.enabled))
      return false;
    if (lockedProvider !== null && instanceId !== activeInstanceId) return false;
    const bound = props.boundProviderInstance;
    if (bound && entry.provider === bound.provider && instanceId !== bound.instanceId) {
      return false;
    }
    return (
      instanceId === entry.provider ||
      knownInstances === undefined ||
      knownInstances.some(
        (instance) => instance.instanceId === instanceId && instance.enabled !== false,
      )
    );
  });

  const [tab, setTab] = useState<ComposerModelPickerTab>(activeInstanceId);
  const [query, setQuery] = useState("");
  const normalizedQuery = useDeferredValue(query).trim().toLowerCase();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

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
    modelOptionsByProviderInstance: props.modelOptionsByProviderInstance,
    selectedProviderInstanceId: props.selectedProviderInstanceId,
  });
  const currentTraitSelection = getComposerTraitSelection(
    props.provider,
    props.model,
    props.prompt,
    props.modelOptions,
    props.runtimeModel,
  );

  const visibleProviderOptions = resolveVisibleProviderOptions({
    provider: props.provider,
    lockedProvider,
    providers: props.providers,
    hiddenProviders: props.hiddenProviders,
    providerOrder: props.providerOrder,
  }).filter((option) => lockedProvider === null || option.value === lockedProvider);
  // An enabled provider awaiting setup keeps its tab; a disabled provider is
  // managed through the recovery list in Settings instead.
  const activeProviderStatus = findProviderStatusForInstance({
    providers: props.providers,
    provider: activeProvider,
    instanceId: activeInstanceId,
  });
  const activeProviderOption =
    activeProviderStatus?.enabled === false
      ? undefined
      : AVAILABLE_PROVIDER_OPTIONS.find((option) => option.value === activeProvider);
  const providerTabs = resolveComposerModelPickerProviderTabs({
    options:
      activeProviderOption &&
      !visibleProviderOptions.some((option) => option.value === activeProvider)
        ? [activeProviderOption, ...visibleProviderOptions]
        : visibleProviderOptions,
    providers: props.providers,
    providerInstances: props.providerInstances,
    lockedInstanceId:
      lockedProvider !== null
        ? activeInstanceId
        : (props.boundProviderInstance?.instanceId ?? null),
    lockedInstanceProvider:
      lockedProvider === null ? (props.boundProviderInstance?.provider ?? null) : null,
  });
  const activeProviderTab = providerTabs.find(
    (providerTab) => providerTab.instanceId === activeInstanceId,
  );
  // Reset to the fastest starting point on every open: presets when the user has any,
  // unless the composer's own account is waiting to be set up.
  const [wasMenuOpen, setWasMenuOpen] = useState(isMenuOpen);
  if (wasMenuOpen !== isMenuOpen) {
    setWasMenuOpen(isMenuOpen);
    if (isMenuOpen) {
      setTab(
        usableStarredModels.length > 0 && !activeProviderTab?.setupMessage
          ? STARRED_TAB
          : (activeProviderTab?.instanceId ?? providerTabs[0]?.instanceId ?? STARRED_TAB),
      );
      setQuery("");
    }
  }

  // A tab that is no longer offered falls back to the first visible account.
  const openProviderTab = providerTabs.find((providerTab) => providerTab.instanceId === tab);
  const tabAccount = tab === STARRED_TAB ? null : (openProviderTab ?? providerTabs[0] ?? null);
  const setupMessage = tab === STARRED_TAB ? null : (tabAccount?.setupMessage ?? null);
  const openProviderSettings = () => {
    setMenuOpen(false);
    appHistory.push("/settings?section=providers");
  };

  const modelOptionsFor = (
    provider: ProviderKind,
    instanceId: string,
  ): ReadonlyArray<ProviderModelOption> =>
    props.modelOptionsByProviderInstance?.[instanceId as ProviderInstanceId] ??
    props.modelOptionsByProvider[provider];

  // Starred presets mix accounts, so each names its own once a provider has several.
  const accountLabelFor = (instanceId: string) => {
    const account = (props.providerInstances ?? []).find(
      (instance) => instance.instanceId === instanceId,
    );
    if (!account) return undefined;
    const hasSiblingAccounts = instancesFor(account.provider).some(
      (instance) => instance.instanceId !== instanceId && instance.enabled,
    );
    return hasSiblingAccounts || !account.isDefault ? account.label : undefined;
  };

  const rows =
    setupMessage !== null
      ? []
      : tabAccount === null
        ? buildStarredTabRows({
            starredModels: usableStarredModels,
            modelOptionsFor,
            accountLabelFor,
            query: normalizedQuery,
            current: {
              provider: activeProvider,
              instanceId: activeInstanceId,
              model: props.model,
              ...resolveStarredTraits(currentTraitSelection),
            },
            effortLevelsFor: (provider, model) => traitSelectionFor(provider, model).effortLevels,
          })
        : buildProviderTabRows({
            provider: tabAccount.provider,
            instanceId: tabAccount.instanceId,
            options: modelOptionsFor(tabAccount.provider, tabAccount.instanceId),
            query: normalizedQuery,
            selectedModel: tabAccount.instanceId === activeInstanceId ? props.model : null,
          });
  const starredModelSlots = new Set(starredModels.map(starredModelSlotKey));

  // Commit a row: `patch` carries the traits to apply on top of the provider's options.
  // `keepOpen` leaves the panel up so the footer slider can tune the model just picked.
  const commitRow = (
    row: PickerRow,
    model: ModelSlug,
    patch: Record<string, unknown>,
    keepOpen = false,
  ) => {
    // A starred preset restores its own account; other rows run in their tab's account.
    const instanceId = (
      row.preset ? starredModelInstanceId(row.preset) : (row.instanceId ?? row.provider)
    ) as ProviderInstanceId;
    if (Object.keys(patch).length > 0) {
      props.onProviderModelChange(row.provider, model, {
        modelOptions: buildNextProviderOptions(
          row.provider,
          providerOptionsFor(row.provider),
          patch,
        ),
        instanceId,
      });
    } else {
      props.onProviderModelChange(row.provider, model, { instanceId });
    }
    if (keepOpen) {
      selectionCommittedWhileOpenRef.current = true;
      setMenuOpen(true);
      return;
    }
    selectionCommittedWhileOpenRef.current = false;
    setMenuOpen(false);
    props.onSelectionCommitted?.();
  };

  const selectRow = (row: PickerRow) => {
    if (props.disabled) return;
    // OMP role rows resolve to a concrete model + options, committed through the
    // same patch path as a starred preset.
    if (row.role) {
      commitRow(
        row,
        row.role.model as ModelSlug,
        row.role.thinkingLevel ? { thinkingLevel: row.role.thinkingLevel } : {},
      );
      return;
    }
    const model = row.selectableModel;
    if (model === null) return;

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
    const model = row.selectableModel;
    if (props.disabled || model === null) return;
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
      .filter((providerTab) => !providerTab.blocked)
      .map((providerTab) => providerTab.instanceId),
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
    tabAccount !== null &&
    (props.loadingModelProviders?.[tabAccount.provider] ?? false) &&
    rows.length === 0;
  const discoveryError =
    tabAccount === null ? undefined : props.discoveryErrorsByProvider?.[tabAccount.provider];

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(nextOpen) => setMenuOpen(props.disabled ? false : nextOpen)}
    >
      <ComposerModelMenuTrigger
        provider={activeProvider}
        accountLabel={activeProviderTab?.name ? activeProviderTab.label : null}
        // The default account is implied; only another one is worth the room.
        accountName={activeProviderTab?.dotted ? activeProviderTab.name : null}
        accountAccentColor={activeProviderTab?.accentColor}
        modelLabel={modelLabel}
        statusLabel={resolveComposerTraitStatusLabel(currentTraitSelection)}
        contextWindowLabel={activeProvider === "claudeAgent" ? props.contextWindowLabel : null}
        showsFastBadge={showsComposerFastModeBadge(currentTraitSelection)}
        hideModelLabel={props.hideModelLabel}
        hideStatusLabel={props.hideStatusLabel}
        disabled={props.disabled}
        isMenuOpen={isMenuOpen}
        openPlaceholderLabel={usesEffortSlider ? "Select effort" : null}
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
            tab={tab === STARRED_TAB ? STARRED_TAB : (tabAccount?.instanceId ?? STARRED_TAB)}
            providerTabs={providerTabs}
            onTabChange={setTab}
            onAddProviders={lockedProvider === null ? openProviderSettings : undefined}
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
            {setupMessage !== null ? (
              <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
                {openProviderTab ? (
                  <ProviderAccountAvatar
                    provider={openProviderTab.provider}
                    accentColor={openProviderTab.accentColor}
                  />
                ) : null}
                <span className="text-ui font-medium text-foreground">
                  {openProviderTab?.label ?? "This account"} needs setup
                </span>
                <span className="text-ui-sm leading-snug text-muted-foreground">
                  {setupMessage}
                </span>
                <Button type="button" size="xs" variant="outline" onClick={openProviderSettings}>
                  Open provider setup
                </Button>
              </div>
            ) : discoveryError ? (
              <div className="px-2 py-1.5 text-ui leading-snug text-destructive">
                {discoveryError}
              </div>
            ) : null}
            {setupMessage !== null ? null : isTabLoading ? (
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
                      row.selectableModel !== null && index < MODEL_PICKER_SHORTCUT_ROW_LIMIT
                        ? `${shortcutModifierLabel}${index + 1}`
                        : null
                    }
                    providerOptions={providerOptionsFor(row.provider)}
                    runtimeModels={props.runtimeModelsByProvider?.[row.provider]}
                    prompt={promptFor(row.provider)}
                    starredModelSlots={starredModelSlots}
                    onSelect={selectRow}
                    // The footer slider owns effort in slider mode; rows stay plain.
                    onSelectEffort={usesEffortSlider ? null : selectRowWithEffort}
                    onToggleStar={toggleStarredModel}
                    onUnstarModel={unstarModel}
                  />
                ))}
              </div>
            ) : (
              <div className="px-2 py-3 text-muted-foreground text-ui leading-relaxed">
                {normalizedQuery.length > 0
                  ? "No matches"
                  : tab === STARRED_TAB
                    ? "Star a model to pin it here together with its effort and speed, then pick it in one click."
                    : "No models found"}
              </div>
            )}
          </div>
          {isMenuOpen && tabAccount && !setupMessage && props.onRefreshModels ? (
            <ModelCatalogRefresh
              key={tabAccount.instanceId}
              provider={tabAccount.provider}
              instanceId={tabAccount.instanceId}
              onRefresh={props.onRefreshModels}
            />
          ) : null}
          <ComposerModelPickerTraitRows
            provider={props.provider}
            providerInstanceId={props.selectedProviderInstanceId}
            threadId={threadId}
            model={props.model}
            runtimeModel={props.runtimeModel}
            runtimeAgents={props.runtimeAgents}
            modelOptions={props.modelOptions}
            prompt={props.prompt}
            onPromptChange={props.onPromptChange}
            effortControl={effortControl}
          />
        </div>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
