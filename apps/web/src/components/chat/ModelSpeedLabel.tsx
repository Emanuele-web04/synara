// FILE: ModelSpeedLabel.tsx
// Purpose: The " · 93 tok/s · Opus 5.5 · Fast" suffix of a turn header ("Worked for" /
// "Working for") and the context meter, with per-model details in a tooltip. Live
// figures carry a "~" prefix.
// Layer: web chat presentation.

import type { TurnModelSpeed } from "@synara/contracts";
import { formatModelDisplayName, getModelCapabilities } from "@synara/shared/model";
import {
  formatModelSpeed,
  groupModelSpeedsByModel,
  MODEL_SPEED_DESCRIPTION,
  type ModelSpeedGroup,
} from "@synara/shared/modelSpeed";

import { formatProviderModelOptionName } from "../../providerModelOptions";
import { formatDuration } from "../../session-logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { runtimeEffortLabel } from "./runtimeModelCapabilities";

/** The composer picker's display name for a measured model ("Opus 5.5"). */
export function formatModelSpeedModelName(
  speed: Pick<TurnModelSpeed, "provider" | "model">,
): string | null {
  if (!speed.model) return null;
  return speed.provider
    ? formatProviderModelOptionName({ provider: speed.provider, slug: speed.model })
    : (formatModelDisplayName(speed.model) ?? speed.model);
}

/** The picker's label for an effort value ("High", "Extra High"). */
export function formatModelSpeedEffort(
  speed: Pick<TurnModelSpeed, "provider" | "model" | "effort">,
): string | null {
  if (!speed.effort) return null;
  const option = speed.provider
    ? getModelCapabilities(speed.provider, speed.model).reasoningEffortLevels.find(
        (level) => level.value === speed.effort,
      )
    : undefined;
  return option?.label ?? runtimeEffortLabel(speed.effort);
}

/** "Claude Opus 5.5 · Fast"; null when the turns used more than one model. */
export function formatModelSpeedModelSummary(speeds: ReadonlyArray<TurnModelSpeed>): string | null {
  const groups = groupModelSpeedsByModel(speeds);
  const single = groups.length === 1 ? groups[0] : undefined;
  const modelName = single ? formatModelSpeedModelName(single) : null;
  if (!single || !modelName) return null;
  // A dedicated fast slug already reads "GPT-5.5 Fast"; do not repeat it.
  const showFast = single.fastMode && !/\bfast$/iu.test(modelName);
  return showFast ? `${modelName} · Fast` : modelName;
}

/** "93 tok/s · Claude Opus 5.5 · Fast"; the model part only when every turn used one model. */
export function formatModelSpeedSummary(
  tokensPerSecond: number,
  speeds: ReadonlyArray<TurnModelSpeed>,
): string {
  const modelSummary = formatModelSpeedModelSummary(speeds);
  return modelSummary
    ? `${formatModelSpeed(tokensPerSecond)} · ${modelSummary}`
    : formatModelSpeed(tokensPerSecond);
}

function ModelSpeedGroupDetails({ group }: { group: ModelSpeedGroup }) {
  const effort = formatModelSpeedEffort(group);
  const heading = [
    formatModelSpeedModelName(group) ?? "Unknown model",
    `Fast ${group.fastMode ? "on" : "off"}`,
    ...(effort ? [`Effort: ${effort}`] : []),
  ].join(" · ");
  return (
    <div>
      <div className="font-medium">{heading}</div>
      <div className="tabular-nums">
        {group.tokensPerSecond !== null ? `${formatModelSpeed(group.tokensPerSecond)} · ` : ""}
        {group.outputTokens.toLocaleString("en-US")} output tokens in{" "}
        {formatDuration(group.generationMs)}
      </div>
    </div>
  );
}

export function ModelSpeedLabel({
  tokensPerSecond,
  speeds,
  live = false,
}: {
  tokensPerSecond: number;
  // The measured turns behind the figure (one per provider turn).
  speeds: ReadonlyArray<TurnModelSpeed>;
  live?: boolean;
}) {
  const groups = groupModelSpeedsByModel(speeds);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="tabular-nums" />}>
        {" · "}
        {live ? "~" : ""}
        {formatModelSpeedSummary(tokensPerSecond, speeds)}
      </TooltipTrigger>
      <TooltipPopup className="max-w-72">
        <div className="space-y-1.5 text-left">
          {groups.map((group) => (
            <ModelSpeedGroupDetails
              key={`${group.provider ?? ""}:${group.model ?? ""}:${group.fastMode}`}
              group={group}
            />
          ))}
          <div className="text-muted-foreground">
            {live ? `${MODEL_SPEED_DESCRIPTION}, so far this turn` : MODEL_SPEED_DESCRIPTION}
          </div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
