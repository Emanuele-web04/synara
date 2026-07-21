// FILE: EnvironmentMarkersSection.tsx
// Purpose: "Markers" section of the Environment panel for highlighted transcript text.
// Layer: Environment panel section

import type { MessageId, ThreadMarker, ThreadMarkerId } from "@synara/contracts";
import { isThreadMarkerAvailable } from "@synara/shared/threadMarkers";

import { cn } from "~/lib/utils";
import { deriveThreadMarkerLabel } from "~/threadMarkers";

import { EnvironmentEditableChecklistRow } from "./EnvironmentEditableChecklistRow";
import { EnvironmentCollapsibleSection } from "./EnvironmentRow";

const MARKER_SWATCH_CLASS: Record<ThreadMarker["color"], string> = {
  yellow: "bg-[color-mix(in_srgb,var(--color-text-accent)_14%,transparent)]",
  blue: "border border-[color-mix(in_srgb,var(--color-text-foreground)_22%,transparent)] bg-transparent",
  green: "bg-[#34d399]",
  pink: "bg-[#f472b6]",
};

interface EnvironmentMarkersSectionProps {
  markers: readonly ThreadMarker[];
  messageTextById: ReadonlyMap<MessageId, string>;
  onJump: (marker: ThreadMarker) => void;
  onToggleDone: (markerId: ThreadMarkerId) => void;
  onRemove: (markerId: ThreadMarkerId) => void;
  onRename: (markerId: ThreadMarkerId, label: string | null) => void;
}

export function EnvironmentMarkersSection({
  markers,
  messageTextById,
  onJump,
  onToggleDone,
  onRemove,
  onRename,
}: EnvironmentMarkersSectionProps) {
  if (markers.length === 0) {
    return null;
  }
  return (
    <EnvironmentCollapsibleSection label="Markers">
      <ul className="flex flex-col">
        {markers.map((marker) => (
          <MarkerRow
            key={marker.id}
            marker={marker}
            text={messageTextById.get(marker.messageId)}
            onJump={onJump}
            onToggleDone={onToggleDone}
            onRemove={onRemove}
            onRename={onRename}
          />
        ))}
      </ul>
    </EnvironmentCollapsibleSection>
  );
}

function MarkerRow({
  marker,
  text,
  onJump,
  onToggleDone,
  onRemove,
  onRename,
}: {
  marker: ThreadMarker;
  text: string | undefined;
  onJump: (marker: ThreadMarker) => void;
  onToggleDone: (markerId: ThreadMarkerId) => void;
  onRemove: (markerId: ThreadMarkerId) => void;
  onRename: (markerId: ThreadMarkerId, label: string | null) => void;
}) {
  const available = text !== undefined && isThreadMarkerAvailable(marker, text);
  const resolvedLabel = marker.label?.trim() || deriveThreadMarkerLabel(marker);
  const displayLabel = available ? resolvedLabel : `${resolvedLabel} (unavailable)`;

  return (
    <EnvironmentEditableChecklistRow
      checked={marker.done}
      available={available}
      displayLabel={displayLabel}
      initialEditLabel={marker.label ?? resolvedLabel}
      checkboxAriaLabel={marker.done ? "Mark not done" : "Mark done"}
      labelAriaLabel={
        available
          ? "Jump to marker. Press F2 to rename."
          : "Marker unavailable. Press Enter to rename."
      }
      labelTitle={
        available
          ? "Click to jump · double-click or press F2 to rename"
          : "Source text changed or is unavailable"
      }
      removeLabel="Remove marker"
      removeTooltip="Remove"
      leading={
        <span
          aria-hidden="true"
          className={cn("size-2.5 shrink-0 rounded-full", MARKER_SWATCH_CLASS[marker.color])}
        />
      }
      className="group/marker"
      removeButtonClassName="group-hover/marker:opacity-100"
      onJump={() => onJump(marker)}
      onToggleDone={() => onToggleDone(marker.id)}
      onRemove={() => onRemove(marker.id)}
      onRename={(label) => onRename(marker.id, label)}
    />
  );
}
