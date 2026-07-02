// FILE: ComposerStackedPanelContent.tsx
// Purpose: Semantic row primitives for content inside ComposerStackedPanel so plan
// activity, queued follow-ups, and live file-change strips share one layout contract.
// Layer: Chat composer layout
// Exports: ComposerStackedPanelRow, ComposerStackedPanelHeaderRow,
// ComposerStackedPanelRowMain, ComposerStackedPanelRowLabel

import { memo, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  COMPOSER_STACKED_PANEL_HEADER_ROW_CLASS_NAME,
  COMPOSER_STACKED_PANEL_LABEL_CLASS_NAME,
  COMPOSER_STACKED_PANEL_META_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ROW_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ROW_COMPACT_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ROW_MAIN_CLASS_NAME,
} from "./composerStackedPanelStyles";

interface ComposerStackedPanelRowProps extends HTMLAttributes<HTMLDivElement> {
  compact?: boolean;
}

export const ComposerStackedPanelRow = memo(function ComposerStackedPanelRow({
  compact = false,
  className,
  ...rest
}: ComposerStackedPanelRowProps) {
  return (
    <div
      className={cn(
        compact
          ? COMPOSER_STACKED_PANEL_ROW_COMPACT_CLASS_NAME
          : COMPOSER_STACKED_PANEL_ROW_CLASS_NAME,
        className,
      )}
      {...rest}
    />
  );
});

export const ComposerStackedPanelHeaderRow = memo(function ComposerStackedPanelHeaderRow({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(COMPOSER_STACKED_PANEL_HEADER_ROW_CLASS_NAME, className)} {...rest} />;
});

export const ComposerStackedPanelRowMain = memo(function ComposerStackedPanelRowMain({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(COMPOSER_STACKED_PANEL_ROW_MAIN_CLASS_NAME, className)} {...rest} />;
});

interface ComposerStackedPanelRowLabelProps {
  children: ReactNode;
  className?: string;
  tone?: "primary" | "meta";
}

export const ComposerStackedPanelRowLabel = memo(function ComposerStackedPanelRowLabel({
  children,
  className,
  tone = "primary",
}: ComposerStackedPanelRowLabelProps) {
  return (
    <span
      className={cn(
        tone === "meta"
          ? COMPOSER_STACKED_PANEL_META_CLASS_NAME
          : COMPOSER_STACKED_PANEL_LABEL_CLASS_NAME,
        className,
      )}
    >
      {children}
    </span>
  );
});
