import {
  CloudSyncIcon,
  GitBranchIcon,
  GitCommitIcon,
  type LucideIcon,
  PushIcon,
} from "~/lib/icons";
import type { GitGlyphName } from "./GitActionsControl.logic";
import { GitHubIcon } from "./Icons";

// central icons render as masked spans (not <svg>), so size them explicitly rather than via parent `[&>svg]` selectors
export const GIT_ACTION_ICON_CLASS = "size-3.5";

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
