import type { ProviderModelDescriptor } from "@synara/contracts";
import { useState } from "react";

import { useTranslation } from "~/i18n";
import { FastModeIcon, FastModeOutlineIcon, UltrafastModeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubTrigger,
  MenuSubTriggerBase,
} from "../ui/menu";
import { ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import { COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME } from "./composerPickerStyles";
import { type ComposerTraitSelection, supportsComposerFastModeControl } from "./composerTraits";

export function ComposerUltrafastMenu(props: {
  compact?: boolean;
  selection: ComposerTraitSelection;
  runtimeModel: ProviderModelDescriptor | undefined;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { selection, runtimeModel } = props;
  const speedLabel = t("chat:traitsPicker_speed");
  const standard = {
    value: "default",
    label: t("chat:standard"),
    description: t("chat:speedStandardDescription"),
  };
  const fast = {
    value: "fast",
    label: t("chat:traitsPicker_fast"),
    description: runtimeModel?.fastModeDescription ?? t("chat:speedFastDescription"),
  };
  const ultrafast = {
    value: "ultrafast",
    label: t("chat:traitsPicker_ultrafast"),
    description: runtimeModel?.ultrafastModeDescription ?? t("chat:speedUltrafastDescription"),
  };
  const options = supportsComposerFastModeControl(selection)
    ? [standard, fast, ultrafast]
    : [standard, ultrafast];
  const selected = selection.ultrafastModeEnabled
    ? ultrafast
    : selection.fastModeEnabled
      ? fast
      : standard;

  return (
    <MenuSub open={open} onOpenChange={setOpen}>
      {props.compact ? (
        <MenuSubTriggerBase
          aria-label={speedLabel}
          aria-description={selected.label}
          className={cn(
            "flex size-6 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-foreground/6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--color-border-focus)]/60 data-popup-open:bg-foreground/6",
            selected === standard ? "text-muted-foreground/70" : "text-[var(--color-text-accent)]",
          )}
        >
          {selected === ultrafast ? (
            <UltrafastModeIcon />
          ) : selected === fast ? (
            <FastModeIcon aria-hidden="true" className="size-3.5" />
          ) : (
            <FastModeOutlineIcon aria-hidden="true" className="size-3.5" />
          )}
        </MenuSubTriggerBase>
      ) : (
        <MenuSubTrigger>
          <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <span className="truncate">{speedLabel}</span>
            <span className={cn("flex items-center gap-1", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}>
              {selected === ultrafast ? <UltrafastModeIcon /> : null}
              {selected.label}
            </span>
          </span>
        </MenuSubTrigger>
      )}
      <ComposerPickerMenuSubPopup fixedWidth>
        <MenuRadioGroup
          value={selected.value}
          onValueChange={(value) =>
            props.onChange(
              value === ultrafast.value
                ? { serviceTier: "ultrafast" }
                : { fastMode: value === fast.value },
            )
          }
        >
          {options.map((option) => (
            <MenuRadioItem
              key={option.value}
              value={option.value}
              label={option.label}
              aria-label={option.label}
              aria-description={option.description}
              className="py-1.5"
              onClick={() => setOpen(false)}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{option.label}</span>
                <span className="text-ui-sm leading-snug text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </ComposerPickerMenuSubPopup>
    </MenuSub>
  );
}
