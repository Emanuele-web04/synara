// FILE: InlineLinkChip.tsx
// Purpose: Shared inline link chip for the composer, sent user messages, and any
//          read-only prompt echo — same label shortening, favicon icon, and
//          accent styling everywhere.
// Layer: Shared UI component

import { type MouseEvent, useContext } from "react";

import { describeLinkChip, openExternalLink } from "~/lib/linkChips";
import {
  ChatLinkActionsContext,
  resolveGitHubItemClickOpener,
  showLinkContextMenu,
} from "~/lib/linkContextMenu";
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

export function InlineLinkChip({
  url,
  interactive: interactiveProp,
  className,
}: InlineLinkChipProps) {
  const interactive = interactiveProp ?? false;
  const { label } = describeLinkChip(url);
  const chipClassName = className ?? COMPOSER_INLINE_LINK_CHIP_CLASS_NAME;
  const linkActions = useContext(ChatLinkActionsContext);

  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    // A plain click on a pull request or issue follows the user's setting (in the app by
    // default); cmd/ctrl-click goes to GitHub.
    const openGitHubItem =
      event.metaKey || event.ctrlKey ? undefined : resolveGitHubItemClickOpener(url, linkActions);
    if (openGitHubItem) {
      openGitHubItem(url);
      return;
    }
    openExternalLink(url);
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void showLinkContextMenu({
      url,
      position: { x: event.clientX, y: event.clientY },
      actions: linkActions,
    });
  };

  const content = (
    <InlineChipContent
      icon={<LinkChipIcon url={url} className={COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME} />}
      label={label}
    />
  );

  if (interactive) {
    return (
      <button
        type="button"
        className={chipClassName}
        title={url}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
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
}
