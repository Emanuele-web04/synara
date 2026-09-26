// FILE: sidebarHoverCardStyles.ts
// Purpose: Single source of truth for the sidebar hover cards (thread + project) —
//          their open/close timing, popup placement, surface chrome, and internal
//          padding tokens. Both surfaces consume these so they open, sit, dismiss,
//          and read identically and can never drift apart.
// Layer: Sidebar UI styling
// Exports: SIDEBAR_HOVER_CARD_TRIGGER_PROPS, SIDEBAR_HOVER_CARD_POPUP_PROPS,
//          SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
//          SIDEBAR_HOVER_CARD_CONTAINER_PADDING_CLASS_NAME,
//          SIDEBAR_HOVER_CARD_ROW_PADDING_CLASS_NAME, SIDEBAR_HOVER_CARD_ROW_CLASS_NAME
// Why: The thread card is a Base UI Tooltip and the project card a PreviewCard —
//      two different primitives. Centralizing every shared characteristic here is
//      what keeps the two reading as one component instead of two look-alikes.

import { APP_TOOLTIP_SURFACE_CLASS_NAME } from "./chat/composerPickerStyles";

/** Outer inset on the hover-card content container (sits inside the popup surface). */
export const SIDEBAR_HOVER_CARD_CONTAINER_PADDING_CLASS_NAME = "p-0.5";

/** Per-row padding for each line in a hover card (header, meta, menu rows). */
export const SIDEBAR_HOVER_CARD_ROW_PADDING_CLASS_NAME = "px-1.5 py-1";

/**
 * Full per-row treatment shared by both hover cards: layout, padding, compact
 * type, and — crucially — `leading-none`, so every row is the same height. Rows
 * add only their own color (and the title overrides leading to wrap). Padding
 * and font here are the single source of truth for both cards' rhythm.
 */
export const SIDEBAR_HOVER_CARD_ROW_CLASS_NAME = `flex w-full min-w-0 items-center gap-2.5 rounded-md ${SIDEBAR_HOVER_CARD_ROW_PADDING_CLASS_NAME} text-ui-sm leading-none`;

/**
 * Frosted surface chrome shared by both hover-card popups: the same shared tooltip
 * surface every plain tooltip uses (APP_TOOLTIP_SURFACE_CLASS_NAME) plus a single
 * fixed width so the thread and project cards are always exactly the same size.
 * Width is owned here (not on either card's content) so neither surface can set its
 * own, and the surface itself is sourced from the tooltip token so the cards and
 * plain tooltips can never drift apart.
 */
export const SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME = `${APP_TOOLTIP_SURFACE_CLASS_NAME} w-[16rem]`;

/**
 * Open/close timing spread onto the thread cards' Tooltip.Triggers. In Base UI
 * `delay`/`closeDelay` live on the trigger (Tooltip.Trigger and
 * PreviewCard.Trigger), NOT the root — passing them to the root is silently
 * ignored. `delay: 300` dwell-gates the first open so a pointer swept down the
 * list doesn't strobe a card per row crossed; the app-root `TooltipProvider`
 * delay group still applies, so a trigger with its own `delay` opens instantly
 * while the group is in its instant phase (adjacent rows re-open at 0ms).
 * `closeDelay: 0` dismisses the card the instant the pointer leaves.
 */
export const SIDEBAR_HOVER_CARD_TRIGGER_PROPS = {
  delay: 300,
  closeDelay: 0,
} as const;

/**
 * The project card is a PreviewCard (not a Tooltip), so it cannot join the
 * TooltipProvider delay group — a gated first open would never get the instant
 * re-open payoff. It also carries clickable controls, so it keeps the original
 * instant-open timing instead.
 */
export const SIDEBAR_PROJECT_HOVER_CARD_TRIGGER_PROPS = {
  delay: 0,
  closeDelay: 0,
} as const;

/**
 * Popup placement spread onto BOTH cards' popups so they anchor, offset, and stack
 * identically. The negative side offset overlaps the popup with its row, removing
 * the gap the pointer would otherwise cross. `z-[100]` lifts the cards above the
 * app's z-[90] surfaces while staying under modals (z-[200]+).
 */
export const SIDEBAR_HOVER_CARD_POPUP_PROPS = {
  side: "right",
  align: "start",
  sideOffset: -2,
  positionerClassName: "z-[100]",
} as const;
