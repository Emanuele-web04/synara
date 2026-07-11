// FILE: ProviderModelPicker.tsx
// Purpose: Renders the composer provider/model menu and supports controlled opening for shortcuts.
// Layer: Chat composer presentation
// Depends on: provider availability metadata, shared menu primitives, and picker trigger styling.

import {
  type ModelSlug,
  type ProviderInstanceId,
  ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { resolveSelectableModel } from "@synara/shared/model";
import { inferLegacyProviderKindFromInstanceId } from "@synara/shared/providerInstances";
import * as Schema from "effect/Schema";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { formatProviderModelOptionName } from "../../providerModelOptions";
import { compareProvidersByOrder } from "../../providerOrdering";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { cn } from "~/lib/utils";
import { PickerPanelShell } from "./PickerPanelShell";
import { PickerTriggerButton } from "./PickerTriggerButton";
import { ProviderModelOptionGroupList } from "./ProviderModelOptionGroupList";
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import {
  COMPOSER_PICKER_MODEL_LIST_MAX_HEIGHT_CLASS_NAME,
  COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
  COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME,
} from "./composerPickerStyles";
import { ShortcutKbd } from "../ui/shortcut-kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  groupProviderModelOptions,
  groupProviderModelOptionsWithFavorites,
  shouldUseCollapsibleModelGroups,
  type ProviderModelOption,
} from "../../providerModelOptions";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Skeleton } from "../ui/skeleton";
import { isProviderUsable } from "../../lib/providerAvailability";
import { MISSING_PROVIDER_INSTANCE_LABEL } from "../../lib/providerInstancePresentation";

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

export function resolveLiveProviderAvailability(provider: ServerProviderStatus | undefined): {
  disabled: boolean;
  label: string | null;
} {
  if (!provider) {
    return {
      disabled: true,
      label: "Checking",
    };
  }

  if (!provider.available) {
    return {
      disabled: true,
      label: provider.authStatus === "unauthenticated" ? "Sign in" : "Unavailable",
    };
  }

  if (provider.authStatus === "unauthenticated") {
    return {
      disabled: true,
      label: "Sign in",
    };
  }

  if (!isProviderUsable(provider)) {
    return {
      disabled: true,
      label: provider.status === "warning" ? "Check" : "Unavailable",
    };
  }

  return {
    disabled: false,
    label: null,
  };
}

function isUnsupportedProviderInstanceStatus(status: ServerProviderStatus): boolean {
  return (
    status.availability === "unavailable" &&
    status.driver !== undefined &&
    !Schema.is(ProviderKind)(status.driver)
  );
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);
const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => !option.available);

// Removes user-hidden providers from a provider option list while always
// preserving any providers the caller marks as protected (the active and
// locked provider for the current thread). Without that carve-out, hiding the
// provider you're already using would erase the entry that lets you switch
// away from it.
function filterProviderOptionsByVisibility<T extends { value: ProviderKind }>(
  options: ReadonlyArray<T>,
  hiddenProviders: ReadonlySet<ProviderKind>,
  protectedProviders: ReadonlySet<ProviderKind>,
): ReadonlyArray<T> {
  if (hiddenProviders.size === 0) {
    return options;
  }
  return options.filter(
    (option) => protectedProviders.has(option.value) || !hiddenProviders.has(option.value),
  );
}

function providerIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string,
): string {
  return provider === "claudeAgent" || provider === "gemini" || provider === "pi"
    ? "text-foreground"
    : fallbackClassName;
}

const SEARCHABLE_MODEL_PICKER_THRESHOLD = 15;
const FAVORITE_MODEL_STORAGE_KEYS = {
  cursor: "synara:cursor-favourite-models:v1",
  kilo: "synara:kilo-favourite-models:v1",
  opencode: "synara:opencode-favourite-models:v1",
  pi: "synara:pi-favourite-models:v1",
} as const;
const FavoriteModelKeys = Schema.Array(Schema.String);
type LegacyFavoriteModelProvider = keyof typeof FAVORITE_MODEL_STORAGE_KEYS;
type FavoriteModelProvider = ProviderKind;

function supportsLegacyModelFavorites(
  provider: ProviderKind,
): provider is LegacyFavoriteModelProvider {
  return (
    provider === "cursor" || provider === "kilo" || provider === "opencode" || provider === "pi"
  );
}

