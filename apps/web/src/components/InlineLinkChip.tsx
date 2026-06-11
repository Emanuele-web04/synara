// FILE: InlineLinkChip.tsx
// Purpose: Shared inline link chip for the composer, sent user messages, and any
//          read-only prompt echo — same label shortening, favicon icon, and
//          accent styling everywhere.
// Layer: Shared UI component

import { memo, type MouseEvent } from "react";

import { describeLinkChip, openExternalLink } from "~/lib/linkChips";
import {
  COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME,
  COMPOSER_INLINE_LINK_CHIP_CLASS_NAME,
} from "./composerInlineChip";
import { InlineChipContent } from "./InlineChip";
import { LinkChipIcon } from "./LinkChipIcon";

export interface InlineLinkChipProps {
  /** Normalized openable URL the chip represents. */
  readonly url: string;
  /** Timeline chips use a button; composer decorator chips use a span. */
  readonly interactive?: boolean;
  readonly className?: string | undefined;
}

export const InlineLinkChip = memo(function InlineLinkChip({
  url,
  interactive = false,
  className,
}: InlineLinkChipProps) {
  const { label } = describeLinkChip(url);
  const chipClassName = className ?? COMPOSER_INLINE_LINK_CHIP_CLASS_NAME;

  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openExternalLink(url);
  };

  const content = (
    <InlineChipContent
      icon={<LinkChipIcon url={url} className={COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME} />}
      label={label}
    />
  );

  if (interactive) {
    return (
      <button type="button" className={chipClassName} title={url} onClick={onClick}>
        {content}
      </button>
    );
  }

  return (
    <span
      className={chipClassName}
      title={url}
      contentEditable={false}
      suppressContentEditableWarning
      spellCheck={false}
      onClick={onClick}
      role="link"
    >
      {content}
    </span>
  );
});
