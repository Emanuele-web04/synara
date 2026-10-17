import type { NotionObject, NotionReadInput } from "@synara/contracts";
import {
  notionArray,
  notionObject,
  notionPropertyLabel,
  notionString,
  notionText,
  notionTitle,
  plainNotionText,
  safeNotionLink,
} from "@synara/shared/notion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  NotionRichText,
  NotionRichTextEditor,
  validateNotionRichTextDraft,
} from "./NotionRichText";
import { NotionPageProperties } from "./NotionRecordPropertyEditor";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { notionBlockDraftPatch } from "./notionDrafts";
import { NotionDatabaseWorkspace } from "./NotionDatabaseWorkspace";
import { NotionBlockComposer } from "./NotionBlockComposer";
import { NotionDraftBoundary, useNotionDraft, useNotionDraftGuard } from "./NotionDraftBoundary";
import { Checkbox } from "~/components/ui/checkbox";
import {
  NotionError,
  NotionReceiptNotice,
  NotionSelect,
  notionApi,
  useNotionAction,
} from "./notionUi";

function useResource(input: NotionReadInput) {
  return useQuery({
    queryKey: ["notion", "resource", input],
    queryFn: async () => (await notionApi().read(input)).data,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}
function ResourceList({
  input,
  onOpen,
}: {
  input: NotionReadInput;
  onOpen: (id: string, kind: "page" | "dataSource") => void;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useResource({ ...input, ...(cursor ? { cursor } : {}) });
  return (
    <div className="space-y-2">
      <NotionError message={query.error?.message} />
      {query.isPending ? (
        <p role="status" className="text-ui text-muted-foreground">
          Loading shared resources…
        </p>
      ) : null}
      {notionArray(query.data?.results).map((raw) => {
        const value = notionObject(raw);
        return (
          <Button
            key={notionString(value.id)}
            variant="ghost"
            className="flex w-full justify-between"
            onClick={() =>
              onOpen(notionString(value.id), value.object === "data_source" ? "dataSource" : "page")
            }
          >
            <span className="min-w-0 text-left">
              <span className="block truncate">{notionTitle(value)}</span>
              <span className="block truncate text-ui-xs text-muted-foreground">
                {notionText(value.description) ||
                  (notionString(value.last_edited_time)
                    ? "Edited " + notionString(value.last_edited_time).slice(0, 10)
                    : "Shared with this integration")}
              </span>
            </span>
            <span className="text-ui-xs text-muted-foreground">
              {value.object === "data_source" ? "Database" : "Page"}
            </span>
          </Button>
        );
      })}
      {query.data && !notionArray(query.data.results).length ? (
        <p className="text-ui text-muted-foreground">No shared resources match this title.</p>
      ) : null}
      <div className="flex gap-2">
        {cursor ? (
          <Button variant="outline" onClick={() => setCursor(undefined)}>
            First page
          </Button>
        ) : null}
        {query.data?.has_more === true ? (
          <Button
            variant="outline"
            onClick={() => setCursor(notionString(query.data?.next_cursor))}
          >
            Next page
          </Button>
        ) : null}
      </div>
    </div>
  );
}
/** Individual rich-text runs retain their annotations, links, mentions, and original order. */
/**
 * Each text run is edited independently so comments, mentions, colors and links
 * on neighboring runs survive a partial rich-text edit.
 */
const TextRuns = NotionRichTextEditor;
function Block({
  block,
  connectionId,
  depth,
  onOpen,
  onSaved,
  parentId,
}: {
  parentId: string;
  block: NotionObject;
  connectionId: string;
  depth: number;
  onOpen: (id: string, kind: "page") => void;
  onSaved: () => void;
}) {
  const type = notionString(block.type);
  const original = notionObject(block[type]);
  const [base, setBase] = useState<NotionObject | null>(null);
  const [draft, setDraft] = useState<NotionObject | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [inserting, setInserting] = useState(false);
  const action = useNotionAction();
  useNotionDraft(draft !== null || action.pending);
  const guard = useNotionDraftGuard();
  const content = draft ?? original;
  const text = notionText(content.rich_text);
  const link = safeNotionLink(
    notionObject(content.external).url || notionObject(content.file).url || content.url,
  );
  const editable = [
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
  ].includes(type);
  const style =
    type === "heading_1"
      ? "text-2xl font-semibold"
      : type === "heading_2"
        ? "text-xl font-medium"
        : type === "heading_3"
          ? "text-lg font-medium"
          : type === "code"
            ? "whitespace-pre-wrap rounded bg-muted p-3 font-mono text-ui-sm"
            : type === "quote"
              ? "border-l-2 border-border pl-3 italic"
              : "whitespace-pre-wrap text-ui";
  return (
    <div className="space-y-2 border-b border-border/50 py-3">
      {type === "divider" ? (
        <hr className="border-border" />
      ) : type === "child_page" ? (
        <Button variant="ghost" onClick={() => onOpen(notionString(block.id), "page")}>
          {notionString(content.title) || "Subpage"}
        </Button>
      ) : type === "table_row" ? (
        <div className="flex divide-x divide-border overflow-auto rounded border border-border">
          {notionArray(content.cells).map((cell, index) => (
            <span key={index} className="min-w-24 flex-1 p-2 text-ui">
              <NotionRichText runs={notionArray(cell)} />
            </span>
          ))}
        </div>
      ) : (
        <div className={style}>
          {type === "to_do" ? (
            <span aria-label={content.checked === true ? "Completed" : "Not completed"}>
              {content.checked === true ? "☑ " : "☐ "}
            </span>
          ) : null}
          {["bulleted_list_item", "numbered_list_item"].includes(type) ? <span>• </span> : null}
          {text ? (
            <NotionRichText runs={notionArray(content.rich_text)} />
          ) : type === "table" ? (
            "Table"
          ) : type === "child_database" ? (
            notionString(content.title)
          ) : editable ? (
            "Empty block"
          ) : (
            `Read-only ${type || "unsupported block"}`
          )}
        </div>
      )}
      {link ? (
        <a href={link} target="_blank" rel="noreferrer noopener" className="text-ui underline">
          Open {type === "image" ? "image" : "attachment or reference"}
        </a>
      ) : null}
      {draft ? (
        <div className="space-y-2 rounded-lg bg-muted/40 p-3">
          <fieldset disabled={action.pending || action.awaitingConfirmation}>
            {type === "table_row" ? (
              <div className="space-y-3">
                {notionArray(content.cells).map((cell, index) => (
                  <fieldset key={index} className="rounded border border-border p-2">
                    <legend className="text-ui-sm">Cell {index + 1}</legend>
                    <TextRuns
                      runs={notionArray(cell)}
                      onChange={(runs) =>
                        setDraft({
                          ...content,
                          cells: notionArray(content.cells).map((value, position) =>
                            position === index ? runs : value,
                          ),
                        })
                      }
                    />
                  </fieldset>
                ))}
              </div>
            ) : (
              <TextRuns
                runs={notionArray(content.rich_text)}
                onChange={(runs) => setDraft({ ...content, rich_text: runs })}
              />
            )}
            {type === "code" ? (
              <NotionSelect
                label="Code block language"
                value={notionString(content.language)}
                onChange={(language) => setDraft({ ...content, language })}
                options={[
                  ...new Set([
                    notionString(content.language),
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
                  ]),
                ]
                  .filter(Boolean)
                  .map((value) => ({ value, label: value }))}
              />
            ) : null}
            {type === "to_do" ? (
              <label className="flex items-center gap-2 text-ui">
                <Checkbox
                  checked={content.checked === true}
                  onCheckedChange={(checked) => setDraft({ ...content, checked })}
                />
                Completed
              </label>
            ) : null}
          </fieldset>
          <NotionError message={action.error} />
          <NotionReceiptNotice active={action.awaitingConfirmation} />
          <div className="flex gap-2">
            <Button
              disabled={action.pending}
              onClick={() =>
                void action.run(async () => {
                  if (!base)
                    throw new Error("Reopen this block editor to restore its original version.");
                  if (type === "table_row")
                    notionArray(content.cells).forEach((cell, index) =>
                      validateNotionRichTextDraft(
                        notionArray(notionArray(base.cells)[index]),
                        notionArray(cell),
                      ),
                    );
                  else
                    validateNotionRichTextDraft(
                      notionArray(base.rich_text),
                      notionArray(content.rich_text),
                    );
                  const patch = notionBlockDraftPatch(type, base, content);
                  if (Object.keys(patch.changes).length)
                    await action.write({
                      connectionId,
                      kind: "updateBlock",
                      id: notionString(block.id),
                      ...patch,
                    });
                  setDraft(null);
                  onSaved();
                })
              }
            >
              Save block
            </Button>
            <Button variant="ghost" disabled={action.pending} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : editable ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setBase(structuredClone(original));
            setDraft(structuredClone(original));
          }}
        >
          Edit block
        </Button>
      ) : null}
      {!draft ? (
        <Button size="sm" variant="ghost" onClick={() => setInserting(true)}>
          Insert after
        </Button>
      ) : null}
      {inserting ? (
        <NotionBlockComposer
          connectionId={connectionId}
          parentId={parentId}
          after={notionString(block.id)}
          onCancel={() => setInserting(false)}
          onSaved={() => {
            setInserting(false);
            onSaved();
          }}
        />
      ) : null}
      {block.has_children === true && depth < 8 ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => {
              if (!expanded || guard?.mayLeave() !== false) setExpanded((value) => !value);
            }}
          >
            {expanded ? "Hide nested content" : "Show nested content"}
          </Button>
          {expanded ? (
            <div className="ml-4 border-l border-border pl-3">
              <Children
                connectionId={connectionId}
                id={notionString(block.id)}
                depth={depth + 1}
                onOpen={onOpen}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
function Children({
  connectionId,
  id,
  depth = 0,
  onOpen,
}: {
  connectionId: string;
  id: string;
  depth?: number;
  onOpen: (id: string, kind: "page") => void;
}) {
  const guard = useNotionDraftGuard();
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useResource({ connectionId, kind: "children", id, ...(cursor ? { cursor } : {}) });
  return (
    <div>
      <NotionError message={query.error?.message} />
      {query.isPending ? (
        <p role="status" className="text-ui text-muted-foreground">
          Loading blocks…
        </p>
      ) : null}
      {notionArray(query.data?.results).map((raw) => {
        const block = notionObject(raw);
        return (
          <Block
            key={notionString(block.id)}
            parentId={id}
            block={block}
            connectionId={connectionId}
            depth={depth}
            onOpen={onOpen}
            onSaved={() => void query.refetch()}
          />
        );
      })}
      <div className="flex gap-2">
        {cursor ? (
          <Button
            variant="ghost"
            onClick={() => {
              if (guard?.mayLeave() !== false) setCursor(undefined);
            }}
          >
            First blocks
          </Button>
        ) : null}
        {query.data?.has_more === true ? (
          <Button
            variant="outline"
            onClick={() => {
              if (guard?.mayLeave() !== false) setCursor(notionString(query.data?.next_cursor));
            }}
          >
            Next blocks
          </Button>
        ) : null}
      </div>
    </div>
  );
}
function Comments({ connectionId, id }: { connectionId: string; id: string }) {
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useResource({ connectionId, kind: "comments", id, ...(cursor ? { cursor } : {}) });
  const [text, setText] = useState("");
  const [discussion, setDiscussion] = useState("");
  const action = useNotionAction();
  useNotionDraft(text.length > 0 || action.pending);
  return (
    <details className="space-y-3 rounded-lg border border-border p-3">
      <summary className="text-ui font-medium">Comments</summary>
      <NotionError message={query.error?.message ?? action.error} />
      <NotionReceiptNotice active={action.awaitingConfirmation} />
      {notionArray(query.data?.results).map((raw) => {
        const comment = notionObject(raw);
        return (
          <p className="border-b border-border py-2 text-ui" key={notionString(comment.id)}>
            <NotionRichText runs={notionArray(comment.rich_text)} />
            {notionString(comment.discussion_id) ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={action.pending || action.awaitingConfirmation}
                onClick={() => setDiscussion(notionString(comment.discussion_id))}
              >
                Reply
              </Button>
            ) : null}
          </p>
        );
      })}
      <div className="flex gap-2">
        {cursor ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
            First comments
          </Button>
        ) : null}
        {query.data?.has_more === true && query.data.next_cursor ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => setCursor(notionString(query.data?.next_cursor))}
          >
            Next comments
          </Button>
        ) : null}
      </div>
      {discussion ? (
        <p className="text-ui-sm text-muted-foreground">
          Replying to a discussion{" "}
          <Button size="sm" variant="ghost" onClick={() => setDiscussion("")}>
            Cancel reply
          </Button>
        </p>
      ) : null}
      <Textarea
        disabled={action.pending || action.awaitingConfirmation}
        aria-label="New page comment"
        value={text}
        maxLength={2000}
        onChange={(event) => setText(event.target.value)}
      />
      <Button
        disabled={action.pending || !text.trim()}
        onClick={() =>
          void action.run(async () => {
            await action.write({
              connectionId,
              kind: "comment",
              id,
              base: {},
              changes: {
                rich_text: plainNotionText(text),
                ...(discussion ? { discussion_id: discussion } : {}),
              },
            });
            setText("");
            setDiscussion("");
            await query.refetch();
          })
        }
      >
        Post comment
      </Button>
      <Button type="button" variant="ghost" disabled={action.pending} onClick={() => setText("")}>
        Discard comment draft
      </Button>
    </details>
  );
}
function Page({
  connectionId,
  id,
  onOpen,
}: {
  connectionId: string;
  id: string;
  onOpen: (id: string, kind: "page") => void;
}) {
  const query = useResource({ connectionId, kind: "page", id });
  const queryClient = useQueryClient();
  return (
    <div className="space-y-4">
      <NotionError message={query.error?.message} />
      <h2 className="text-2xl font-semibold">
        {query.data ? notionTitle(query.data) : "Loading page…"}
      </h2>
      {query.data ? (
        <NotionPageProperties
          connectionId={connectionId}
          page={query.data}
          onSaved={() => void query.refetch()}
        />
      ) : null}
      {query.data ? (
        <Children key={id} connectionId={connectionId} id={id} onOpen={onOpen} />
      ) : null}
      <NotionBlockComposer
        connectionId={connectionId}
        parentId={id}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ["notion", "resource"] });
        }}
      />
      <Comments connectionId={connectionId} id={id} />
    </div>
  );
}
function Records(props: {
  connectionId: string;
  id: string;
  onOpen: (id: string, kind: "page") => void;
}) {
  return <NotionDatabaseWorkspace {...props} />;
}
function NotionBrowserContent({
  connectionId,
  pageId,
  dataSourceId,
  onClose,
}: {
  connectionId: string;
  pageId?: string | undefined;
  dataSourceId?: string | undefined;
  onClose: () => void;
}) {
  const guard = useNotionDraftGuard();
  const close = () => {
    if (guard?.mayLeave() !== false) onClose();
  };
  const [path, setPath] = useState<{ id: string; kind: "page" | "dataSource" }[]>(
    dataSourceId
      ? [{ id: dataSourceId, kind: "dataSource" }]
      : pageId
        ? [{ id: pageId, kind: "page" }]
        : [],
  );
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [searchKind, setSearchKind] = useState("");
  const current = path.at(-1);
  const open = (id: string, kind: "page" | "dataSource") => {
    if (guard?.mayLeave() !== false) setPath((previous) => [...previous, { id, kind }]);
  };
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogPopup
        className="w-[min(64rem,94vw)] sm:max-w-none"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>Shared Notion content</DialogTitle>
          <DialogDescription>
            Authorized pages and databases, rendered with Synara controls. Unsupported content stays
            read-only.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[75vh] space-y-4 overflow-auto">
          <div className="flex justify-between gap-2">
            <Button
              variant="ghost"
              disabled={!path.length}
              onClick={() => {
                if (guard?.mayLeave() !== false) setPath((previous) => previous.slice(0, -1));
              }}
            >
              Back
            </Button>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
          </div>
          <NotionError message={guard?.error} />
          {current ? (
            current.kind === "page" ? (
              <Page key={current.id} connectionId={connectionId} id={current.id} onOpen={open} />
            ) : (
              <Records key={current.id} connectionId={connectionId} id={current.id} onOpen={open} />
            )
          ) : (
            <>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSearch(query);
                }}
              >
                <Input
                  aria-label="Search shared Notion titles"
                  placeholder="Search shared page and database titles"
                  value={query}
                  maxLength={200}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <Button type="submit">Search</Button>
              </form>
              <NotionSelect
                label="Search resource type"
                value={searchKind}
                onChange={setSearchKind}
                options={[
                  { value: "", label: "Pages and databases" },
                  { value: "page", label: "Pages and wiki documents" },
                  { value: "data_source", label: "Databases" },
                ]}
              />
              <p className="text-ui-sm text-muted-foreground">
                Search matches authorized page and database titles in this workspace. Open a
                database to search its records; this is not document full-text search.
              </p>
              <ResourceList
                key={search + searchKind}
                input={{
                  connectionId,
                  kind: "search",
                  query: search,
                  ...(searchKind ? { filter: { property: "object", value: searchKind } } : {}),
                }}
                onOpen={open}
              />
            </>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function NotionBrowser(props: {
  connectionId: string;
  pageId?: string | undefined;
  dataSourceId?: string | undefined;
  onClose: () => void;
}) {
  return (
    <NotionDraftBoundary>
      <NotionBrowserContent {...props} />
    </NotionDraftBoundary>
  );
}
