// FILE: ProviderModelOptionGroupList.tsx
// Purpose: Renders grouped provider model radio items with optional collapsible sections.
// Layer: Chat composer presentation
// Depends on: menu radio primitives, collapsible UI, and provider model grouping helpers.

import { memo, useState } from "react";

import { StarFilledIcon, StarIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  resolveModelGroupDefaultOpen,
  shouldUseCollapsibleModelGroups,
  type ProviderModelOption,
  type ProviderModelOptionGroup,
} from "../../providerModelOptions";
import type { ProviderKind } from "@t3tools/contracts";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { MenuGroup, MenuGroupLabel, MenuRadioItem } from "../ui/menu";
import {
  COMPOSER_PICKER_MODEL_GROUP_HEADER_CLASS_NAME,
  COMPOSER_PICKER_RADIUS_CLASS_NAME,
  COMPOSER_PICKER_SECTION_LABEL_CLASS_NAME,
} from "./composerPickerStyles";

type FavoriteModelProvider = "cursor" | "kilo" | "opencode" | "pi";

type ProviderModelOptionGroupListProps = {
  groupedOptions: ReadonlyArray<ProviderModelOptionGroup>;
  provider: ProviderKind;
  activeModel: string;
  isSearching: boolean;
  favoriteProvider: FavoriteModelProvider | null;
  favoriteModelSlugSet: ReadonlySet<string> | undefined;
  onToggleFavorite: (provider: FavoriteModelProvider, slug: string) => void;
  onAfterSelection?: () => void;
};

function ProviderModelRadioItem(
  props: Readonly<{
    provider: ProviderKind;
    modelOption: ProviderModelOption;
    favoriteProvider: FavoriteModelProvider | null;
    isFavorite: boolean;
    onToggleFavorite: (provider: FavoriteModelProvider, slug: string) => void;
    onAfterSelection?: () => void;
  }>,
) {
  const { provider, modelOption, favoriteProvider, isFavorite, onToggleFavorite, onAfterSelection } =
    props;
  const supportsFavorites = favoriteProvider !== null;

  return (
    <MenuRadioItem
      key={`${provider}:${modelOption.slug}`}
      value={modelOption.slug}
      onClick={() => {
        onAfterSelection?.();
      }}
    >
      {supportsFavorites ? (
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="block min-w-0 flex-1 truncate">{modelOption.name}</span>
          <button
            type="button"
            aria-label={
              isFavorite
                ? `Remove ${modelOption.name} from favourites`
                : `Add ${modelOption.name} to favourites`
            }
            className={cn(
              cn(
                "-me-2 ms-auto inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground/55 transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
                COMPOSER_PICKER_RADIUS_CLASS_NAME,
              ),
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
              <StarFilledIcon aria-hidden="true" className="size-3.5" />
            ) : (
              <StarIcon aria-hidden="true" className="size-3.5" />
            )}
          </button>
        </span>
      ) : (
        modelOption.name
      )}
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
        <DisclosureChevron open={open} className="size-3 shrink-0 opacity-50" />
        <span className="min-w-0 flex-1 truncate normal-case tracking-normal">{props.group.label}</span>
        <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-1.5 py-px text-[9px] font-normal tabular-nums normal-case tracking-normal text-muted-foreground/70">
          {props.group.options.length}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel className="pb-0.5">{props.children}</CollapsiblePanel>
    </Collapsible>
  );
}

export const ProviderModelOptionGroupList = memo(function ProviderModelOptionGroupList(
  props: ProviderModelOptionGroupListProps,
) {
  const useCollapsibleGroups = shouldUseCollapsibleModelGroups(
    props.groupedOptions.length,
    props.isSearching,
  );

  return (
    <div className="flex flex-col gap-0.5">
      {props.groupedOptions.map((group) => {
        const groupItems = group.options.map((modelOption) => (
          <ProviderModelRadioItem
            key={`${props.provider}:${modelOption.slug}`}
            provider={props.provider}
            modelOption={modelOption}
            favoriteProvider={props.favoriteProvider}
            isFavorite={props.favoriteModelSlugSet?.has(modelOption.slug) ?? false}
            onToggleFavorite={props.onToggleFavorite}
            {...(props.onAfterSelection ? { onAfterSelection: props.onAfterSelection } : {})}
          />
        ));

        if (group.label === null) {
          return (
            <MenuGroup key={`${props.provider}:${group.key}`} className="px-0.5">
              {groupItems}
            </MenuGroup>
          );
        }

        if (useCollapsibleGroups) {
          return (
            <CollapsibleModelGroup
              key={`${props.provider}:${group.key}`}
              group={group}
              defaultOpen={resolveModelGroupDefaultOpen({
                groupKey: group.key,
                options: group.options,
                activeModel: props.activeModel,
                groupCount: props.groupedOptions.length,
              })}
            >
              {groupItems}
            </CollapsibleModelGroup>
          );
        }

        return (
          <MenuGroup key={`${props.provider}:${group.key}`} className="px-0.5">
            <MenuGroupLabel className={COMPOSER_PICKER_SECTION_LABEL_CLASS_NAME}>
              {group.label}
            </MenuGroupLabel>
            {groupItems}
          </MenuGroup>
        );
      })}
    </div>
  );
});
