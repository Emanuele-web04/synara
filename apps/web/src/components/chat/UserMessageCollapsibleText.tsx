// FILE: UserMessageCollapsibleText.tsx
// Purpose: Show more/less for long user messages: a visual max-height clamp (with a fade
//          mask) around the fully rendered message instead of a character slice. Shared by the
//          chat transcript and the SynBot thread's bubbles.
// Layer: Web chat presentation component
// Exports: UserMessageCollapsibleText

import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";

import {
  USER_MESSAGE_COLLAPSED_FADE_LINES,
  USER_MESSAGE_COLLAPSED_MAX_LINES,
  userMessageLikelyOverflows,
} from "./userMessageCollapse";
import { observeUserMessageOverflow } from "./userMessageOverflowObserver";

export const UserMessageCollapsibleText = memo(function UserMessageCollapsibleText(props: {
  text: string;
  expanded: boolean;
  /** The rendered text's line height, which sets the clamp (12 lines) and its fade. */
  lineHeightPx: number;
  onToggle: () => void;
  children: ReactNode;
  /** The toggle's look; the chat's muted link when unset. */
  toggleClassName?: string;
  toggleStyle?: CSSProperties;
}) {
  const { t } = useTranslation();

  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [overflowing, setOverflowing] = useState(() => userMessageLikelyOverflows(props.text));
  const collapsed = !props.expanded;

  const clampHeightPx = USER_MESSAGE_COLLAPSED_MAX_LINES * props.lineHeightPx;
  const fadeStartPx = clampHeightPx - USER_MESSAGE_COLLAPSED_FADE_LINES * props.lineHeightPx;
  const clamped = collapsed && overflowing;

  // Observe the natural content inside the clamp. ResizeObserver reports its
  // height after layout, including wrapping/font changes, so mounting recycled
  // transcript rows never forces layout with scrollHeight/clientHeight reads.
  useEffect(() => {
    const element = contentRef.current;
    if (!element || !collapsed) return;
    return observeUserMessageOverflow(element, (contentHeight) => {
      setOverflowing(contentHeight - clampHeightPx > 1);
    });
  }, [collapsed, clampHeightPx, props.text]);

  return (
    <>
      <div
        id={contentId}
        data-user-message-clamp={clamped ? "true" : "false"}
        className={cn("min-w-0", collapsed && "overflow-hidden")}
        style={
          collapsed
            ? {
                maxHeight: `${clampHeightPx}px`,
                ...(clamped
                  ? {
                      maskImage: `linear-gradient(to bottom, black ${fadeStartPx}px, transparent 100%)`,
                    }
                  : {}),
              }
            : undefined
        }
      >
        <div ref={contentRef} className="flow-root min-w-0">
          {props.children}
        </div>
      </div>
      {(clamped || props.expanded) && (
        <button
          type="button"
          data-scroll-anchor-ignore
          className={
            props.toggleClassName ??
            "mt-1 block text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/72"
          }
          style={props.toggleStyle}
          aria-expanded={props.expanded}
          aria-controls={contentId}
          onClick={props.onToggle}
        >
          {props.expanded ? t("workspace:timeline_showLess") : t("workspace:timeline_showMore")}
        </button>
      )}
    </>
  );
});
