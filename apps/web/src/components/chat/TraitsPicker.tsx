// FILE: TraitsPicker.tsx
// Purpose: Renders composer trait controls for effort, thinking, and fast mode across menu surfaces.
// Layer: Chat composer presentation
// Depends on: shared trait resolution helpers, provider model option updates, and shared menu primitives.

import { type ProviderKind, type ThreadId } from "@t3tools/contracts";
import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";
import { memo, useCallback, useState } from "react";
import { IoFlash } from "react-icons/io5";
import { ChevronDownIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore } from "../../composerDraftStore";
import { buildNextProviderOptions, type ProviderOptions } from "../../providerModelOptions";
import { COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME } from "./composerPickerStyles";
import { getComposerTraitSelection } from "./composerTraits";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ShortcutKbd } from "../ui/shortcut-kbd";

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

export interface TraitsMenuContentProps {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  includeFastMode?: boolean;
  modelOptions?: ProviderOptions | null | undefined;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  threadId,
  model,
  prompt,
  onPromptChange,
  includeFastMode = true,
  modelOptions,
}: TraitsMenuContentProps) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const {
    caps,
    defaultEffort,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    ultrathinkPromptControlled,
  } = getComposerTraitSelection(provider, model, prompt, modelOptions);

  const handleEffortChange = useCallback(
    (value: string) => {
      if (ultrathinkPromptControlled) return;
      if (!value) return;
      const nextOption = effortLevels.find((option) => option.value === value);
      if (!nextOption) return;
      if (caps.promptInjectedEffortLevels.includes(nextOption.value)) {
        const nextPrompt =
          prompt.trim().length === 0
            ? ULTRATHINK_PROMPT_PREFIX
            : applyClaudePromptEffortPrefix(prompt, "ultrathink");
        onPromptChange(nextPrompt);
        return;
      }
      const effortKey = provider === "codex" ? "reasoningEffort" : "effort";
      setProviderModelOptions(
        threadId,
        provider,
        buildNextProviderOptions(provider, modelOptions, { [effortKey]: nextOption.value }),
        { persistSticky: true },
      );
    },
    [
      ultrathinkPromptControlled,
      modelOptions,
      onPromptChange,
      threadId,
      setProviderModelOptions,
      effortLevels,
      prompt,
      caps.promptInjectedEffortLevels,
      provider,
    ],
  );

  if (effort === null && thinkingEnabled === null) {
    return null;
  }

  return (
    <>
      {effort ? (
        <>
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Effort</div>
            {ultrathinkPromptControlled ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                Remove Ultrathink from the prompt to change effort.
              </div>
            ) : null}
            <MenuRadioGroup value={effort} onValueChange={handleEffortChange}>
              {effortLevels.map((option) => (
                <MenuRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={ultrathinkPromptControlled}
                >
                  {option.label}
                  {option.value === defaultEffort ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : thinkingEnabled !== null ? (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Thinking</div>
          <MenuRadioGroup
            value={thinkingEnabled ? "on" : "off"}
            onValueChange={(value) => {
              setProviderModelOptions(
                threadId,
                provider,
                buildNextProviderOptions(provider, modelOptions, { thinking: value === "on" }),
                { persistSticky: true },
              );
            }}
          >
            <MenuRadioItem value="on">On (default)</MenuRadioItem>
            <MenuRadioItem value="off">Off</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {includeFastMode && caps.supportsFastMode ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
            <MenuRadioGroup
              value={fastModeEnabled ? "on" : "off"}
              onValueChange={(value) => {
                setProviderModelOptions(
                  threadId,
                  provider,
                  buildNextProviderOptions(provider, modelOptions, { fastMode: value === "on" }),
                  { persistSticky: true },
                );
              }}
            >
              <MenuRadioItem value="off">off</MenuRadioItem>
              <MenuRadioItem value="on">on</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
    </>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  threadId,
  model,
  prompt,
  onPromptChange,
  includeFastMode = true,
  modelOptions,
  open,
  onOpenChange,
  shortcutLabel,
}: TraitsMenuContentProps & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutLabel?: string | null;
}) {
  const [uncontrolledMenuOpen, setUncontrolledMenuOpen] = useState(false);
  const isMenuOpen = open ?? uncontrolledMenuOpen;
  const setMenuOpen = useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) {
        setUncontrolledMenuOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, open],
  );
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    ultrathinkPromptControlled,
  } = getComposerTraitSelection(provider, model, prompt, modelOptions);

  const effortLabel = effort
    ? (effortLevels.find((l) => l.value === effort)?.label ?? effort)
    : null;
  const primaryTriggerLabel = ultrathinkPromptControlled
    ? "Ultrathink"
    : effortLabel
      ? effortLabel
      : thinkingEnabled === null
        ? null
        : `Thinking ${thinkingEnabled ? "On" : "Off"}`;
  const showsFastBadge = caps.supportsFastMode && fastModeEnabled;

  const isCodexStyle = provider === "codex";

  const triggerButton = (
    <Button
      size="sm"
      variant="ghost"
      className={
        isCodexStyle
          ? `min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 sm:max-w-48 sm:px-3 [&_svg]:mx-0 ${COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME}`
          : `shrink-0 whitespace-nowrap px-2 sm:px-3 ${COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME}`
      }
    />
  );

  const triggerContent = isCodexStyle ? (
    <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
      <span className="min-w-0 flex flex-1 items-center gap-1.5 truncate">
        {primaryTriggerLabel ? <span className="truncate">{primaryTriggerLabel}</span> : null}
        {showsFastBadge ? (
          <>
            {primaryTriggerLabel ? (
              <span className="shrink-0 text-muted-foreground/45">·</span>
            ) : null}
            <span className="inline-flex shrink-0 items-center gap-1">
              <IoFlash aria-hidden="true" className="size-3 text-[hsl(var(--chart-4))]" />
              <span>Fast</span>
            </span>
          </>
        ) : null}
      </span>
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
    </span>
  ) : (
    <>
      <span className="inline-flex items-center gap-1.5">
        {primaryTriggerLabel ? <span>{primaryTriggerLabel}</span> : null}
        {showsFastBadge ? (
          <>
            {primaryTriggerLabel ? <span className="text-muted-foreground/45">·</span> : null}
            <span className="inline-flex items-center gap-1">
              <IoFlash aria-hidden="true" className="size-3 text-[hsl(var(--chart-4))]" />
              <span>Fast</span>
            </span>
          </>
        ) : null}
      </span>
      <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
    </>
  );

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
      }}
    >
      {shortcutLabel && !isMenuOpen ? (
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger render={triggerButton} />}>
            {triggerContent}
          </TooltipTrigger>
          <TooltipPopup side="top" sideOffset={6}>
            <span className="inline-flex items-center gap-2 px-1 py-0.5">
              <span>Change reasoning</span>
              <ShortcutKbd
                shortcutLabel={shortcutLabel}
                className="h-4 min-w-4 px-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground"
              />
            </span>
          </TooltipPopup>
        </Tooltip>
      ) : (
        <MenuTrigger render={triggerButton}>{triggerContent}</MenuTrigger>
      )}
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          threadId={threadId}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeFastMode={includeFastMode}
          modelOptions={modelOptions}
        />
      </MenuPopup>
    </Menu>
  );
});
