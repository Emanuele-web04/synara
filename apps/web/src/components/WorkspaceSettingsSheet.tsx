// FILE: WorkspaceSettingsSheet.tsx
// Purpose: Render per-workspace terminal layout settings with visual preset previews.
// Layer: Workspace UI controls

import { CheckIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import {
  WORKSPACE_LAYOUT_PRESETS,
  type WorkspaceLayoutPresetId,
} from "../workspaceTerminalLayoutPresets";

function WorkspaceLayoutPresetPreview(props: { presetId: WorkspaceLayoutPresetId }) {
  const paneClassName =
    "rounded-[6px] border border-border/70 bg-background/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]";

  if (props.presetId === "single") {
    return (
      <div
        className={cn(
          "h-full min-h-0 rounded-[10px] border border-border/80 bg-card/90 p-1.5",
          paneClassName,
        )}
      />
    );
  }

  if (props.presetId === "two-columns") {
    return (
      <div className="grid h-full min-h-0 grid-cols-2 gap-1.5 rounded-[10px] border border-border/80 bg-card/90 p-1.5">
        <div className={paneClassName} />
        <div className={paneClassName} />
      </div>
    );
  }

  if (props.presetId === "two-rows") {
    return (
      <div className="grid h-full min-h-0 grid-rows-2 gap-1.5 rounded-[10px] border border-border/80 bg-card/90 p-1.5">
        <div className={paneClassName} />
        <div className={paneClassName} />
      </div>
    );
  }

  if (props.presetId === "top-main") {
    return (
      <div className="grid h-full min-h-0 grid-rows-[1.3fr_1fr] gap-1.5 rounded-[10px] border border-border/80 bg-card/90 p-1.5">
        <div className={paneClassName} />
        <div className="grid min-h-0 grid-cols-2 gap-1.5">
          <div className={paneClassName} />
          <div className={paneClassName} />
        </div>
      </div>
    );
  }

  if (props.presetId === "left-main") {
    return (
      <div className="grid h-full min-h-0 grid-cols-[1.2fr_1fr] gap-1.5 rounded-[10px] border border-border/80 bg-card/90 p-1.5">
        <div className={paneClassName} />
        <div className="grid min-h-0 grid-rows-2 gap-1.5">
          <div className={paneClassName} />
          <div className={paneClassName} />
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-2 grid-rows-2 gap-1.5 rounded-[10px] border border-border/80 bg-card/90 p-1.5">
      <div className={paneClassName} />
      <div className={paneClassName} />
      <div className={paneClassName} />
      <div className={paneClassName} />
    </div>
  );
}

export default function WorkspaceSettingsSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedPresetId: WorkspaceLayoutPresetId;
  onSelectPreset: (presetId: WorkspaceLayoutPresetId) => void;
  workspaceTitle: string;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetPopup side="right" className="w-[min(92vw,420px)] max-w-[420px]" keepMounted>
        <SheetHeader>
          <SheetTitle>Workspace settings</SheetTitle>
          <SheetDescription>
            Choose how terminals are arranged inside {props.workspaceTitle}.
          </SheetDescription>
        </SheetHeader>

        <SheetPanel className="space-y-6">
          <section className="space-y-3">
            <div>
              <div className="text-sm font-medium text-foreground">Layout preset</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Changes apply immediately to this workspace. Extra terminals stay available as tabs.
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {WORKSPACE_LAYOUT_PRESETS.map((preset) => {
                const isSelected = preset.id === props.selectedPresetId;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={cn(
                      "group rounded-2xl border p-3 text-left transition-colors",
                      isSelected
                        ? "border-[color:var(--color-border)] bg-[var(--sidebar-accent)] shadow-sm"
                        : "border-[color:var(--color-border-light)] bg-card/50 hover:border-[color:var(--color-border)] hover:bg-[var(--sidebar-accent)]",
                    )}
                    aria-pressed={isSelected}
                    onClick={() => props.onSelectPreset(preset.id)}
                  >
                    <div className="relative h-24 overflow-hidden rounded-xl bg-gradient-to-b from-muted/65 to-muted/35 p-0.5">
                      <WorkspaceLayoutPresetPreview presetId={preset.id} />
                      {isSelected ? (
                        <div className="absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded-full bg-[var(--color-text-foreground)] text-[var(--color-background-surface)] shadow-sm">
                          <CheckIcon className="size-3.5" />
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-2">
                      <div className="text-sm font-medium text-foreground">{preset.title}</div>
                      <div className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {preset.slotCount} pane{preset.slotCount === 1 ? "" : "s"}
                      </div>
                    </div>
                    <div className="mt-1 text-xs leading-5 text-muted-foreground">
                      {preset.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
