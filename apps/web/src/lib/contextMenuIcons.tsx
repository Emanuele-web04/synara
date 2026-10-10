// native menus can't render React — Central glyphs pass by basename, other sets are rendered to SVG markup from the same components the app shows

import { renderToStaticMarkup } from "react-dom/server";

import { THREAD_ARCHIVE_ICON } from "~/components/ThreadArchiveActionButton";
import {
  BELL_ICON_NAME,
  ClockIcon,
  COPY_ICON_NAME,
  DeviceLaptopIcon,
  EYE_OPEN_ICON_NAME,
  FolderOpenIcon,
  GitBranchIcon,
  HandoffIcon,
  PENCIL_ICON_NAME,
  PIN_ICON_NAME,
  TerminalIcon,
  Trash2,
  WorktreeIcon,
} from "./icons";

export const THREAD_CONTEXT_MENU_ICONS = {
  rename: PENCIL_ICON_NAME,
  pin: PIN_ICON_NAME,
  clearNotification: BELL_ICON_NAME,
  markUnread: EYE_OPEN_ICON_NAME,
  // Same glyph as the chat header's Hand off button.
  handoff: renderToStaticMarkup(<HandoffIcon />),
  // Fork shares the branch glyph (see GitForkIcon); its targets match the env-mode glyphs.
  fork: renderToStaticMarkup(<GitBranchIcon />),
  forkLocal: renderToStaticMarkup(<DeviceLaptopIcon />),
  forkWorktree: renderToStaticMarkup(<WorktreeIcon />),
  // Same glyph as the project rows' open folder.
  group: renderToStaticMarkup(<FolderOpenIcon />),
  // Same glyph as the composer's snooze notice.
  snooze: renderToStaticMarkup(<ClockIcon />),
  copy: COPY_ICON_NAME,
  openInTerminal: renderToStaticMarkup(<TerminalIcon />),
  // Same glyph as the thread row's hover archive button.
  archive: renderToStaticMarkup(<THREAD_ARCHIVE_ICON size={24} />),
  delete: renderToStaticMarkup(<Trash2 />),
} as const;
