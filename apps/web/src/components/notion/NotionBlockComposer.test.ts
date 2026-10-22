import { describe, expect, it } from "vitest";
import { buildNotionBlock } from "./NotionBlockComposer";
import { validateNotionRichTextDraft } from "./NotionRichText";
import { plainNotionText } from "@synara/shared/notion";
describe("Notion document composition", () => {
  it("builds real table rows with bounded rectangular cells", () => {
    const block = buildNotionBlock("table", "Name\tEstimate\nOAuth\t5", "", "plain text", true);
    expect(block.type).toBe("table");
    expect(block.table).toMatchObject({ table_width: 2, has_column_header: true });
    expect(() =>
      buildNotionBlock("table", "Name\tEstimate\nOAuth", "", "plain text", true),
    ).toThrow("rectangular");
  });
  it("does not accept executable or insecure media URLs", () => {
    expect(() => buildNotionBlock("image", "", "javascript:alert(1)", "plain text", false)).toThrow(
      "HTTPS",
    );
  });
  it("retains mentions and rejects their replacement", () => {
    const mention = {
      type: "mention",
      mention: { type: "page", page: { id: "11111111-1111-4111-8111-111111111111" } },
      plain_text: "Roadmap",
    };
    expect(() =>
      validateNotionRichTextDraft([mention], [mention, ...plainNotionText("Ready")]),
    ).not.toThrow();
    expect(() => validateNotionRichTextDraft([mention], plainNotionText("Roadmap"))).toThrow(
      "preserved",
    );
  });
  it("validates links at save rather than discarding intermediate drafts", () => {
    expect(() =>
      validateNotionRichTextDraft([], [{ text: { content: "Read", link: { url: "https:" } } }]),
    ).toThrow("complete");
    expect(() =>
      validateNotionRichTextDraft(
        [],
        [{ text: { content: "Read", link: { url: "https://example.test/" } } }],
      ),
    ).not.toThrow();
  });
});
