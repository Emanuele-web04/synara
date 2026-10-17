import type { NotionObject } from "@synara/contracts";
import { notionArray, notionCanonical, notionComparableValue } from "@synara/shared/notion";
/** Only changed supported fields are sent; original runs and cells remain the baseline. */
export function notionBlockDraftPatch(type: string, base: NotionObject, values: NotionObject) {
  if (
    ![
      "paragraph",
      "heading_1",
      "heading_2",
      "heading_3",
      "bulleted_list_item",
      "numbered_list_item",
      "to_do",
      "toggle",
      "quote",
      "callout",
      "code",
      "table_row",
    ].includes(type)
  )
    throw new Error("This block type is read-only in Synara.");
  if (type === "table_row") {
    if (
      !Array.isArray(base.cells) ||
      !Array.isArray(values.cells) ||
      values.cells.length !== base.cells.length ||
      notionArray(values.cells).some((cell) => !Array.isArray(cell))
    )
      throw new Error("Preserve the existing table width and complete rich-text cells.");
  } else if (
    !Array.isArray(base.rich_text) ||
    !Array.isArray(values.rich_text) ||
    (type === "to_do" && (typeof base.checked !== "boolean" || typeof values.checked !== "boolean"))
  )
    throw new Error("This block is incomplete. Reload it before editing.");
  const keys =
    type === "table_row"
      ? ["cells"]
      : type === "to_do"
        ? ["rich_text", "checked"]
        : type === "code"
          ? [
              "rich_text",
              ...(typeof base.language === "string" && typeof values.language === "string"
                ? ["language"]
                : []),
            ]
          : ["rich_text"];
  const changed = keys.filter(
    (key) =>
      notionCanonical(notionComparableValue(base[key], key)) !==
      notionCanonical(notionComparableValue(values[key], key)),
  );
  return {
    base: Object.fromEntries(changed.map((key) => [key, structuredClone(base[key])])),
    changes: Object.fromEntries(changed.map((key) => [key, structuredClone(values[key])])),
  };
}
