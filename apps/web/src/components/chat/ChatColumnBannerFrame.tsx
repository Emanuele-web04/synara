// FILE: ChatColumnBannerFrame.tsx
// Purpose: Shared transcript-width wrapper for chat status banners.
// Layer: Chat status presentation
// Exports: ChatColumnBannerFrame

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import {
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
} from "./composerPickerStyles";

/** Insets a status banner to the transcript column width with the shared top gutter,
 *  so error / provider-health / rate-limit banners line up with the transcript and
 *  composer column instead of each re-declaring the same two-div wrapper. */
export function ChatColumnBannerFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("pt-3", CHAT_COLUMN_GUTTER_CLASS_NAME, className)}>
      <div className={CHAT_COLUMN_FRAME_CLASS_NAME}>{children}</div>
    </div>
  );
}
