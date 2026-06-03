// FILE: ProviderHandoffDialog.tsx
// Purpose: Confirmation dialog for linked cross-provider handoff.
// Layer: Chat UI

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, TriangleAlertIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";

export interface ProviderHandoffDialogProps {
  open: boolean;
  sourceProvider: ProviderKind | null;
  targetProvider: ProviderKind | null;
  imageCopyNotice: string | null;
  warnings: readonly string[];
  contextPreview: string | null;
  contextPreviewOpen: boolean;
  isContextPreviewCopied: boolean;
  onContextPreviewOpenChange: (open: boolean) => void;
  onCopyContextPreview: (preview: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ProviderHandoffDialog({
  open,
  sourceProvider,
  targetProvider,
  imageCopyNotice,
  warnings,
  contextPreview,
  contextPreviewOpen,
  isContextPreviewCopied,
  onContextPreviewOpenChange,
  onCopyContextPreview,
  onCancel,
  onConfirm,
}: ProviderHandoffDialogProps) {
  const targetLabel = targetProvider ? PROVIDER_DISPLAY_NAMES[targetProvider] : null;
  const sourceLabel = sourceProvider ? PROVIDER_DISPLAY_NAMES[sourceProvider] : "provider";
  const copyPreviewLabel = isContextPreviewCopied
    ? "Copied context preview"
    : "Copy context preview";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel();
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {targetLabel
              ? `Continue this conversation with ${targetLabel}?`
              : "Continue this conversation?"}
          </DialogTitle>
          <DialogDescription>
            {targetLabel
              ? `${targetLabel} will receive a compact context packet from this thread.`
              : "The target provider will receive a compact context packet from this thread."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="rounded-md border border-[color:var(--color-border-light)] bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">
            <p>The original {sourceLabel} session will stay unchanged.</p>
            <p className="mt-2">
              Provider-native hidden state, pending approvals, callback state, and provider tool
              state cannot be transferred.
            </p>
            <p className="mt-2">
              The current prompt, assistant selections, and terminal contexts are copied to the new
              draft.
            </p>
            {imageCopyNotice ? <p className="mt-2">{imageCopyNotice}</p> : null}
          </div>
          {warnings.length > 0 ? (
            <div className="rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-sm text-foreground">
              <div className="flex items-start gap-2">
                <TriangleAlertIcon
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-warning"
                />
                <div className="min-w-0">
                  <div className="font-medium">Some draft items stay here</div>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
                    {warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ) : null}
          {contextPreview ? (
            <div className="rounded-md border border-[color:var(--color-border-light)] bg-background/50 px-3 py-2 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-controls="provider-handoff-context-preview"
                  aria-expanded={contextPreviewOpen}
                  onClick={() => onContextPreviewOpenChange(!contextPreviewOpen)}
                >
                  <DisclosureChevron open={contextPreviewOpen} className="size-3.5" />
                  <span className="font-medium">Context preview</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {contextPreview.length.toLocaleString()} chars
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="shrink-0 gap-1.5"
                  aria-label={copyPreviewLabel}
                  title={copyPreviewLabel}
                  onClick={() => onCopyContextPreview(contextPreview)}
                >
                  {isContextPreviewCopied ? (
                    <CheckIcon className="size-3 text-success" />
                  ) : (
                    <CopyIcon className="size-3" />
                  )}
                  <span>{isContextPreviewCopied ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <DisclosureRegion open={contextPreviewOpen} contentClassName="pt-2">
                <p className="text-muted-foreground text-xs">
                  Editing the first target-thread message can change final truncation.
                </p>
                <pre
                  id="provider-handoff-context-preview"
                  className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/70 bg-secondary/30 p-2.5 font-mono text-[11px] text-muted-foreground leading-relaxed"
                >
                  {contextPreview}
                </pre>
              </DisclosureRegion>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm}>
            {targetLabel ? `Continue with ${targetLabel}` : "Continue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
