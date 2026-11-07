// FILE: NotchIslandPublisher.tsx
// Purpose: Keep the desktop notch island in step with the chats the Inbox shows.
// Layer: Global runtime component (renders nothing)
// Depends on: desktopBridge.notchIsland (macOS Synara Beta only), the Inbox grouping.

import type { DesktopNotchIslandSnapshot } from "@synara/contracts";
import { PROVIDER_GLYPHS } from "@synara/profile-ui/provider-icon";
import { useEffect, useMemo, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useAppSettings } from "../appSettings";
import { groupInboxThreads } from "../components/inbox/inbox.logic";
import { useActivityThreads } from "../hooks/useActivityThreads";
import { useDismissedThreadStatusKeys } from "../hooks/useDismissedThreadStatusKeys";
import { isNotchIslandAvailable } from "../hooks/useDesktopNotchIsland";
import { useStore } from "../store";
import { buildNotchIslandSnapshot } from "./buildNotchIslandSnapshot";

/** Streaming updates change the grouping often; the island only needs a few frames a second. */
const PUBLISH_INTERVAL_MS = 250;
/** The island is always dark, so monochrome glyphs are drawn in its ink colour. */
const ISLAND_GLYPH_INK = "#F5F5F5";
/**
 * OpenCode's glyph carries its own dark plate and disappears on the dark island;
 * Antigravity's masks and filters are not drawn by macOS's SVG renderer. Both
 * fall back to the island's plain dot.
 */
const GLYPHS_WITHOUT_ISLAND_ICON = new Set(["opencode", "antigravity"]);

const glyphMarkupCache = new Map<string, string | null>();

/** The same provider glyph the app draws, as SVG markup the native island can render. */
function providerGlyphMarkup(provider: string): string | null {
  const cached = glyphMarkupCache.get(provider);
  if (cached !== undefined) return cached;
  const Glyph = (PROVIDER_GLYPHS as Record<string, (typeof PROVIDER_GLYPHS)["codex"]>)[provider];
  const markup =
    Glyph && !GLYPHS_WITHOUT_ISLAND_ICON.has(provider)
      ? renderToStaticMarkup(<Glyph width={32} height={32} aria-hidden />).replaceAll(
          "currentColor",
          ISLAND_GLYPH_INK,
        )
      : null;
  glyphMarkupCache.set(provider, markup);
  return markup;
}

export function NotchIslandPublisher() {
  // The bridge and platform never change while the page lives, so this gate is stable.
  return isNotchIslandAvailable() ? <NotchIslandPublisherRuntime /> : null;
}

function NotchIslandPublisherRuntime() {
  const { settings } = useAppSettings();
  const projects = useStore((store) => store.projects);
  const dismissedStatusKeys = useDismissedThreadStatusKeys();
  const { visibleNonGroupThreads } = useActivityThreads({
    hideAutomationRunThreads: !settings.showAutomationRunThreads,
  });

  const snapshot = useMemo<DesktopNotchIslandSnapshot>(() => {
    const projectById = new Map(projects.map((project) => [project.id as string, project]));
    const base = buildNotchIslandSnapshot(
      groupInboxThreads(visibleNonGroupThreads, dismissedStatusKeys),
      projectById,
    );
    const icons: Record<string, string> = {};
    for (const row of base.rows) {
      if (!row.provider || icons[row.provider]) continue;
      const markup = providerGlyphMarkup(row.provider);
      if (markup) icons[row.provider] = markup;
    }
    return { ...base, icons };
  }, [dismissedStatusKeys, projects, visibleNonGroupThreads]);

  const lastSentRef = useRef<string | null>(null);
  const pendingRef = useRef<DesktopNotchIslandSnapshot>(snapshot);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    pendingRef.current = snapshot;
    if (timerRef.current) return;
    const publish = () => {
      timerRef.current = null;
      const next = pendingRef.current;
      const serialized = JSON.stringify(next);
      if (serialized === lastSentRef.current) return;
      lastSentRef.current = serialized;
      window.desktopBridge?.notchIsland?.publishSnapshot(next);
    };
    if (lastSentRef.current === null) {
      publish();
      return;
    }
    timerRef.current = setTimeout(publish, PUBLISH_INTERVAL_MS);
  }, [snapshot]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return null;
}
