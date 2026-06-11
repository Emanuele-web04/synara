// FILE: messagePrimitives.tsx
// Purpose: Shared low-level message presentation primitives for full chat and compact review chat.
// Layer: Web chat presentation primitives
// Exports: AssistantMarkdownBody, UserMessageBubbleFrame

import type { ThreadMarker } from "@t3tools/contracts";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
} from "./chatTypography";

export function AssistantMarkdownBody(props: {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  markers?: readonly ThreadMarker[] | undefined;
}): ReactNode {
  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.cwd}
      isStreaming={props.isStreaming}
      className={props.className}
      style={props.style}
      onImageExpand={props.onImageExpand}
      markers={props.markers}
    />
  );
}

export function UserMessageBubbleFrame(props: {
  children: ReactNode;
  className?: string | undefined;
  paddingClassName?: string | undefined;
}): ReactNode {
  return (
    <div
      className={cn(
        "min-w-0 bg-[var(--app-user-message-background)]",
        USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
        props.paddingClassName ?? USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}
