// FILE: ProviderModelOptionGroupList.tsx
// Purpose: Renders saved favourites and grouped model choices for every provider.
// Layer: Chat composer presentation
// Depends on: menu radio primitives, collapsible UI, and provider model grouping helpers.

import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";

import { cn } from "~/lib/utils";
import {
  resolveModelGroupDefaultOpen,
  shouldUseCollapsibleModelGroups,
  displayProvenanceWithinProvider,
  providerModelCostMultiplierLabel,
  providerModelOptionProvenanceLabel,
  groupProviderModelOptionsWithFavorites,
  type ProviderModelOption,
  type ProviderModelOptionGroup,
} from "../../providerModelOptions";
<<<<<<< HEAD
import type { ProviderInstanceId, ProviderKind } from "@synara/contracts";
||||||| parent of d68c1c701 (feat(web): add provider model favourites and catalog navigation)
import type { ProviderKind } from "@synara/contracts";
=======
import { type ProviderKind } from "@synara/contracts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { FAVORITE_MODEL_STORAGE_KEYS } from "../../lib/modelFavorites";
>>>>>>> d68c1c701 (feat(web): add provider model favourites and catalog navigation)
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { MenuGroup, MenuGroupLabel, MenuRadioItem } from "../ui/menu";
import {
  COMPOSER_PICKER_MODEL_GROUP_HEADER_CLASS_NAME,
  COMPOSER_PICKER_MODEL_ROW_LABEL_INDENT_CLASS_NAME,
} from "./composerPickerStyles";
import { ModelStarButton } from "./ModelStarButton";
import { useTranslation } from "~/i18n";

const FavoriteModelSlugs = Schema.Array(Schema.String);
const EMPTY_FAVORITE_MODEL_SLUGS: ReadonlyArray<string> = [];

function toggleFavoriteModelSlug(current: ReadonlyArray<string>, slug: string): string[] {
  const normalized = Array.from(new Set(current.filter((entry) => entry.trim().length > 0)));
  return normalized.includes(slug)
    ? normalized.filter((entry) => entry !== slug)
    : [...normalized, slug];
}

function stopFavoriteActivationPropagation(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === "Enter" || event.key === " ") {
    event.stopPropagation();
  }
}

type ProviderModelOptionGroupListProps = {
  options: ReadonlyArray<ProviderModelOption>;
  provider: ProviderKind;
  activeModel: string;
  isSearching: boolean;
<<<<<<< HEAD
  instanceId: ProviderInstanceId;
  favoriteProvider: FavoriteModelProvider | null;
  favoriteModelSlugSet: ReadonlySet<string> | undefined;
  onToggleFavorite: (
    provider: FavoriteModelProvider,
    instanceId: ProviderInstanceId,
    slug: string,
  ) => void;
||||||| parent of d68c1c701 (feat(web): add provider model favourites and catalog navigation)
  favoriteProvider: FavoriteModelProvider | null;
  favoriteModelSlugSet: ReadonlySet<string> | undefined;
  onToggleFavorite: (provider: FavoriteModelProvider, slug: string) => void;
=======
>>>>>>> d68c1c701 (feat(web): add provider model favourites and catalog navigation)
  onAfterSelection?: () => void;
};

