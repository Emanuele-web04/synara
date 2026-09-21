// native menus can't render React — Central glyphs pass by basename, other sets are rendered to SVG markup from the same components the app shows

import { renderToStaticMarkup } from "react-dom/server";

import { THREAD_ARCHIVE_ICON } from "~/components/ThreadArchiveActionButton";
import {
  BELL_ICON_NAME,
  COPY_ICON_NAME,
  EYE_OPEN_ICON_NAME,
  HANDOFF_ICON_NAME,
  PENCIL_ICON_NAME,
  PIN_ICON_NAME,
  TERMINAL_ICON_NAME,
  Trash2,
} from "./icons";

export const THREAD_CONTEXT_MENU_ICONS = {
  rename: PENCIL_ICON_NAME,
  pin: PIN_ICON_NAME,
  clearNotification: BELL_ICON_NAME,
  markUnread: EYE_OPEN_ICON_NAME,
  handoff: HANDOFF_ICON_NAME,
  copy: COPY_ICON_NAME,
  openInTerminal: TERMINAL_ICON_NAME,
  archive: renderToStaticMarkup(<THREAD_ARCHIVE_ICON size={24} />),
  delete: renderToStaticMarkup(<Trash2 />),
} as const;
