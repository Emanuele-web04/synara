import type { NotionObject } from "@synara/contracts";
import {
  notionArray,
  notionCanonical,
  notionComparableValue,
  notionObject,
  notionPropertyLabel,
  notionPropertySnapshot,
  notionString,
  notionTitle,
} from "@synara/shared/notion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { NotionDraftBoundary, useNotionDraft, useNotionDraftGuard } from "./NotionDraftBoundary";
import { PropertyControl } from "./NotionTaskPropertyEditor";
import { NotionRichTextEditor, validateNotionRichTextDraft } from "./NotionRichText";
import {
  notionProperties,
  notionPropertyReadOnlyReason,
  writablePropertyValue,
  type MappedNotionProperty,
} from "./notionProperties";
import { NotionError, NotionReceiptNotice, notionApi, useNotionAction } from "./notionUi";

interface Props {
  connectionId: string;
  source: NotionObject;
  page: NotionObject;
  propertyId?: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}
function PropertyForm(props: Props) {
  const [snapshot] = useState(() => ({
    source: structuredClone(props.source),
    page: structuredClone(props.page),
  }));
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const action = useNotionAction();
  const locked = action.pending || action.awaitingConfirmation;
  useNotionDraft(Object.keys(edits).length > 0 || action.pending);
  const properties: MappedNotionProperty[] = notionProperties(snapshot.source)
    .filter((property) => !props.propertyId || property.id === props.propertyId)
    .map((descriptor) => {
      const original =
        Object.values(notionObject(snapshot.page.properties))
          .map(notionObject)
          .find((value) => value.id === descriptor.id) ?? {};
      const text = ["title", "rich_text"].includes(descriptor.type);
      return {
        ...descriptor,
        original,
        fields: [],
        readOnlyReason: text
          ? Array.isArray(original[descriptor.type]) && original.has_more !== true
            ? null
            : "This rich-text property is incomplete."
          : notionPropertyReadOnlyReason(original, descriptor),
      };
    });
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          const changes: Record<string, unknown> = {};
          for (const [id, draft] of Object.entries(edits)) {
            const property = properties.find((value) => value.id === id);
            if (!property || property.readOnlyReason)
              throw new Error(property?.readOnlyReason || "The selected property is read-only.");
            let value: unknown;
            if (["title", "rich_text"].includes(property.type)) {
              if (!Array.isArray(draft)) throw new Error("Invalid rich text.");
              validateNotionRichTextDraft(notionArray(property.original[property.type]), draft);
              value = draft;
            } else value = writablePropertyValue(property, draft);
            if (
              notionCanonical(
                notionComparableValue(property.original[property.type], property.type),
              ) !== notionCanonical(notionComparableValue(value, property.type))
            )
              changes[id] = { [property.type]: value };
          }
          if (Object.keys(changes).length)
            await action.write({
              connectionId: props.connectionId,
              kind: "updatePage",
              id: notionString(snapshot.page.id),
              base: notionPropertySnapshot(snapshot.page.properties, Object.keys(changes)),
              changes,
            });
          props.onSaved();
          props.onClose();
        });
      }}
    >
      <p className="text-ui-sm text-muted-foreground">
        Only changed properties are sent. Original values remain the conflict baseline while this
        editor is open.
      </p>
      {properties.map((property) => (
        <fieldset
          disabled={locked}
          key={property.id}
          className="space-y-2 rounded-lg border border-border p-3"
        >
          <legend className="px-1 text-ui font-medium">{property.label}</legend>
          {["title", "rich_text"].includes(property.type) && !property.readOnlyReason ? (
            <NotionRichTextEditor
              runs={notionArray(
                Object.hasOwn(edits, property.id)
                  ? edits[property.id]
                  : property.original[property.type],
              )}
              onChange={(value) => setEdits((current) => ({ ...current, [property.id]: value }))}
              disabled={locked}
            />
          ) : (
            <PropertyControl
              connectionId={props.connectionId}
              property={property}
              value={
                Object.hasOwn(edits, property.id)
                  ? edits[property.id]
                  : property.original[property.type]
              }
              disabled={locked}
              onChange={(value) => setEdits((current) => ({ ...current, [property.id]: value }))}
            />
          )}
        </fieldset>
      ))}
      <NotionError message={action.error} />
      <NotionReceiptNotice active={action.awaitingConfirmation} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={action.pending} onClick={props.onClose}>
          Cancel edits
        </Button>
        <Button type="submit" disabled={action.pending || !Object.keys(edits).length}>
          {action.awaitingConfirmation ? "Check original request" : "Save properties"}
        </Button>
      </div>
    </form>
  );
}
function PropertyDialog(props: Props) {
  const guard = useNotionDraftGuard();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && guard?.mayLeave() !== false) props.onClose();
      }}
    >
      <DialogPopup className="w-[min(42rem,94vw)] sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{notionTitle(props.page)}</DialogTitle>
          <DialogDescription>Notion record properties</DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[75vh] space-y-3 overflow-auto">
          <NotionError message={guard?.error} />
          <PropertyForm {...props} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
export function NotionRecordPropertyEditor(props: Props) {
  return (
    <NotionDraftBoundary>
      <PropertyDialog {...props} />
    </NotionDraftBoundary>
  );
}
export function NotionPageProperties({
  connectionId,
  page,
  onSaved,
}: {
  connectionId: string;
  page: NotionObject;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const sourceId = notionString(notionObject(page.parent).data_source_id);
  const schema = useQuery({
    queryKey: ["notion", "page-schema", connectionId, sourceId],
    queryFn: async () =>
      (await notionApi().read({ connectionId, kind: "dataSource", id: sourceId })).data,
    enabled: Boolean(sourceId),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const source = sourceId ? schema.data : page;
  return (
    <details className="rounded-lg border border-border p-3">
      <summary className="text-ui font-medium">Page properties</summary>
      <NotionError message={schema.error?.message} />
      <dl className="mt-3 grid gap-2 text-ui">
        {Object.entries(notionObject(page.properties)).map(([name, raw]) => {
          const property = notionObject(raw);
          return (
            <div
              className="grid grid-cols-2 items-center gap-3"
              key={notionString(property.id) || name}
            >
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="min-w-0 break-words">
                <Button
                  variant="ghost"
                  className="max-w-full justify-start truncate"
                  disabled={!source}
                  onClick={() => setSelected(notionString(property.id))}
                >
                  {notionPropertyLabel(property) || "—"}
                </Button>
              </dd>
            </div>
          );
        })}
      </dl>
      {selected && source ? (
        <NotionRecordPropertyEditor
          key={selected}
          connectionId={connectionId}
          source={source}
          page={page}
          propertyId={selected}
          onClose={() => setSelected(null)}
          onSaved={onSaved}
        />
      ) : null}
    </details>
  );
}
