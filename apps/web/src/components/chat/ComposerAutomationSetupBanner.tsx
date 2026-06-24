// FILE: ComposerAutomationSetupBanner.tsx
// Purpose: Above-composer prompt shown while Synara is gathering the missing details
// (task and/or schedule) for a chat-created automation. The user answers in the
// composer like any other message; Cancel abandons the setup.
// Layer: Chat composer UI
// Exports: ComposerAutomationSetupBanner

import { memo } from "react";

export const ComposerAutomationSetupBanner = memo(function ComposerAutomationSetupBanner({
  question,
  request,
  onCancel,
}: {
  question: string;
  request: string | null;
  onCancel: () => void;
}) {
  return (
    <div className="px-5 pt-4 pb-4 sm:px-6 sm:pt-4.5 sm:pb-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
          Set up automation
        </span>
        <button
          type="button"
          aria-label="Cancel automation setup"
          onClick={onCancel}
          className="rounded-full border border-[color:var(--color-border-light)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-foreground-secondary)] transition-colors duration-150 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border)]"
        >
          Cancel
        </button>
      </div>
      {request ? (
        <p className="mt-1.5 truncate text-xs text-muted-foreground/65">{request}</p>
      ) : null}
      <p className="mt-1 text-sm text-foreground/90">{question}</p>
    </div>
  );
});