function ProviderModelRadioItem(
  props: Readonly<{
    provider: ProviderKind;
    modelOption: ProviderModelOption;
<<<<<<< HEAD
    instanceId: ProviderInstanceId;
    favoriteProvider: FavoriteModelProvider | null;
||||||| parent of d68c1c701 (feat(web): add provider model favourites and catalog navigation)
    favoriteProvider: FavoriteModelProvider | null;
=======
>>>>>>> d68c1c701 (feat(web): add provider model favourites and catalog navigation)
    isFavorite: boolean;
    showProvenance: boolean;
<<<<<<< HEAD
    onToggleFavorite: (
      provider: FavoriteModelProvider,
      instanceId: ProviderInstanceId,
      slug: string,
    ) => void;
||||||| parent of d68c1c701 (feat(web): add provider model favourites and catalog navigation)
    onToggleFavorite: (provider: FavoriteModelProvider, slug: string) => void;
=======
    indentLabel: boolean;
    onToggleFavorite: (slug: string, restoreFocus: boolean) => void;
>>>>>>> d68c1c701 (feat(web): add provider model favourites and catalog navigation)
    onAfterSelection?: () => void;
  }>,
) {
  const { t } = useTranslation();

  const {
    provider,
    modelOption,
<<<<<<< HEAD
    instanceId,
    favoriteProvider,
||||||| parent of d68c1c701 (feat(web): add provider model favourites and catalog navigation)
    favoriteProvider,
=======
>>>>>>> d68c1c701 (feat(web): add provider model favourites and catalog navigation)
    isFavorite,
    showProvenance,
    indentLabel,
    onToggleFavorite,
    onAfterSelection,
  } = props;
  const costMultiplierLabel =
    provider === "droid" ? providerModelCostMultiplierLabel(modelOption.description) : null;
  const provenance = providerModelOptionProvenanceLabel({ provider, option: modelOption });
  const provenanceLabel = showProvenance
    ? displayProvenanceWithinProvider({ provider, provenance })
    : null;
  const accessibleModelName = provenanceLabel
    ? `${modelOption.name} — ${provenanceLabel}`
    : modelOption.name;

  return (
    <MenuRadioItem
      key={`${provider}:${modelOption.slug}`}
      value={modelOption.slug}
      aria-label={
        costMultiplierLabel && modelOption.description
          ? `${accessibleModelName} ${modelOption.description}`
          : accessibleModelName
      }
      title={accessibleModelName}
      preserveChildLayout
      className={cn(
        "data-checked:bg-[var(--color-background-button-secondary)] data-checked:font-medium",
        costMultiplierLabel !== null && "grid-cols-[minmax(0,1fr)_auto]",
      )}
      trailing={
<<<<<<< HEAD
        supportsFavorites ? (
          <ModelStarButton
            starred={isFavorite}
            label={
||||||| parent of d68c1c701 (feat(web): add provider model favourites and catalog navigation)
        supportsFavorites ? (
          <button
            type="button"
            aria-label={
=======
        <>
          {costMultiplierLabel && modelOption.description ? (
            <span
              title={modelOption.description}
              className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground/65"
              aria-hidden="true"
            >
              {costMultiplierLabel}
            </span>
          ) : null}
          <button
            type="button"
            data-model-favorite-slug={modelOption.slug}
            aria-pressed={isFavorite}
            title={isFavorite ? "Remove from favourites" : "Add to favourites"}
            aria-label={
>>>>>>> d68c1c701 (feat(web): add provider model favourites and catalog navigation)
              isFavorite
                ? t("chat:removeFromFavourites", { value0: accessibleModelName })
                : t("chat:addToFavourites", { value0: accessibleModelName })
            }
<<<<<<< HEAD
            onToggle={() => onToggleFavorite(favoriteProvider, instanceId, modelOption.slug)}
          />
        ) : costMultiplierLabel && modelOption.description ? (
          <span
            title={modelOption.description}
            className="shrink-0 text-ui-xs font-medium tabular-nums text-muted-foreground/65"
          >
            <span aria-hidden="true">{costMultiplierLabel}</span>
            <span className="sr-only">{modelOption.description}</span>
          </span>
        ) : null
||||||| parent of d68c1c701 (feat(web): add provider model favourites and catalog navigation)
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground/50 transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
              COMPOSER_PICKER_RADIUS_CLASS_NAME,
              isFavorite && "text-amber-400 hover:text-amber-300",
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleFavorite(favoriteProvider, modelOption.slug);
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
          >
            {isFavorite ? (
              <StarFilledIcon aria-hidden="true" className="size-3" />
            ) : (
              <StarIcon aria-hidden="true" className="size-3" />
            )}
          </button>
        ) : costMultiplierLabel && modelOption.description ? (
          <span
            title={modelOption.description}
            className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground/65"
          >
            <span aria-hidden="true">{costMultiplierLabel}</span>
            <span className="sr-only">{modelOption.description}</span>
          </span>
        ) : null
=======
            className={cn(
              "-my-0.5 inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground/50 transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
              COMPOSER_PICKER_RADIUS_CLASS_NAME,
              isFavorite && "text-amber-400 hover:text-amber-300",
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleFavorite(
                modelOption.slug,
                event.currentTarget === event.currentTarget.ownerDocument.activeElement,
              );
            }}
            onKeyDown={stopFavoriteActivationPropagation}
            onKeyUp={stopFavoriteActivationPropagation}
            onFocus={(event) => {
              // The menu's roving focus must not move focus from the star to its model row.
              event.stopPropagation();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
          >
            {isFavorite ? (
              <StarFilledIcon aria-hidden="true" className="size-3" />
            ) : (
              <StarIcon aria-hidden="true" className="size-3" />
            )}
          </button>
        </>
>>>>>>> d68c1c701 (feat(web): add provider model favourites and catalog navigation)
      }
      onClick={() => {
        onAfterSelection?.();
      }}
    >
<<<<<<< HEAD
      {preserveChildLayout ? (
        <span
          className={cn(
            "flex min-w-0 flex-col",
            supportsFavorites && COMPOSER_PICKER_MODEL_ROW_LABEL_INDENT_CLASS_NAME,
          )}
        >
          <span className="block min-w-0 truncate">{modelOption.name}</span>
          {provenanceLabel ? (
            <span
              aria-hidden="true"
              className="block min-w-0 truncate text-ui-xs leading-tight text-muted-foreground/60"
            >
              {provenanceLabel}
            </span>
          ) : null}
||||||| parent of d68c1c701 (feat(web): add provider model favourites and catalog navigation)
      {preserveChildLayout ? (
        <span
          className={cn(
            "flex min-w-0 flex-col",
            supportsFavorites && COMPOSER_PICKER_MODEL_ROW_LABEL_INDENT_CLASS_NAME,
          )}
        >
          <span className="block min-w-0 truncate">{modelOption.name}</span>
          {provenanceLabel ? (
            <span
              aria-hidden="true"
              className="block min-w-0 truncate text-[10px] leading-tight text-muted-foreground/60"
            >
              {provenanceLabel}
            </span>
          ) : null}
=======
      <span
        className={cn(
          "flex min-w-0 flex-col gap-0.5",
          indentLabel && COMPOSER_PICKER_MODEL_ROW_LABEL_INDENT_CLASS_NAME,
        )}
      >
        <span className="block min-w-0 whitespace-normal break-words leading-snug">
          {modelOption.name}
>>>>>>> d68c1c701 (feat(web): add provider model favourites and catalog navigation)
        </span>
        {provenanceLabel ? (
          <span
            aria-hidden="true"
            className="block min-w-0 whitespace-normal break-words text-[length:var(--app-font-size-ui-xs,10px)] leading-tight text-muted-foreground"
          >
            {provenanceLabel}
          </span>
        ) : null}
      </span>
    </MenuRadioItem>
  );
}

function CollapsibleModelGroup(
  props: Readonly<{
    group: ProviderModelOptionGroup;
    defaultOpen: boolean;
    children: React.ReactNode;
  }>,
) {
  const [open, setOpen] = useState(props.defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="px-0.5">
      <CollapsibleTrigger
        className={cn(COMPOSER_PICKER_MODEL_GROUP_HEADER_CLASS_NAME, open && "text-foreground/75")}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
      >
        <DisclosureChevron open={open} className="col-start-1 size-3 shrink-0 opacity-50" />
        <span className="col-start-2 min-w-0 truncate normal-case tracking-normal">
          {props.group.label}
        </span>
        <span className="col-start-3 shrink-0 justify-self-end rounded-full bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-1.5 py-px text-ui-2xs font-normal tabular-nums normal-case tracking-normal text-muted-foreground/70">
          {props.group.options.length}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel className="flex flex-col gap-px pb-0.5">{props.children}</CollapsiblePanel>
    </Collapsible>
  );
}

export function ProviderModelOptionGroupList(props: ProviderModelOptionGroupListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const pendingFavoriteFocusRef = useRef<string | null>(null);
  const [favoriteModelSlugs, setFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS[props.provider],
    EMPTY_FAVORITE_MODEL_SLUGS,
    FavoriteModelSlugs,
  );
  const favoriteModelSlugSet = new Set(favoriteModelSlugs);
  const groupedOptions = groupProviderModelOptionsWithFavorites({
    options: props.options,
    favoriteSlugs: favoriteModelSlugSet,
  });
  const toggleFavoriteModel = (slug: string, restoreFocus: boolean) => {
    pendingFavoriteFocusRef.current = restoreFocus ? slug : null;
    setFavoriteModelSlugs((current) => toggleFavoriteModelSlug(current, slug));
  };
  useLayoutEffect(() => {
    const slug = pendingFavoriteFocusRef.current;
    if (slug === null) return;
    pendingFavoriteFocusRef.current = null;
    // Moving a row between sections remounts its star. Keep keyboard focus on that action.
    const star = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-model-favorite-slug="${CSS.escape(slug)}"]`,
    );
    const focusTarget = star ?? listRef.current?.closest<HTMLElement>('[role="menu"]');
    focusTarget?.focus();
  }, [favoriteModelSlugs]);
  const useCollapsibleGroups = shouldUseCollapsibleModelGroups(
    groupedOptions.length,
    props.isSearching,
  );

  return (
    <div ref={listRef} className="flex flex-col gap-px">
      {groupedOptions.map((group) => {
        const isCollapsible = useCollapsibleGroups && group.key !== "__favorites__";
        const groupItems = group.options.map((modelOption) => (
          <ProviderModelRadioItem
            key={`${props.provider}:${modelOption.slug}`}
            provider={props.provider}
            modelOption={modelOption}
<<<<<<< HEAD
            instanceId={props.instanceId}
            favoriteProvider={props.favoriteProvider}
            isFavorite={props.favoriteModelSlugSet?.has(modelOption.slug) ?? false}
||||||| parent of d68c1c701 (feat(web): add provider model favourites and catalog navigation)
            favoriteProvider={props.favoriteProvider}
            isFavorite={props.favoriteModelSlugSet?.has(modelOption.slug) ?? false}
=======
            isFavorite={favoriteModelSlugSet.has(modelOption.slug)}
>>>>>>> d68c1c701 (feat(web): add provider model favourites and catalog navigation)
            showProvenance={group.key === "__favorites__"}
            indentLabel={isCollapsible && group.label !== null}
            onToggleFavorite={toggleFavoriteModel}
            {...(props.onAfterSelection ? { onAfterSelection: props.onAfterSelection } : {})}
          />
        ));

        if (group.label === null) {
          return (
            <MenuGroup
              key={`${props.provider}:${group.key}`}
              className="flex flex-col gap-px px-0.5"
            >
              {groupItems}
            </MenuGroup>
          );
        }

        if (isCollapsible) {
          return (
            <CollapsibleModelGroup
              key={`${props.provider}:${group.key}`}
              group={group}
              defaultOpen={resolveModelGroupDefaultOpen({
                groupKey: group.key,
                options: group.options,
                activeModel: props.activeModel,
                groupCount: groupedOptions.length,
              })}
            >
              {groupItems}
            </CollapsibleModelGroup>
          );
        }

        return (
          <MenuGroup key={`${props.provider}:${group.key}`} className="flex flex-col gap-px px-0.5">
            <MenuGroupLabel className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
              {group.label}
            </MenuGroupLabel>
            {groupItems}
          </MenuGroup>
        );
      })}
    </div>
  );
}
