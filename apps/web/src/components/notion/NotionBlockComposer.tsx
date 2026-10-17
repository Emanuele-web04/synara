import type { NotionObject } from "@synara/contracts";
import { notionResourceId, plainNotionText, safeNotionLink } from "@synara/shared/notion";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useNotionDraft } from "./NotionDraftBoundary";
import { NotionError, NotionReceiptNotice, NotionSelect, useNotionAction } from "./notionUi";

const TYPES = [
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
  "table",
  "divider",
  "bookmark",
  "image",
  "file",
  "link_to_page",
];
const COMMANDS: Record<string, string> = {
  text: "paragraph",
  h1: "heading_1",
  h2: "heading_2",
  h3: "heading_3",
  bullet: "bulleted_list_item",
  number: "numbered_list_item",
  todo: "to_do",
  toggle: "toggle",
  quote: "quote",
  callout: "callout",
  code: "code",
  table: "table",
  divider: "divider",
  link: "bookmark",
  image: "image",
  file: "file",
  page: "link_to_page",
};
export function buildNotionBlock(
  type: string,
  text: string,
  url: string,
  language: string,
  header: boolean,
): NotionObject {
  if (!TYPES.includes(type)) throw new Error("Choose a supported block type.");
  if (type === "divider") return { object: "block", type, divider: {} };
  if (type === "link_to_page")
    return {
      object: "block",
      type,
      link_to_page: { type: "page_id", page_id: notionResourceId(url) },
    };
  if (["image", "file", "bookmark"].includes(type)) {
    const target = safeNotionLink(url);
    if (!target || !target.startsWith("https://"))
      throw new Error("Use a valid HTTPS media or bookmark URL.");
    return {
      object: "block",
      type,
      [type]:
        type === "bookmark"
          ? { url: target, caption: plainNotionText(text) }
          : { type: "external", external: { url: target }, caption: plainNotionText(text) },
    };
  }
  if (type === "table") {
    const rows = text.split("\n").map((row) => row.split("\t"));
    const width = rows[0]?.length ?? 0;
    if (!width || width > 12 || rows.length > 30 || rows.some((row) => row.length !== width))
      throw new Error(
        "Paste a rectangular tab-separated table with 1–12 columns and at most 30 rows.",
      );
    return {
      object: "block",
      type: "table",
      table: {
        table_width: width,
        has_column_header: header,
        has_row_header: false,
        children: rows.map((row) => ({
          object: "block",
          type: "table_row",
          table_row: { cells: row.map(plainNotionText) },
        })),
      },
    };
  }
  if (!text.trim()) throw new Error("Write some content before inserting this block.");
  return {
    object: "block",
    type,
    [type]: {
      rich_text: plainNotionText(text),
      ...(type === "to_do" ? { checked: false } : {}),
      ...(type === "code" ? { language } : {}),
      ...(type === "callout" ? { icon: { type: "emoji", emoji: "💡" } } : {}),
    },
  };
}
export function NotionBlockComposer({
  connectionId,
  parentId,
  after,
  onSaved,
  onCancel,
}: {
  connectionId: string;
  parentId: string;
  after?: string | undefined;
  onSaved: () => void;
  onCancel?: (() => void) | undefined;
}) {
  const [type, setType] = useState("paragraph");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [language, setLanguage] = useState("plain text");
  const [header, setHeader] = useState(true);
  const action = useNotionAction();
  const locked = action.pending || action.awaitingConfirmation;
  useNotionDraft(Boolean(text || url) || action.pending);
  const commands = /^\/[a-z0-9_]*$/.test(text)
    ? Object.entries(COMMANDS).filter(([name]) => name.startsWith(text.slice(1)))
    : [];
  const selectCommand = (command: string) => {
    setType(command);
    setText("");
  };
  return (
    <form
      className="space-y-3 rounded-xl border border-border bg-muted/10 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          const child = buildNotionBlock(type, text, url, language, header);
          await action.write({
            connectionId,
            kind: "appendBlocks",
            id: parentId,
            base: {},
            changes: { children: [child], ...(after ? { after } : {}) },
          });
          setText("");
          setUrl("");
          onSaved();
        });
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-ui font-medium">
          {after ? "Insert after this block" : "Add document content"}
        </h3>
        <NotionSelect
          label="New block type"
          value={type}
          onChange={setType}
          disabled={locked}
          options={TYPES.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
        />
      </div>
      {type !== "divider" ? (
        <Textarea
          aria-label="New block content"
          placeholder={
            type === "table"
              ? "Paste rows separated by newlines and columns separated by tabs"
              : "Write content, or type / for block commands"
          }
          value={text}
          maxLength={12000}
          rows={type === "table" ? 5 : 3}
          disabled={locked}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (commands.length && event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              selectCommand(commands[0]![1]);
            }
            if (event.key === "Escape" && commands.length) {
              event.preventDefault();
              setText("");
            }
          }}
        />
      ) : (
        <p className="text-ui-sm text-muted-foreground">
          Insert a horizontal divider without changing existing blocks.
        </p>
      )}
      {commands.length ? (
        <div
          role="group"
          aria-label="Slash commands"
          className="flex flex-wrap gap-1 rounded-lg border border-border p-2"
        >
          {commands.map(([name, value]) => (
            <Button
              key={name}
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => selectCommand(value)}
            >
              /{name}
            </Button>
          ))}
        </div>
      ) : null}
      {["image", "file", "bookmark", "link_to_page"].includes(type) ? (
        <label className="grid gap-1 text-ui-sm">
          {type === "link_to_page" ? "Shared Notion page ID" : "HTTPS URL"}
          <Input
            aria-label="Block reference"
            value={url}
            disabled={locked}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
      ) : null}
      {type === "code" ? (
        <NotionSelect
          label="Code language"
          value={language}
          onChange={setLanguage}
          disabled={locked}
          options={[
            "plain text",
            "typescript",
            "javascript",
            "python",
            "json",
            "bash",
            "sql",
            "rust",
            "html",
            "css",
            "markdown",
          ].map((value) => ({ value, label: value }))}
        />
      ) : null}
      {type === "table" ? (
        <label className="flex items-center gap-2 text-ui-sm">
          <Checkbox
            checked={header}
            disabled={locked}
            onCheckedChange={(checked) => setHeader(checked === true)}
          />
          First row is a header
        </label>
      ) : null}
      <NotionError message={action.error} />
      <NotionReceiptNotice active={action.awaitingConfirmation} />
      <div className="flex gap-2">
        <Button type="submit" disabled={action.pending || commands.length > 0}>
          {action.awaitingConfirmation ? "Check original insertion" : "Insert block"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={action.pending}
          onClick={() => {
            setText("");
            setUrl("");
            onCancel?.();
          }}
        >
          Discard new block
        </Button>
      </div>
    </form>
  );
}
