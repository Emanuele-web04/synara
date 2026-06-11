// FILE: InlineMentionChip.tsx
// Purpose: Shared inline file/folder/plugin mention chip (icon + label) used by
//          the timeline user-message echo, the assistant markdown view, and
//          openable file links, so a referenced path reads identically to a
//          composer mention. Supports a static (span) and an interactive
//          (anchor) variant so the same UI can stay clickable.
// Layer: UI shared component
// Exports: InlineMentionChip

import { memo, type MouseEvent, type ReactNode } from "react";
import type { ProviderMentionReference } from "@t3tools/contracts";
import { basenameOfPath } from "~/file-icons";
import {
  COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME,
  COMPOSER_INLINE_MENTION_CHIP_INTERACTIVE_CLASS_NAME,
} from "../composerInlineChip";
import { InlineChipContent } from "../InlineChip";
import { MentionChipIcon, type MentionChipKind } from "./MentionChipIcon";

interface InlineMentionChipProps {
  path: string;
  theme: "light" | "dark";
  kind?: MentionChipKind;
  mentionReferences?: ReadonlyArray<ProviderMentionReference>;
  /** Defaults to the path basename (composer-style label). */
  label?: ReactNode;
  /** When set, the chip renders as an openable anchor instead of a static span. */
  href?: string;
  onActivate?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export const InlineMentionChip = memo(function InlineMentionChip(props: InlineMentionChipProps) {
  const label = props.label ?? basenameOfPath(props.path);
  const inner = (
    <InlineChipContent
      icon={
        <MentionChipIcon
          path={props.path}
          theme={props.theme}
          {...(props.kind ? { kind: props.kind } : {})}
          {...(props.mentionReferences ? { mentionReferences: props.mentionReferences } : {})}
        />
      }
      label={label}
    />
  );

  if (props.href !== undefined || props.onActivate) {
    return (
      <a
        className={COMPOSER_INLINE_MENTION_CHIP_INTERACTIVE_CLASS_NAME}
        title={props.path}
        {...(props.href !== undefined ? { href: props.href } : {})}
        {...(props.onActivate ? { onClick: props.onActivate } : {})}
      >
        {inner}
      </a>
    );
  }

  return (
    <span className={COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME} title={props.path}>
      {inner}
    </span>
  );
});
