// FILE: ComposerModelPickerTraitRows.tsx
// Purpose: Footer of the composer model picker — one "<Trait> … <value> ›" row per control
//   the selected model exposes (thinking, context, effort, speed, agent).
// Layer: Chat composer presentation
// Depends on: composer trait resolution, the shared trait commit hook, and menu primitives.

import {
  type ProviderAgentDescriptor,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ThreadId,
} from "@synara/contracts";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { type ProviderOptions } from "../../providerModelOptions";
import { MenuRadioGroup, MenuRadioItem, MenuSub, MenuSubTrigger } from "../ui/menu";
import { ComposerEffortSliderCard } from "./ComposerEffortSliderCard";
import { ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import { COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME } from "./composerPickerStyles";
import {
  getComposerTraitSelection,
  planComposerEffortChange,
  resolveComposerTraitStatusLabel,
  supportsComposerFastModeControl,
} from "./composerTraits";
import { defaultAgentForProvider, getAgentOptions, getSelectedAgentValue } from "./TraitsPicker";
import { useComposerTraitCommit } from "./useComposerTraitCommit";

// Footer row "<Trait> ……… <value> ›" opening a radio submenu. Picking a value closes
// only the submenu, so the user can compose model + traits and then star the result.
export type ComposerEffortControl = "menu" | "slider";

function TraitRow(props: {
  label: string;
  valueLabel: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string; isDefault?: boolean }>;
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <MenuSub open={open} onOpenChange={setOpen}>
      <MenuSubTrigger disabled={props.disabled ?? false}>
        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <span className="truncate">{props.label}</span>
          <span className={cn("truncate", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}>
            {props.valueLabel}
          </span>
        </span>
      </MenuSubTrigger>
      <ComposerPickerMenuSubPopup>
        <MenuRadioGroup
          value={props.value}
          onValueChange={(value) => {
            props.onValueChange(value);
            setOpen(false);
          }}
        >
          {props.options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value} onClick={() => setOpen(false)}>
              {option.label}
              {option.isDefault ? " (default)" : ""}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </ComposerPickerMenuSubPopup>
    </MenuSub>
  );
}

export function ComposerModelPickerTraitRows(props: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  runtimeModel: ProviderModelDescriptor | undefined;
  runtimeAgents: ReadonlyArray<ProviderAgentDescriptor> | null | undefined;
  modelOptions: ProviderOptions | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelLabel: string;
  // "slider" swaps the Effort and Speed rows for the stepped slider card, which owns
  // both. Models without an effort ladder always keep the rows.
  effortControl: ComposerEffortControl;
}) {
  const { provider, threadId, model, modelOptions, prompt } = props;
  const selection = getComposerTraitSelection(
    provider,
    model,
    prompt,
    modelOptions,
    props.runtimeModel,
  );
  const commitTrait = useComposerTraitCommit({ threadId, provider, model, modelOptions });
  const agentOptions = getAgentOptions(provider, props.runtimeAgents);
  const defaultAgent = defaultAgentForProvider(provider);
  const selectedAgent = getSelectedAgentValue(provider, modelOptions) ?? defaultAgent ?? "";
  const contextWindowTraitId = selection.contextWindowDescriptor?.id ?? "contextWindow";
  const contextWindowValue = selection.contextWindow ?? selection.defaultContextWindow ?? "";

  const usesEffortSlider = props.effortControl === "slider" && selection.effortLevels.length > 0;

  const rows: ReactNode[] = [];
  if (selection.thinkingEnabled !== null) {
    rows.push(
      <TraitRow
        key="thinking"
        label="Thinking"
        value={selection.thinkingEnabled ? "on" : "off"}
        valueLabel={selection.thinkingEnabled ? "On" : "Off"}
        options={[
          { value: "on", label: "On", isDefault: true },
          { value: "off", label: "Off" },
        ]}
        onValueChange={(value) => commitTrait({ thinking: value === "on" })}
      />,
    );
  }
  if (selection.contextWindowOptions.length > 1) {
    rows.push(
      <TraitRow
        key="context"
        label={selection.contextWindowDescriptor?.label ?? "Context"}
        value={contextWindowValue}
        valueLabel={
          selection.contextWindowOptions.find((option) => option.value === contextWindowValue)
            ?.label ?? contextWindowValue
        }
        options={selection.contextWindowOptions.map((option) => ({
          value: option.value,
          label: option.label,
          isDefault: option.value === selection.defaultContextWindow,
        }))}
        onValueChange={(value) => commitTrait({ [contextWindowTraitId]: value })}
      />,
    );
  }
  if (selection.effortLevels.length > 0 && !usesEffortSlider) {
    rows.push(
      <TraitRow
        key="effort"
        label={provider === "opencode" ? "Variant" : "Effort"}
        value={selection.effort ?? ""}
        valueLabel={resolveComposerTraitStatusLabel(selection) ?? ""}
        // Ultrathink is pinned by the prompt; the ladder is read-only until it is removed.
        disabled={selection.ultrathinkPromptControlled}
        options={selection.effortLevels.map((option) => ({
          value: option.value,
          label: option.label,
          isDefault: option.value === selection.defaultEffort,
        }))}
        onValueChange={(value) => {
          const plan = planComposerEffortChange({ provider, selection, prompt, value });
          if (!plan) return;
          if (plan.kind === "prompt") {
            props.onPromptChange(plan.prompt);
            return;
          }
          commitTrait(plan.patch);
        }}
      />,
    );
  }
  if (supportsComposerFastModeControl(selection) && !usesEffortSlider) {
    rows.push(
      <TraitRow
        key="speed"
        label="Speed"
        value={selection.fastModeEnabled ? "on" : "off"}
        valueLabel={selection.fastModeEnabled ? "Fast" : "Standard"}
        options={[
          { value: "off", label: "Standard", isDefault: true },
          { value: "on", label: "Fast" },
        ]}
        onValueChange={(value) => commitTrait({ fastMode: value === "on" })}
      />,
    );
  }
  if (agentOptions.length > 0 && defaultAgent !== null) {
    rows.push(
      <TraitRow
        key="agent"
        label="Agent"
        value={selectedAgent}
        valueLabel={
          agentOptions.find((agent) => agent.name === selectedAgent)?.displayName ?? selectedAgent
        }
        options={agentOptions.map((agent) => ({
          value: agent.name,
          label: agent.displayName,
          isDefault: agent.name === defaultAgent,
        }))}
        onValueChange={(value) => {
          if (!value) return;
          commitTrait({ agent: value === defaultAgent ? undefined : value });
        }}
      />,
    );
  }

  if (rows.length === 0 && !usesEffortSlider) return null;
  return (
    <div className="flex flex-col gap-px border-t border-border p-1">
      {usesEffortSlider ? (
        <ComposerEffortSliderCard
          provider={provider}
          threadId={threadId}
          model={model}
          modelLabel={props.modelLabel}
          runtimeModel={props.runtimeModel}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={props.onPromptChange}
        />
      ) : null}
      {rows}
    </div>
  );
}
