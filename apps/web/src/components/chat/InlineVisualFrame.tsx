// FILE: InlineVisualFrame.tsx
// Purpose: One agent-published inline visual in the transcript: fetches its document, runs it
//          in a sandboxed srcdoc frame, and bridges size, theme, and scroll intent.
// Layer: Chat transcript row content
// Exports: InlineVisualFrame

import type { InlineVisualActivityPayload, ThreadId } from "@synara/contracts";
import {
  buildInlineVisualDocument,
  clampInlineVisualHeight,
  inlineVisualThemeMessage,
  readInlineVisualFrameMessage,
  type InlineVisualTheme,
} from "@synara/shared/inlineVisual";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { isElectron } from "~/env";
import { useInlineVisualTheme } from "~/hooks/useInlineVisualTheme";
import { DISCLOSURE_FADE_MOTION_CLASS } from "~/lib/disclosureMotion";
import { RotateCcwIcon } from "~/lib/icons";
import { inlineVisualQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { CopyTextButton } from "../ui/copyTextButton";
import { IconButton } from "../ui/icon-button";
import { useTranslation } from "~/i18n";

/**
 * An inline visual. The box holds the agent's expected height while the
 * document loads, then fits the height the page reports, so the transcript
 * grows once rather than jumping. Growth only re-measures the list row; it is
 * never a follow signal. A reader who scrolls over the frame still detaches
 * follow through `onScrollIntent`, since those gestures never reach the host.
 */
export function InlineVisualFrame(props: {
  readonly threadId: ThreadId;
  readonly visual: InlineVisualActivityPayload;
  readonly onScrollIntent?: ((upward: boolean) => void) | undefined;
}) {
  const { t } = useTranslation();

  // Browsers cannot intercept a document navigating its own iframe before the
  // network request. Execute agent HTML only where the native guard can do so.
  return isElectron ? (
    <DesktopInlineVisualFrame {...props} />
  ) : (
    <InlineVisualNotice
      title={props.visual.title}
      message={t(
        "HTML visuals are available in Synara Beta desktop. Use native components in the browser.",
      )}
    />
  );
}

function DesktopInlineVisualFrame({
  threadId,
  visual,
  onScrollIntent,
}: {
  readonly threadId: ThreadId;
  readonly visual: InlineVisualActivityPayload;
  readonly onScrollIntent?: ((upward: boolean) => void) | undefined;
}) {
  const { t } = useTranslation();

  const theme = useInlineVisualTheme();
  const visualDocument = useQuery(
    inlineVisualQueryOptions({ threadId, visualId: visual.visualId }),
  );
  // Reload mounts a fresh frame (and clears a stopped one) without refetching.
  const [generation, setGeneration] = useState(0);
  const [stopped, setStopped] = useState(false);
  const reload = () => {
    setStopped(false);
    setGeneration((value) => value + 1);
  };
  const html = visualDocument.data;

  // No caption row: the page is part of the reply and lines up with its text.
  // The title names the figure and frame for assistive technology instead.
  return (
    <figure className="group/inline-visual relative m-0 min-w-0" aria-label={visual.title}>
      {html !== undefined && !stopped ? (
        <>
          <InlineVisualDocument
            key={`${visual.visualId}:${generation}`}
            html={html}
            title={visual.title}
            reservedHeight={visual.height}
            theme={theme}
            onStopped={() => setStopped(true)}
            onScrollIntent={onScrollIntent}
          />
          <div
            className={cn(
              DISCLOSURE_FADE_MOTION_CLASS,
              "absolute end-1 top-1 flex items-center gap-0.5 rounded-md border border-border/60 bg-popover/90 p-0.5 opacity-0 shadow-xs backdrop-blur-sm focus-within:opacity-100 group-hover/inline-visual:opacity-100 pointer-coarse:opacity-100",
            )}
          >
            <CopyTextButton text={html} label={t("source")} className="text-ui-xs" />
            <IconButton label={t("Reload visual")} tooltip={t("Reload")} onClick={reload}>
              <RotateCcwIcon className="size-3.5" />
            </IconButton>
          </div>
        </>
      ) : stopped ? (
        <InlineVisualNotice
          title={visual.title}
          message={t("This visual stopped because it could not stay isolated.")}
          action="Reload"
          onAction={reload}
        />
      ) : visualDocument.isError ? (
        <InlineVisualNotice
          title={visual.title}
          message={t("Visual unavailable.")}
          {...(isRetryable(visualDocument.error)
            ? { action: "Retry", onAction: () => void visualDocument.refetch() }
            : {})}
        />
      ) : (
        <div
          className="flex items-center justify-center rounded-lg bg-muted/40 text-muted-foreground text-ui-xs"
          style={{ height: clampInlineVisualHeight(visual.height) }}
          role="status"
        >
          {t("Loading visual…")}
        </div>
      )}
    </figure>
  );
}

function isRetryable(error: unknown): boolean {
  return (error as { retryable?: unknown } | null)?.retryable !== false;
}

function InlineVisualNotice(props: {
  readonly title: string;
  readonly message: string;
  readonly action?: string;
  readonly onAction?: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-muted-foreground text-ui-sm"
      role="status"
    >
      <span className="max-w-[40%] truncate text-foreground">{props.title}</span>
      <span className="min-w-0 flex-1">{props.message}</span>
      {props.action && props.onAction ? (
        <Button size="xs" variant="outline" onClick={props.onAction}>
          {props.action}
        </Button>
      ) : null}
    </div>
  );
}

function InlineVisualDocument({
  html,
  title,
  reservedHeight,
  theme,
  onStopped,
  onScrollIntent,
}: {
  readonly html: string;
  readonly title: string;
  readonly reservedHeight: number;
  readonly theme: InlineVisualTheme;
  readonly onStopped: () => void;
  readonly onScrollIntent?: ((upward: boolean) => void) | undefined;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Built once per mount with the theme of that moment; later theme changes
  // arrive as messages, since a new srcdoc would reload the page and lose its
  // state. The parent keys this component by visual id and reload count.
  const [srcDoc] = useState(() => buildInlineVisualDocument(html, theme));
  const callbacks = useRef({ onStopped, onScrollIntent });
  const loads = useRef(0);
  const loadedWindow = useRef<Window | null>(null);
  useLayoutEffect(() => {
    callbacks.current = { onStopped, onScrollIntent };
  });

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(inlineVisualThemeMessage(theme), "*");
  }, [theme]);

  // Registered in the commit that inserts the frame: a fast page can post its
  // first size before a passive effect would run.
  useLayoutEffect(() => {
    let heightTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingHeight: number | undefined;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      // Only the frame's own window; the page's origin is opaque, so this is
      // the only way to tell its messages from anyone else's.
      if (frame === null || event.source === null || event.source !== frame.contentWindow) {
        return;
      }
      const message = readInlineVisualFrameMessage(event.data);
      if (message === undefined) return;
      if (message.type === "size") {
        pendingHeight = clampInlineVisualHeight(message.height);
        // Bound expensive transcript remeasurement to ten updates per second.
        if (heightTimer === undefined) {
          heightTimer = setTimeout(() => {
            heightTimer = undefined;
            setContentHeight(pendingHeight ?? null);
          }, 100);
        }
      } else if (message.type === "stopped") {
        callbacks.current.onStopped();
      } else if (message.type === "scroll-intent") {
        callbacks.current.onScrollIntent?.(message.upward);
      }
      // Untrusted HTML cannot open host URLs, even during user activation.
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (heightTimer !== undefined) clearTimeout(heightTimer);
    };
  }, []);

  const onLoad = () => {
    // srcdoc loads exactly once per browsing context. A second load in the same
    // context means the page navigated its own frame (desktop blocks that; a
    // browser cannot), so stop showing it. A frame re-inserted into the
    // document, where the list cannot move it intact, gets a new context and
    // its own srcdoc again: that is a fresh first load, not a navigation.
    const frameWindow = frameRef.current?.contentWindow ?? null;
    if (frameWindow !== loadedWindow.current) {
      loadedWindow.current = frameWindow;
      loads.current = 0;
    }
    loads.current += 1;
    if (loads.current > 1) {
      callbacks.current.onStopped();
      return;
    }
    setLoaded(true);
    // Covers a theme change that landed while the page was parsing.
    frameRef.current?.contentWindow?.postMessage(inlineVisualThemeMessage(theme), "*");
  };
  const height = contentHeight ?? clampInlineVisualHeight(reservedHeight);
  const colorScheme = loaded ? theme.appearance : "light";
  return (
    <iframe
      ref={frameRef}
      srcDoc={srcDoc}
      title={title}
      // Never allow-same-origin: the opaque origin keeps the page away from the
      // app's storage, cookies, and DOM. No popups, modals, downloads, or top
      // navigation; forms only so submit handlers run (CSP blocks submission).
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      className="block w-full border-0 bg-transparent"
      // A frame whose color scheme differs from its document's paints an
      // opaque canvas, so the blank document would flash until the page is in.
      style={{ height, colorScheme }}
      data-inline-visual-frame=""
    />
  );
}
