// FILE: GitActionsControl.Glyphs.tsx
// Purpose: Shared glyph/icon presentation and picker-row primitives for the git action control.
// Layer: Header action control (presentational)
// Exports: GitGlyphName, GitPickerMenuItem, GitActionGlyph, GitQuickActionIcon, GitPickerMenuRow.

import {
  CloudSyncIcon,
  GitBranchIcon,
  GitCommitIcon,
  InfoIcon,
  type LucideIcon,
  PushIcon,
} from "~/lib/icons";
import { MenuItem } from "~/components/ui/menu";
import { GitHubIcon } from "./Icons";
import type { GitGlyphName, GitPickerMenuItem, GitQuickAction } from "./GitActionsControl.logic";

export type { GitGlyphName, GitPickerMenuItem } from "./GitActionsControl.logic";

// Central icons render as masked spans (not <svg>), so size them explicitly here
// rather than relying on parent `[&>svg]` selectors.
const GIT_ACTION_ICON_CLASS = "size-3.5";

const GIT_ACTION_GLYPH: Record<GitGlyphName, LucideIcon> = {
  commit: GitCommitIcon,
  push: PushIcon,
  pr: GitHubIcon,
  sync: CloudSyncIcon,
  branch: GitBranchIcon,
};

export function GitActionGlyph({ name, className }: { name: GitGlyphName; className?: string }) {
  const Glyph = GIT_ACTION_GLYPH[name];
  return <Glyph className={className ?? GIT_ACTION_ICON_CLASS} />;
}

// Map a header quick action onto its shared glyph name; null falls back to a hint icon.
// Every push-family action collapses to "push" so the button matches the picker rows.
function resolveGitQuickActionGlyph(quickAction: GitQuickAction): GitGlyphName | null {
  if (quickAction.kind === "open_pr") return "pr";
  if (quickAction.kind === "run_pull") return "sync";
  if (quickAction.kind === "create_branch") return "branch";
  if (quickAction.kind === "run_action") {
    return quickAction.action === "commit" ? "commit" : "push";
  }
  if (quickAction.label === "Commit") return "commit";
  return null;
}

export function GitQuickActionIcon({ quickAction }: { quickAction: GitQuickAction }) {
  const name = resolveGitQuickActionGlyph(quickAction);
  if (name) return <GitActionGlyph name={name} />;
  return <InfoIcon className={GIT_ACTION_ICON_CLASS} />;
}

export function GitPickerMenuRow({ item }: { item: GitPickerMenuItem }) {
  return (
    <MenuItem disabled={item.disabled} onClick={item.onSelect}>
      <span className="inline-flex shrink-0 items-center [&>svg]:size-3.5">
        <GitActionGlyph name={item.icon} />
      </span>
      <span>{item.label}</span>
    </MenuItem>
  );
}
