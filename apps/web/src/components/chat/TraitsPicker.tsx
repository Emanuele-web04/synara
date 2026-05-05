// FILE: TraitsPicker.tsx
// Purpose: Renders composer trait controls for effort, thinking, and fast mode across menu surfaces.
// Layer: Chat composer presentation
// Depends on: shared trait resolution helpers, provider model option updates, and shared menu primitives.

import { type ProviderKind, type ProviderModelDescriptor, type ThreadId } from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  geminiModelOptionsFromEffortValue,
} from "@t3tools/shared/model";
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
import { getComposerTraitSelection, hasVisibleComposerTraitControls } from "./composerTraits";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ShortcutKbd } from "../ui/shortcut-kbd";

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

export interface TraitsMenuContentProps {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string | null | undefined;
  runtimeModel?: ProviderModelDescriptor | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  includeFastMode?: boolean;
  modelOptions?: ProviderOptions | null | undefined;
  onSelectionComplete?: () => void;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  threadId,
  model,
  runtimeModel,
  prompt,
  onPromptChange,
  includeFastMode = true,
  modelOptions,
  onSelectionComplete,
}: TraitsMenuContentProps) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const {
    caps,
    defaultEffort,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
  } = getComposerTraitSelection(provider, model, prompt, modelOptions, runtimeModel);
  const hasVisibleControls = hasVisibleComposerTraitControls(
    { caps, effortLevels, thinkingEnabled, contextWindowOptions },
    { includeFastMode },
  );
  const hasPriorFastModeSection =
    effortLevels.length > 0 || thinkingEnabled !== null || contextWindowOptions.length > 1;

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
        onSelectionComplete?.();
        return;
      }
      const nextModelOptionsPatch =
        provider === "gemini"
          ? (geminiModelOptionsFromEffortValue(nextOption.value) ?? {})
          : provider === "opencode"
            ? { variant: nextOption.value }
            : provider === "codex"
              ? { reasoningEffort: nextOption.value }
              : { effort: nextOption.value };
      setProviderModelOptions(
        threadId,
        provider,
        buildNextProviderOptions(provider, modelOptions, nextModelOptionsPatch),
        { ...(model !== undefined ? { model } : {}), persistSticky: true },
      );
      onSelectionComplete?.();
    },
    [
      ultrathinkPromptControlled,
      modelOptions,
      onPromptChange,
      onSelectionComplete,
      threadId,
      setProviderModelOptions,
      effortLevels,
      prompt,
      caps.promptInjectedEffortLevels,
      model,
      provider,
    ],
  );

  if (!hasVisibleControls) {
    return null;
  }

  return (
    <>
      {effortLevels.length > 0 ? (
        <>
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
              {provider === "opencode" ? "Variant" : "Effort"}
            </div>
            {ultrathinkPromptControlled ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                Remove Ultrathink from the prompt to change effort.
              </div>
            ) : null}
            <MenuRadioGroup value={effort ?? ""} onValueChange={handleEffortChange}>
              {effortLevels.map((option) => {
                const item = (
                  <MenuRadioItem
                    key={option.value}
                    value={option.value}
                    disabled={ultrathinkPromptControlled}
                    onClick={() => onSelectionComplete?.()}
                  >
                    {option.label}
                    {option.value === defaultEffort ? " (default)" : ""}
                  </MenuRadioItem>
                );
                return option.description ? (
                  <Tooltip key={option.value}>
                    <TooltipTrigger render={item} />
                    <TooltipPopup side="right" className="max-w-80 whitespace-normal leading-tight">
                      {option.description}
                    </TooltipPopup>
                  </Tooltip>
                ) : (
                  item
                );
              })}
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
                { ...(model !== undefined ? { model } : {}), persistSticky: true },
              );
              onSelectionComplete?.();
            }}
          >
            <MenuRadioItem value="on" onClick={() => onSelectionComplete?.()}>
              On (default)
            </MenuRadioItem>
            <MenuRadioItem value="off" onClick={() => onSelectionComplete?.()}>
              Off
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {includeFastMode && caps.supportsFastMode ? (
        <>
          {hasPriorFastModeSection ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
            <MenuRadioGroup
              value={fastModeEnabled ? "on" : "off"}
              onValueChange={(value) => {
                setProviderModelOptions(
                  threadId,
                  provider,
                  buildNextProviderOptions(provider, modelOptions, { fastMode: value === "on" }),
                  { ...(model !== undefined ? { model } : {}), persistSticky: true },
                );
                onSelectionComplete?.();
              }}
            >
              <MenuRadioItem value="off" onClick={() => onSelectionComplete?.()}>
                Default
              </MenuRadioItem>
              <MenuRadioItem value="on" onClick={() => onSelectionComplete?.()}>
                Fast
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
      {contextWindowOptions.length > 1 ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              Context Window
            </div>
            <MenuRadioGroup
              value={contextWindow ?? defaultContextWindow ?? ""}
              onValueChange={(value) => {
                setProviderModelOptions(
                  threadId,
                  provider,
                  buildNextProviderOptions(provider, modelOptions, { contextWindow: value }),
                  { ...(model !== undefined ? { model } : {}), persistSticky: true },
                );
                onSelectionComplete?.();
              }}
            >
              {contextWindowOptions.map((option) => (
                <MenuRadioItem
                  key={option.value}
                  value={option.value}
                  onClick={() => onSelectionComplete?.()}
                >
                  {option.label}
                  {option.value === defaultContextWindow ? " (default)" : ""}
                </MenuRadioItem>
              ))}
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
  runtimeModel,
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
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
  } = getComposerTraitSelection(provider, model, prompt, modelOptions, runtimeModel);
  const hasVisibleControls = hasVisibleComposerTraitControls(
    { caps, effortLevels, thinkingEnabled, contextWindowOptions },
    { includeFastMode },
  );

  if (!hasVisibleControls) {
    return null;
  }

  const effortLabel = effort
    ? (effortLevels.find((l) => l.value === effort)?.label ?? effort)
    : null;
  const contextWindowLabel =
    contextWindowOptions.length > 1 && contextWindow !== defaultContextWindow
      ? (contextWindowOptions.find((option) => option.value === contextWindow)?.label ?? null)
      : null;
  const isFastOnlyControl =
    caps.supportsFastMode &&
    effortLevels.length === 0 &&
    thinkingEnabled === null &&
    contextWindowOptions.length <= 1;
  const primaryTriggerLabel = ultrathinkPromptControlled
    ? "Ultrathink"
    : effortLabel
      ? effortLabel
      : thinkingEnabled !== null
        ? `Thinking ${thinkingEnabled ? "On" : "Off"}`
        : isFastOnlyControl
          ? fastModeEnabled
            ? "Fast"
            : "Default"
          : null;
  const showsFastBadge = caps.supportsFastMode && fastModeEnabled && !isFastOnlyControl;

  const isCodexStyle = provider === "codex";

  const triggerButton = (
    <Button
      size="sm"
      variant="chrome"
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
        {contextWindowLabel ? (
          <>
            {primaryTriggerLabel || showsFastBadge ? (
              <span className="shrink-0 text-muted-foreground/45">·</span>
            ) : null}
            <span className="shrink-0">{contextWindowLabel}</span>
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
        {contextWindowLabel ? (
          <>
            {primaryTriggerLabel || showsFastBadge ? (
              <span className="text-muted-foreground/45">·</span>
            ) : null}
            <span>{contextWindowLabel}</span>
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
      {shortcutLabel ? (
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger render={triggerButton} />}>
            {triggerContent}
          </TooltipTrigger>
          {!isMenuOpen ? (
            <TooltipPopup side="top" sideOffset={6}>
              <span className="inline-flex items-center gap-2 px-1 py-0.5">
                <span>Change reasoning</span>
                <ShortcutKbd
                  shortcutLabel={shortcutLabel}
                  className="h-4 min-w-4 px-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground"
                />
              </span>
            </TooltipPopup>
          ) : null}
        </Tooltip>
      ) : (
        <MenuTrigger render={triggerButton}>{triggerContent}</MenuTrigger>
      )}
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          threadId={threadId}
          model={model}
          runtimeModel={runtimeModel}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeFastMode={includeFastMode}
          modelOptions={modelOptions}
          onSelectionComplete={() => setMenuOpen(false)}
        />
      </MenuPopup>
    </Menu>
  );
});
