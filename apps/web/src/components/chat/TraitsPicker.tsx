import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  type ProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelCapabilities,
  isClaudeUltrathinkPrompt,
  trimOrNull,
  getDefaultEffort,
  hasEffortLevel,
} from "@t3tools/shared/model";
import { memo, useCallback, useState } from "react";
import { ChevronDownIcon, ZapIcon } from "~/lib/icons";
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

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function getRawEffort(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "codex") {
    return trimOrNull((modelOptions as CodexModelOptions | undefined)?.reasoningEffort);
  }
  return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.effort);
}

function getSelectedTraits(
  provider: ProviderKind,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
) {
  const caps = getModelCapabilities(provider, model);
  const effortLevels = caps.reasoningEffortLevels;
  const defaultEffort = getDefaultEffort(caps);

  // Resolve effort from options (provider-specific key)
  const resolvedEffort = getRawEffort(provider, modelOptions);

  // Filter out prompt-injected efforts from the "current effort" display
  const isPromptInjected = resolvedEffort
    ? caps.promptInjectedEffortLevels.includes(resolvedEffort)
    : false;
  const effort =
    resolvedEffort && !isPromptInjected && hasEffortLevel(caps, resolvedEffort)
      ? resolvedEffort
      : defaultEffort && hasEffortLevel(caps, defaultEffort)
        ? defaultEffort
        : null;

  // Thinking toggle (only for models that support it)
  const thinkingEnabled = caps.supportsThinkingToggle
    ? ((modelOptions as ClaudeModelOptions | undefined)?.thinking ?? true)
    : null;

  // Fast mode
  const fastModeEnabled =
    caps.supportsFastMode &&
    (modelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    caps.promptInjectedEffortLevels.length > 0 && isClaudeUltrathinkPrompt(prompt);

  return {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    ultrathinkPromptControlled,
  };
}

export interface TraitsMenuContentProps {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  threadId,
  model,
  prompt,
  onPromptChange,
  modelOptions,
}: TraitsMenuContentProps) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    ultrathinkPromptControlled,
  } = getSelectedTraits(provider, model, prompt, modelOptions);
  const defaultEffort = getDefaultEffort(caps);

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
      {caps.supportsFastMode ? (
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
  modelOptions,
}: TraitsMenuContentProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    ultrathinkPromptControlled,
  } = getSelectedTraits(provider, model, prompt, modelOptions);

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

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className={
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-sm font-normal text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0"
                : "shrink-0 whitespace-nowrap px-2 text-sm font-normal text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
            }
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
            <span className="min-w-0 flex flex-1 items-center gap-1.5 truncate">
              {primaryTriggerLabel ? <span className="truncate">{primaryTriggerLabel}</span> : null}
              {showsFastBadge ? (
                <>
                  {primaryTriggerLabel ? (
                    <span className="shrink-0 text-muted-foreground/45">·</span>
                  ) : null}
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <ZapIcon aria-hidden="true" className="size-3 text-[hsl(var(--chart-4))]" />
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
                    <ZapIcon aria-hidden="true" className="size-3 text-[hsl(var(--chart-4))]" />
                    <span>Fast</span>
                  </span>
                </>
              ) : null}
            </span>
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          threadId={threadId}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
        />
      </MenuPopup>
    </Menu>
  );
});
