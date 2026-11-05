// FILE: timelineBubbles.logic.ts
// Purpose: The iMessage layout of SynBot bot chats (HoloBot's thread rows): where a date
//          separator goes, which message starts a run from one side, and the text color on a
//          bubble tinted with the bot's color.
// Layer: Web view logic (pure)
// Exports: TimelineBubbleStyle, BubbleRowLayout, deriveBubbleRowLayout, sameBubbleRowLayout,
//          bubbleTextColor

/** Bubbles instead of the plain transcript. Only bot chats set it. */
export interface TimelineBubbleStyle {
  /** The user's bubble color (the bot's mascot color); null keeps the app's user bubble. */
  readonly userTint: string | null;
}

export interface BubbleRowLayout {
  /** When a date separator above this row is labeled from (ISO), or null for none. */
  readonly separatorAt: string | null;
  /** The first of a run from one side: more space above it. */
  readonly groupStart: boolean;
}

export interface BubbleLayoutRow {
  readonly id: string;
  readonly kind: string;
  readonly message?: { readonly role: string; readonly createdAt: string } | undefined;
}

/** A separator starts the chat, follows an hour's silence, and opens each new day. */
const SEPARATOR_GAP_MS = 60 * 60 * 1000;
/** Messages from one side within five minutes sit close together. */
const GROUP_GAP_MS = 5 * 60 * 1000;

const localDay = (ms: number) => {
  const date = new Date(ms);
  return date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate();
};

/** Layout for each message row, keyed by row id. Other rows (cards, status lines) end a run. */
export function deriveBubbleRowLayout(
  rows: readonly BubbleLayoutRow[],
): ReadonlyMap<string, BubbleRowLayout> {
  const layout = new Map<string, BubbleRowLayout>();
  let previous: { readonly at: number; readonly side: "user" | "bot" | "other" } | null = null;
  for (const row of rows) {
    if (row.kind !== "message" || !row.message) {
      if (previous !== null) previous = { at: previous.at, side: "other" };
      continue;
    }
    const parsed = Date.parse(row.message.createdAt);
    const at = Number.isFinite(parsed) ? parsed : (previous?.at ?? 0);
    const side = row.message.role === "user" ? "user" : "bot";
    const separator =
      previous === null ||
      at - previous.at >= SEPARATOR_GAP_MS ||
      localDay(at) !== localDay(previous.at);
    const groupStart =
      separator || previous === null || previous.side !== side || at - previous.at >= GROUP_GAP_MS;
    layout.set(row.id, { separatorAt: separator ? row.message.createdAt : null, groupStart });
    previous = { at, side };
  }
  return layout;
}

/** Equal layouts, so a streamed reply keeps the map's identity and only its own row redraws. */
export function sameBubbleRowLayout(
  left: ReadonlyMap<string, BubbleRowLayout>,
  right: ReadonlyMap<string, BubbleRowLayout>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, entry] of left) {
    const other = right.get(id);
    if (
      !other ||
      other.separatorAt !== entry.separatorAt ||
      other.groupStart !== entry.groupStart
    ) {
      return false;
    }
  }
  return true;
}

/** White on a dark or saturated tint, near black on a light one. */
export function bubbleTextColor(hex: string): string {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  if (!Number.isFinite(value)) return "#ffffff";
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.72 ? "#111111" : "#ffffff";
}