export interface ProviderModelFavorite {
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

export interface ProviderModelPickerInstance {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
}

export type ProviderModelOptionsByProviderInstance = Partial<
  Record<ProviderInstanceId, ReadonlyArray<ProviderModelOption>>
>;

function defaultProviderInstance(provider: ProviderKind): ProviderModelPickerInstance {
  return {
    instanceId: provider,
    provider,
    label: provider === "claudeAgent" ? "Claude" : provider,
    enabled: true,
    isDefault: true,
  };
}

export function findProviderStatusForInstance(input: {
  providers: ReadonlyArray<ServerProviderStatus> | undefined;
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
}): ServerProviderStatus | undefined {
  return input.providers?.find(
    (entry) =>
      entry.provider === input.provider &&
      (entry.instanceId ?? entry.provider) === input.instanceId,
  );
}

function resolveModelOptionsForProviderInstance(input: {
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  modelOptionsByProviderInstance?: ProviderModelOptionsByProviderInstance | undefined;
}): ReadonlyArray<ProviderModelOption> {
  return (
    input.modelOptionsByProviderInstance?.[input.instanceId] ??
    input.modelOptionsByProvider[input.provider]
  );
}

function favoriteModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}:${slug}`;
}

function normalizeFavoriteModels(
  favorites: ReadonlyArray<ProviderModelFavorite>,
): ProviderModelFavorite[] {
  const result: ProviderModelFavorite[] = [];
  const seen = new Set<string>();
  for (const favorite of favorites) {
    const model = favorite.model.trim();
    if (!model) {
      continue;
    }
    const key = favoriteModelKey(favorite.provider, model);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ provider: favorite.provider, model });
  }
  return result;
}

function favoriteModelKeySetsFromSettings(
  favorites: ReadonlyArray<ProviderModelFavorite>,
  providerInstances: ReadonlyArray<ProviderModelPickerInstance> | undefined,
): Partial<Record<FavoriteModelProvider, ReadonlySet<string>>> {
  const result: Partial<Record<FavoriteModelProvider, Set<string>>> = {};
  const providerByInstanceId = new Map<ProviderInstanceId, ProviderKind>();
  for (const instance of providerInstances ?? []) {
    providerByInstanceId.set(instance.instanceId, instance.provider);
  }
  for (const favorite of normalizeFavoriteModels(favorites)) {
    const provider =
      providerByInstanceId.get(favorite.provider) ??
      inferLegacyProviderKindFromInstanceId(favorite.provider);
    if (!provider) {
      continue;
    }
    (result[provider] ??= new Set()).add(favoriteModelKey(favorite.provider, favorite.model));
  }
  return result;
}

function normalizeFavoriteModelKeys(
  provider: LegacyFavoriteModelProvider,
  entries: ReadonlyArray<string>,
): string[] {
  return Array.from(
    new Set(
      entries
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) =>
          entry.includes(":") ? entry : favoriteModelKey(provider as ProviderInstanceId, entry),
        ),
    ),
  );
}

// Keeps persisted favorite model keys compact and stable while preserving the user's order.
function toggleFavoriteModelKey(
  current: ReadonlyArray<string>,
  provider: LegacyFavoriteModelProvider,
  instanceId: ProviderInstanceId,
  slug: string,
): string[] {
  const normalizedCurrent = normalizeFavoriteModelKeys(provider, current);
  const key = favoriteModelKey(instanceId, slug);
  return normalizedCurrent.includes(key)
    ? normalizedCurrent.filter((entry) => entry !== key)
    : [...normalizedCurrent, key];
}

function favoriteModelSlugsForInstance(input: {
  provider: FavoriteModelProvider;
  instanceId: ProviderInstanceId;
  keys: ReadonlySet<string>;
}): ReadonlySet<string> {
  const prefix = `${input.instanceId}:`;
  const slugs = new Set<string>();
  for (const key of input.keys) {
    const normalizedKey = key.includes(":")
      ? key
      : favoriteModelKey(input.provider as ProviderInstanceId, key);
    if (normalizedKey.startsWith(prefix)) {
      slugs.add(normalizedKey.slice(prefix.length));
    }
  }
  return slugs;
}

function stripParameterizedModelSuffix(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/u, "");
}

function resolveSelectedModelLabel(input: {
  provider: ProviderKind;
  model: string;
  options: ReadonlyArray<ProviderModelOption>;
}): string {
  const exact = input.options.find((option) => option.slug === input.model);
  if (exact) {
    return exact.name;
  }
  if (input.provider === "cursor") {
    const baseModel = stripParameterizedModelSuffix(input.model);
    const baseMatch = input.options.find(
      (option) => stripParameterizedModelSuffix(option.slug) === baseModel,
    );
    if (baseMatch) {
      return baseMatch.name;
    }
  }
  return formatProviderModelOptionName({
    provider: input.provider,
    slug: input.model,
  });
}

function buildModelSearchText(option: ProviderModelOption): string {
  return [option.name, option.slug, option.upstreamProviderName, option.upstreamProviderId]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

type ProviderModelMenuItemsProps = {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  modelOptionsByProviderInstance?: ProviderModelOptionsByProviderInstance;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance>;
  selectedProviderInstanceId?: ProviderInstanceId;
  showProviderInstanceChoices?: boolean;
  favoriteModels?: ReadonlyArray<ProviderModelFavorite>;
  onFavoriteModelsChange?: (favoriteModels: ProviderModelFavorite[]) => void;
  disabled?: boolean;
  onProviderModelChange: (
    provider: ProviderKind,
    model: ModelSlug,
    instanceId?: ProviderInstanceId,
  ) => void;
  // Invoked after a model selection commits so callers can close ancestor
  // menus and refocus the composer.
  onAfterSelection?: () => void;
};

// Renders only the popup body of the provider/model picker. Designed to be
// dropped into any MenuPopup or MenuSubPopup so the same selection logic can
// be reused by the standalone picker and the combined composer trait picker.
export const ProviderModelMenuItems = memo(function ProviderModelMenuItems(
  props: ProviderModelMenuItemsProps,
) {
  const { onAfterSelection } = props;
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [kiloFavoriteModelSlugs, setKiloFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.kilo,
    [],
    FavoriteModelKeys,
  );
  const [cursorFavoriteModelSlugs, setCursorFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.cursor,
    [],
    FavoriteModelKeys,
  );
  const [openCodeFavoriteModelSlugs, setOpenCodeFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.opencode,
    [],
    FavoriteModelKeys,
  );
  const [piFavoriteModelSlugs, setPiFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.pi,
    [],
    FavoriteModelKeys,
  );
  const deferredModelSearchQuery = useDeferredValue(modelSearchQuery);
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderInstanceId = props.selectedProviderInstanceId ?? props.provider;
  const hiddenProviders = props.hiddenProviders;
  const providerOrder = props.providerOrder;
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(hiddenProviders ?? []),
    [hiddenProviders],
  );
  const protectedProviderSet = useMemo(() => {
    const set = new Set<ProviderKind>([props.provider]);
    if (props.lockedProvider !== null) {
      set.add(props.lockedProvider);
    }
    return set;
  }, [props.provider, props.lockedProvider]);
  const visibleAvailableProviderOptions = useMemo(
    () =>
      filterProviderOptionsByVisibility(
        AVAILABLE_PROVIDER_OPTIONS.toSorted((left, right) =>
          compareProvidersByOrder(providerOrder ?? [], left.value, right.value),
        ),
        hiddenProviderSet,
        protectedProviderSet,
      ),
    [hiddenProviderSet, protectedProviderSet, providerOrder],
  );
  const visibleUnavailableProviderOptions = useMemo(
    () =>
      filterProviderOptionsByVisibility(
        UNAVAILABLE_PROVIDER_OPTIONS.toSorted((left, right) =>
          compareProvidersByOrder(providerOrder ?? [], left.value, right.value),
        ),
        hiddenProviderSet,
        protectedProviderSet,
      ),
    [hiddenProviderSet, protectedProviderSet, providerOrder],
  );
  const visibleUnsupportedProviderInstances = useMemo(
    () => (props.providers ?? []).filter(isUnsupportedProviderInstanceStatus),
    [props.providers],
  );
  const kiloFavoriteModelSlugSet = useMemo(
    () => new Set(kiloFavoriteModelSlugs),
    [kiloFavoriteModelSlugs],
  );
  const openCodeFavoriteModelSlugSet = useMemo(
    () => new Set(openCodeFavoriteModelSlugs),
    [openCodeFavoriteModelSlugs],
  );
  const cursorFavoriteModelSlugSet = useMemo(
    () => new Set(cursorFavoriteModelSlugs),
    [cursorFavoriteModelSlugs],
  );
  const piFavoriteModelSlugSet = useMemo(
    () => new Set(piFavoriteModelSlugs),
    [piFavoriteModelSlugs],
  );
  const settingsFavoriteModelSlugSets = useMemo(
    () =>
      props.favoriteModels !== undefined
        ? favoriteModelKeySetsFromSettings(props.favoriteModels, props.providerInstances)
        : null,
    [props.favoriteModels, props.providerInstances],
  );
  const favoriteModelSlugSets = useMemo(
    (): Partial<Record<FavoriteModelProvider, ReadonlySet<string>>> =>
      settingsFavoriteModelSlugSets ?? {
        cursor: cursorFavoriteModelSlugSet,
        kilo: kiloFavoriteModelSlugSet,
        opencode: openCodeFavoriteModelSlugSet,
        pi: piFavoriteModelSlugSet,
      },
    [
      cursorFavoriteModelSlugSet,
      kiloFavoriteModelSlugSet,
      openCodeFavoriteModelSlugSet,
      piFavoriteModelSlugSet,
      settingsFavoriteModelSlugSets,
    ],
  );

  const providerInstancesByProvider = useMemo(() => {
    const map = new Map<ProviderKind, ProviderModelPickerInstance[]>();
    for (const provider of AVAILABLE_PROVIDER_OPTIONS.map((option) => option.value)) {
      map.set(provider, []);
    }
    for (const instance of props.providerInstances ?? []) {
      const entries = map.get(instance.provider);
      if (entries) {
        entries.push(instance);
      }
    }
    for (const provider of AVAILABLE_PROVIDER_OPTIONS.map((option) => option.value)) {
      const entries = map.get(provider);
      if (!entries || entries.length === 0) {
        map.set(provider, [defaultProviderInstance(provider)]);
        continue;
      }
      entries.sort((left, right) => {
        if (left.isDefault !== right.isDefault) {
          return left.isDefault ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      });
    }
    return map;
  }, [props.providerInstances]);

  const getProviderInstances = useCallback(
    (provider: ProviderKind): ReadonlyArray<ProviderModelPickerInstance> =>
      providerInstancesByProvider.get(provider) ?? [defaultProviderInstance(provider)],
    [providerInstancesByProvider],
  );

  const isInstanceSelectable = useCallback(
    (instance: ProviderModelPickerInstance): boolean => {
      if (!instance.enabled) {
        return false;
      }
      return !resolveLiveProviderAvailability(
        findProviderStatusForInstance({
          providers: props.providers,
          provider: instance.provider,
          instanceId: instance.instanceId,
        }),
      ).disabled;
    },
    [props.providers],
  );

  const getSelectedInstanceIdForProvider = useCallback(
    (provider: ProviderKind): ProviderInstanceId => {
      const instances = getProviderInstances(provider);
      if (activeProvider === provider) {
        // The active instance id is identity-bearing. Keep a removed id selected
        // so callers can present an explicit missing state instead of making a
        // healthy sibling look selected while the saved value still points at
        // the removed account.
        return selectedProviderInstanceId;
      }
      return (
        instances.find(isInstanceSelectable)?.instanceId ??
        instances.find((instance) => instance.isDefault)?.instanceId ??
        instances[0]!.instanceId
      );
    },
    [activeProvider, getProviderInstances, isInstanceSelectable, selectedProviderInstanceId],
  );

  const getModelOptionsForProviderInstance = useCallback(
    (provider: ProviderKind, instanceId: ProviderInstanceId): ReadonlyArray<ProviderModelOption> =>
      resolveModelOptionsForProviderInstance({
        provider,
        instanceId,
        modelOptionsByProvider: props.modelOptionsByProvider,
        modelOptionsByProviderInstance: props.modelOptionsByProviderInstance,
      }),
    [props.modelOptionsByProvider, props.modelOptionsByProviderInstance],
  );

  const resolveInstanceAvailability = useCallback(
    (instance: ProviderModelPickerInstance): { disabled: boolean; label: string | null } => {
      if (!instance.enabled) {
        return { disabled: true, label: "Disabled" };
      }
      return resolveLiveProviderAvailability(
        findProviderStatusForInstance({
          providers: props.providers,
          provider: instance.provider,
          instanceId: instance.instanceId,
        }),
      );
    },
    [props.providers],
  );

  const resolveProviderOptionAvailability = useCallback(
    (provider: ProviderKind): { disabled: boolean; label: string | null } => {
      const instanceAvailabilities = getProviderInstances(provider).map(
        resolveInstanceAvailability,
      );
      if (instanceAvailabilities.some((availability) => !availability.disabled)) {
        return { disabled: false, label: null };
      }
      return instanceAvailabilities[0] ?? { disabled: true, label: "Unavailable" };
    },
    [getProviderInstances, resolveInstanceAvailability],
  );

  const handleModelChange = (
    provider: ProviderKind,
    value: string,
    instanceId = getSelectedInstanceIdForProvider(provider),
  ) => {
    if (props.disabled) return;
    if (!value) return;
    const providerOptions = getModelOptionsForProviderInstance(provider, instanceId);
    const resolvedModel = resolveSelectableModel(provider, value, providerOptions);
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel, instanceId);
    onAfterSelection?.();
  };

  const handleInstanceChange = (provider: ProviderKind, instanceId: ProviderInstanceId) => {
    if (props.disabled || !instanceId) return;
    const providerOptions = getModelOptionsForProviderInstance(provider, instanceId);
    const model = activeProvider === provider ? props.model : (providerOptions[0]?.slug ?? "");
    if (!model) return;
    const resolvedModel = resolveSelectableModel(provider, model, providerOptions);
    props.onProviderModelChange(
      provider,
      resolvedModel ?? providerOptions[0]?.slug ?? model,
      instanceId,
    );
  };

  const renderProviderInstanceRadioGroup = (provider: ProviderKind) => {
    const instances = getProviderInstances(provider);
    const selectedInstanceId = getSelectedInstanceIdForProvider(provider);
    const selectedInstanceIsMissing =
      activeProvider === provider &&
      !instances.some((instance) => instance.instanceId === selectedInstanceId);
    if (
      props.showProviderInstanceChoices === false ||
      (instances.length <= 1 && !selectedInstanceIsMissing)
    ) {
      return null;
    }
    const sectionLabel =
      provider === "codex" || provider === "claudeAgent" ? "Accounts" : "Profiles";
    return (
      <>
        <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-[0.08em]">
          {sectionLabel}
        </div>
        <MenuRadioGroup
          value={selectedInstanceId}
          onValueChange={(value) => {
            if (props.disabled || !value) {
              return;
            }
            handleInstanceChange(provider, value);
          }}
        >
          {selectedInstanceIsMissing ? (
            <MenuRadioItem value={selectedInstanceId} disabled>
              <span className="truncate">{MISSING_PROVIDER_INSTANCE_LABEL}</span>
              <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                Unavailable
              </span>
            </MenuRadioItem>
          ) : null}
          {instances.map((instance) => {
            const availability = resolveInstanceAvailability(instance);
            return (
              <MenuRadioItem
                key={instance.instanceId}
                value={instance.instanceId}
                disabled={availability.disabled}
              >
                <span className="truncate">{instance.label}</span>
                {availability.label ? (
                  <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                    {availability.label}
                  </span>
                ) : null}
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
      </>
    );
  };

  const favoriteModels = props.favoriteModels;
  const onFavoriteModelsChange = props.onFavoriteModelsChange;
  const toggleFavoriteModel = useCallback(
    (provider: FavoriteModelProvider, instanceId: ProviderInstanceId, slug: string) => {
      if (onFavoriteModelsChange) {
        const normalizedFavorites = normalizeFavoriteModels(favoriteModels ?? []);
        const key = favoriteModelKey(instanceId, slug);
        const hasFavorite = normalizedFavorites.some(
          (favorite) => favoriteModelKey(favorite.provider, favorite.model) === key,
        );
        onFavoriteModelsChange(
          hasFavorite
            ? normalizedFavorites.filter(
                (favorite) => favoriteModelKey(favorite.provider, favorite.model) !== key,
              )
            : [...normalizedFavorites, { provider: instanceId, model: slug }],
        );
        return;
      }
      if (!supportsLegacyModelFavorites(provider)) {
        return;
      }
      const setFavoriteModelSlugs =
        provider === "cursor"
          ? setCursorFavoriteModelSlugs
          : provider === "kilo"
            ? setKiloFavoriteModelSlugs
            : provider === "pi"
              ? setPiFavoriteModelSlugs
              : setOpenCodeFavoriteModelSlugs;
      setFavoriteModelSlugs((current) =>
        toggleFavoriteModelKey(current, provider, instanceId, slug),
      );
    },
    [
      favoriteModels,
      onFavoriteModelsChange,
      setCursorFavoriteModelSlugs,
      setKiloFavoriteModelSlugs,
      setOpenCodeFavoriteModelSlugs,
      setPiFavoriteModelSlugs,
    ],
  );

  const renderModelRadioGroup = (provider: ProviderKind) => {
    if (props.loadingModelProviders?.[provider]) {
      return (
        <div className="space-y-2 px-2 py-2" aria-label="Loading models">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className={cn("h-3.5 rounded-full", index % 3 === 0 ? "w-24" : "w-32")} />
            </div>
          ))}
        </div>
      );
    }

    const providerOptions = getModelOptionsForProviderInstance(
      provider,
      getSelectedInstanceIdForProvider(provider),
    );
    const shouldShowSearch =
      (provider === "kilo" ||
        provider === "opencode" ||
        provider === "cursor" ||
        provider === "pi") &&
      providerOptions.length >= SEARCHABLE_MODEL_PICKER_THRESHOLD;
    const normalizedModelSearchQuery = deferredModelSearchQuery.trim().toLowerCase();
    const filteredOptions =
      shouldShowSearch && normalizedModelSearchQuery.length > 0
        ? providerOptions.filter((option) =>
            buildModelSearchText(option).includes(normalizedModelSearchQuery),
          )
        : providerOptions;
    const favoriteProvider =
      props.onFavoriteModelsChange || supportsLegacyModelFavorites(provider) ? provider : null;
    const selectedInstanceId = getSelectedInstanceIdForProvider(provider);
    const favoriteModelKeySet =
      favoriteProvider !== null ? favoriteModelSlugSets[favoriteProvider] : undefined;
    const favoriteModelSlugSet =
      favoriteProvider !== null && favoriteModelKeySet !== undefined
        ? favoriteModelSlugsForInstance({
            provider: favoriteProvider,
            instanceId: selectedInstanceId,
            keys: favoriteModelKeySet,
          })
        : undefined;
    const groupedOptions =
      favoriteModelSlugSet !== undefined
        ? groupProviderModelOptionsWithFavorites({
            options: filteredOptions,
            favoriteSlugs: favoriteModelSlugSet,
          })
        : groupProviderModelOptions(filteredOptions);

    const content =
      groupedOptions.length > 0 ? (
        <MenuRadioGroup
          value={activeProvider === provider ? props.model : ""}
          onValueChange={(value) => handleModelChange(provider, value)}
        >
          <ProviderModelOptionGroupList
            groupedOptions={groupedOptions}
            provider={provider}
            activeModel={props.model}
            isSearching={normalizedModelSearchQuery.length > 0}
            instanceId={selectedInstanceId}
            favoriteProvider={favoriteProvider}
            favoriteModelSlugSet={favoriteModelSlugSet}
            onToggleFavorite={toggleFavoriteModel}
            {...(onAfterSelection ? { onAfterSelection } : {})}
          />
        </MenuRadioGroup>
      ) : (
        <div className="px-2 py-2 text-muted-foreground text-sm">
          {provider === "pi" && normalizedModelSearchQuery.length === 0
            ? "No Pi models found"
            : "No matches"}
        </div>
      );

    if (!shouldShowSearch) {
      const needsScrollContainer =
        filteredOptions.length >= SEARCHABLE_MODEL_PICKER_THRESHOLD ||
        shouldUseCollapsibleModelGroups(groupedOptions.length, false);
      if (needsScrollContainer) {
        return (
          <div
            className={cn(
              "overflow-y-auto overscroll-contain py-0.5",
              COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
              COMPOSER_PICKER_MODEL_LIST_MAX_HEIGHT_CLASS_NAME,
            )}
          >
            {content}
          </div>
        );
      }
      return content;
    }

    return (
      <PickerPanelShell
        searchPlaceholder="Search models or providers"
        query={modelSearchQuery}
        onQueryChange={setModelSearchQuery}
        stopSearchKeyPropagation
        autoFocusSearch
        widthClassName="w-full"
        bleedParentPadding
        listMaxHeightClassName={COMPOSER_PICKER_MODEL_LIST_MAX_HEIGHT_CLASS_NAME}
      >
        {content}
      </PickerPanelShell>
    );
  };

  if (props.lockedProvider !== null) {
    return (
      <>
        {renderProviderInstanceRadioGroup(props.lockedProvider)}
        {renderModelRadioGroup(props.lockedProvider)}
      </>
    );
  }

  return (
    <>
      {visibleAvailableProviderOptions.map((option) => {
        const OptionIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[option.value];
        const availability = resolveProviderOptionAvailability(option.value);
        if (availability.disabled) {
          return (
            <MenuItem key={option.value} disabled>
              <OptionIcon
                aria-hidden="true"
                className={cn(
                  "size-3 shrink-0 opacity-80",
                  providerIconClassName(option.value, "text-muted-foreground/85"),
                )}
              />
              <span>{option.label}</span>
              <span className="ms-auto text-[11px] text-muted-foreground/80">
                {availability.label}
              </span>
            </MenuItem>
          );
        }
        return (
          <MenuSub key={option.value}>
            <MenuSubTrigger>
              <OptionIcon
                aria-hidden="true"
                className={cn(
                  "size-3 shrink-0",
                  providerIconClassName(option.value, "text-muted-foreground/85"),
                )}
              />
              {option.label}
            </MenuSubTrigger>
            <ComposerPickerMenuSubPopup
              fixedWidth
              className={COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME}
            >
              {renderProviderInstanceRadioGroup(option.value)}
              {renderModelRadioGroup(option.value)}
            </ComposerPickerMenuSubPopup>
          </MenuSub>
        );
      })}
      {visibleUnavailableProviderOptions.length > 0 && <MenuSeparator />}
      {visibleUnavailableProviderOptions.map((option) => {
        const OptionIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[option.value];
        return (
          <MenuItem key={option.value} disabled>
            <OptionIcon
              aria-hidden="true"
              className="size-3 shrink-0 text-muted-foreground/85 opacity-80"
            />
            <span>{option.label}</span>
            <span className="ms-auto text-[11px] text-muted-foreground/80">Coming soon</span>
          </MenuItem>
        );
      })}
      {visibleUnsupportedProviderInstances.length > 0 && <MenuSeparator />}
      {visibleUnsupportedProviderInstances.map((providerStatus) => (
        <MenuItem
          key={providerStatus.instanceId ?? providerStatus.driver ?? providerStatus.provider}
          disabled
        >
          <span className="truncate">
            {providerStatus.displayName ??
              providerStatus.instanceId ??
              providerStatus.driver ??
              providerStatus.provider}
          </span>
          <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
            Missing driver
          </span>
        </MenuItem>
      ))}
    </>
  );
});

// Resolves the human-readable label for the currently selected model.
export function resolveProviderModelLabel(input: {
  provider: ProviderKind;
  lockedProvider: ProviderKind | null;
  model: ModelSlug;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  modelOptionsByProviderInstance?: ProviderModelOptionsByProviderInstance | undefined;
  selectedProviderInstanceId?: ProviderInstanceId | undefined;
}): string {
  const activeProvider = input.lockedProvider ?? input.provider;
  const activeInstanceId = input.selectedProviderInstanceId ?? activeProvider;
  return resolveSelectedModelLabel({
    provider: activeProvider,
    model: input.model,
    options: resolveModelOptionsForProviderInstance({
      provider: activeProvider,
      instanceId: activeInstanceId,
      modelOptionsByProvider: input.modelOptionsByProvider,
      modelOptionsByProviderInstance: input.modelOptionsByProviderInstance,
    }),
  });
}

export function getProviderIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string = "text-muted-foreground/70",
): string {
  return providerIconClassName(provider, fallbackClassName);
}

type ProviderModelPickerProps = {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  modelOptionsByProviderInstance?: ProviderModelOptionsByProviderInstance;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance>;
  selectedProviderInstanceId?: ProviderInstanceId;
  showProviderInstanceChoices?: boolean;
  favoriteModels?: ReadonlyArray<ProviderModelFavorite>;
  onFavoriteModelsChange?: (favoriteModels: ProviderModelFavorite[]) => void;
  activeProviderIconClassName?: string;
  compact?: boolean;
  // Icon-only trigger for narrow composers; the model name moves to title/sr-only.
  hideLabel?: boolean;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelectionCommitted?: () => void;
  shortcutLabel?: string | null;
  onProviderModelChange: (
    provider: ProviderKind,
    model: ModelSlug,
    instanceId?: ProviderInstanceId,
  ) => void;
};

export const ProviderModelPicker = memo(function ProviderModelPicker(
  props: ProviderModelPickerProps,
) {
  const { onOpenChange, onSelectionCommitted, open } = props;
  const [uncontrolledMenuOpen, setUncontrolledMenuOpen] = useState(false);
  const selectionCommitTimerRef = useRef<number | null>(null);
  const isMenuOpen = open ?? uncontrolledMenuOpen;
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedModelLabel = resolveProviderModelLabel({
    provider: props.provider,
    lockedProvider: props.lockedProvider,
    model: props.model,
    modelOptionsByProvider: props.modelOptionsByProvider,
    modelOptionsByProviderInstance: props.modelOptionsByProviderInstance,
    selectedProviderInstanceId: props.selectedProviderInstanceId,
  });
  const selectedProviderInstanceIsMissing =
    props.showProviderInstanceChoices !== false &&
    props.providerInstances !== undefined &&
    props.selectedProviderInstanceId !== undefined &&
    !props.providerInstances.some(
      (instance) =>
        instance.provider === activeProvider &&
        instance.instanceId === props.selectedProviderInstanceId,
    );
  const triggerLabel = selectedProviderInstanceIsMissing
    ? `${MISSING_PROVIDER_INSTANCE_LABEL} · ${selectedModelLabel}`
    : selectedModelLabel;
  const ProviderIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[activeProvider];

  const setMenuOpen = useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) {
        setUncontrolledMenuOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, open],
  );
  const scheduleSelectionCommitted = useCallback(() => {
    if (selectionCommitTimerRef.current !== null) {
      window.clearTimeout(selectionCommitTimerRef.current);
    }
    // Base UI restores focus to the trigger while closing; refocus callers after that tick.
    selectionCommitTimerRef.current = window.setTimeout(() => {
      selectionCommitTimerRef.current = null;
      onSelectionCommitted?.();
    }, 0);
  }, [onSelectionCommitted]);
  useEffect(
    () => () => {
      if (selectionCommitTimerRef.current !== null) {
        window.clearTimeout(selectionCommitTimerRef.current);
      }
    },
    [],
  );

  const handleAfterSelection = useCallback(() => {
    setMenuOpen(false);
    scheduleSelectionCommitted();
  }, [scheduleSelectionCommitted, setMenuOpen]);

  const triggerButton = (
    <PickerTriggerButton
      disabled={props.disabled ?? false}
      compact={props.compact ?? false}
      hideLabel={props.hideLabel ?? false}
      icon={
        <ProviderIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0",
            providerIconClassName(activeProvider, "text-muted-foreground/70"),
            props.activeProviderIconClassName,
          )}
        />
      }
      label={triggerLabel}
    />
  );

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(nextOpen) => {
        if (props.disabled) {
          setMenuOpen(false);
          return;
        }
        setMenuOpen(nextOpen);
      }}
    >
      {props.shortcutLabel ? (
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger render={triggerButton} />}>
            <span className="sr-only">{triggerLabel}</span>
          </TooltipTrigger>
          {!isMenuOpen ? (
            <TooltipPopup side="top" sideOffset={6} variant="picker">
              <span className="inline-flex items-center gap-2 px-1 py-0.5">
                <span>Change model</span>
                <ShortcutKbd
                  shortcutLabel={props.shortcutLabel}
                  className="h-4 min-w-4 px-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground"
                />
              </span>
            </TooltipPopup>
          ) : null}
        </Tooltip>
      ) : (
        <MenuTrigger render={triggerButton}>
          <span className="sr-only">{triggerLabel}</span>
        </MenuTrigger>
      )}
      <ComposerPickerMenuPopup align="start" fixedWidth={props.lockedProvider !== null}>
        <ProviderModelMenuItems
          provider={props.provider}
          model={props.model}
          lockedProvider={props.lockedProvider}
          {...(props.providers ? { providers: props.providers } : {})}
          modelOptionsByProvider={props.modelOptionsByProvider}
          {...(props.modelOptionsByProviderInstance
            ? { modelOptionsByProviderInstance: props.modelOptionsByProviderInstance }
            : {})}
          {...(props.loadingModelProviders
            ? { loadingModelProviders: props.loadingModelProviders }
            : {})}
          {...(props.hiddenProviders ? { hiddenProviders: props.hiddenProviders } : {})}
          {...(props.providerOrder ? { providerOrder: props.providerOrder } : {})}
          {...(props.providerInstances ? { providerInstances: props.providerInstances } : {})}
          {...(props.selectedProviderInstanceId
            ? { selectedProviderInstanceId: props.selectedProviderInstanceId }
            : {})}
          {...(props.showProviderInstanceChoices !== undefined
            ? { showProviderInstanceChoices: props.showProviderInstanceChoices }
            : {})}
          {...(props.favoriteModels ? { favoriteModels: props.favoriteModels } : {})}
          {...(props.onFavoriteModelsChange
            ? { onFavoriteModelsChange: props.onFavoriteModelsChange }
            : {})}
          {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
          onProviderModelChange={props.onProviderModelChange}
          onAfterSelection={handleAfterSelection}
        />
      </ComposerPickerMenuPopup>
    </Menu>
  );
});
