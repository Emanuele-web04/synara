import type {
  NotionField,
  NotionFieldMap,
  NotionMapping,
  NotionObject,
  ProjectId,
} from "@synara/contracts";
import { NOTION_FIELD_TYPES, suggestNotionFields } from "@synara/shared/notion";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { editNotionMapping, notionOptions, notionProperties } from "./notionProperties";
import { NotionError, NotionSelect, notionApi, useNotionAction } from "./notionUi";

const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

export function NotionMappingForm({
  connectionId,
  source,
  existing,
  onSaved,
  onCancel,
}: {
  connectionId: string;
  source: NotionObject;
  existing?: NotionMapping | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [mappingId] = useState(() => existing?.id ?? crypto.randomUUID());
  const [fields, setFields] = useState<NotionFieldMap | null>(
    existing?.fields ?? suggestNotionFields(source),
  );
  const [name, setName] = useState(existing?.name ?? "Notion tasks");
  const [projectId, setProjectId] = useState<string>(existing?.projectId ?? "");
  const [done, setDone] = useState<readonly string[]>(existing?.completedStatusIds ?? []);
  const [reopen, setReopen] = useState(existing?.reopenedStatusId ?? "");
  const [priorities, setPriorities] = useState<NotionMapping["priorityOptions"]>(
    existing?.priorityOptions ?? {},
  );
  const [agentAccess, setAgentAccess] = useState<"none" | "read" | "write">(
    existing?.agentAccess ?? "none",
  );
  const [sprintPlan, setSprintPlan] = useState<NotionMapping["sprintPlan"]>(
    existing?.sprintPlan ?? null,
  );
  const action = useNotionAction();
  const properties = notionProperties(source);
  const statusOptions = notionOptions(
    properties.find((property) => property.id === fields?.status?.id),
  );
  const priorityOptions = notionOptions(
    properties.find((property) => property.id === fields?.priority?.id),
  );
  const sprintRelation = properties.find(
    (property) => property.id === fields?.sprint?.id && property.type === "relation",
  );
  const sprintSourceId =
    typeof sprintRelation?.schema.relation === "object"
      ? String(
          (sprintRelation.schema.relation as { data_source_id?: unknown }).data_source_id ?? "",
        )
      : "";
  const sprintQuery = useQuery({
    queryKey: ["notion", "sprint-schema", connectionId, sprintSourceId],
    queryFn: async () =>
      (await notionApi().read({ connectionId, kind: "dataSource", id: sprintSourceId })).data,
    enabled: Boolean(sprintSourceId && fields?.sprint?.type === "relation"),
    retry: false,
  });
  const sprintProperties = notionProperties(sprintQuery.data ?? {});
  const sprintStatus = sprintProperties.find((property) => property.id === sprintPlan?.status?.id);
  const sprintOptions = notionOptions(sprintStatus);
  const setPlanField = (field: "start" | "end" | "status", id: string) =>
    setSprintPlan((current) => {
      if (!current) return current;
      const property = sprintProperties.find((value) => value.id === id);
      return {
        ...current,
        [field]: property ? { id: property.id, type: property.type } : null,
        ...(field === "status" ? { completedStatusIds: [] } : {}),
      };
    });

  if (!fields)
    return (
      <NotionError message="This data source has no title property and cannot be mapped to Tasks." />
    );

  return (
    <form
      className="space-y-4 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          const mapping = editNotionMapping(existing, source, {
            id: mappingId,
            connectionId,
            name,
            fields,
            projectId: projectId.trim() ? (projectId.trim() as ProjectId) : null,
            completedStatusIds: done,
            reopenedStatusId: reopen || null,
            priorityOptions: priorities,
            agentAccess,
            sprintPlan,
          });
          await notionApi().saveMapping(mapping);
          await notionApi().sync();
          onSaved();
        });
      }}
    >
      <h3 className="font-medium text-foreground">Map to Synara Tasks</h3>
      <p className="text-ui text-muted-foreground">
        Choose properties by type. Renaming a property in Notion will not break this mapping. Agent
        execution and Notion status remain separate.
      </p>
      <fieldset className="space-y-4" disabled={action.pending}>
        <label className="grid gap-1 text-ui">
          Source label
          <Input
            value={name}
            maxLength={200}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(NOTION_FIELD_TYPES) as NotionField[]).map((field) => (
            <div className="grid gap-1 text-ui" key={field}>
              <span className="capitalize">{field}</span>
              <NotionSelect
                label={`${field} property`}
                value={fields[field]?.id ?? ""}
                options={[
                  ...(field === "title" ? [] : [{ value: "", label: "Not mapped" }]),
                  ...properties
                    .filter((property) => NOTION_FIELD_TYPES[field].includes(property.type))
                    .map((property) => ({ value: property.id, label: property.label })),
                ]}
                disabled={action.pending}
                onChange={(selected) => {
                  const property = properties.find((value) => value.id === selected);
                  setFields((current) => {
                    if (!current) return current;
                    const copy = { ...current };
                    if (property) copy[field] = { id: property.id, type: property.type };
                    else if (field !== "title") delete copy[field];
                    return copy;
                  });
                  if (field === "status") {
                    setDone([]);
                    setReopen("");
                  }
                  if (field === "sprint") setSprintPlan(null);
                  if (field === "priority") setPriorities({});
                }}
              />
            </div>
          ))}
        </div>
        {statusOptions.length ? (
          <fieldset className="space-y-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-ui font-medium">Completed statuses</legend>
            <p className="text-ui-sm text-muted-foreground">
              Select every status that means completed. Multiple completion statuses remain distinct
              in Notion.
            </p>
            <div className="flex flex-wrap gap-3">
              {statusOptions.map((option) => (
                <label className="flex items-center gap-2 text-ui" key={option.value}>
                  <Checkbox
                    checked={done.includes(option.value)}
                    disabled={action.pending}
                    onCheckedChange={(checked) => {
                      setDone((current) =>
                        checked
                          ? [...new Set([...current, option.value])]
                          : current.filter((id) => id !== option.value),
                      );
                      if (checked && reopen === option.value) setReopen("");
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <NotionSelect
              label="Reopened status"
              value={reopen}
              disabled={action.pending}
              options={[
                { value: "", label: "No reopening mapping" },
                ...statusOptions.filter((option) => !done.includes(option.value)),
              ]}
              onChange={setReopen}
            />
          </fieldset>
        ) : null}
        {priorityOptions.length ? (
          <fieldset className="space-y-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-ui font-medium">Priority mapping</legend>
            <p className="text-ui-sm text-muted-foreground">
              Choose one existing Notion option for each Synara priority. No remote options are
              created.
            </p>
            {PRIORITIES.map((priority) => (
              <div className="grid gap-1 text-ui" key={priority}>
                <span className="capitalize">{priority}</span>
                <NotionSelect
                  label={`${priority} priority option`}
                  value={
                    Object.entries(priorities).find(([, value]) => value === priority)?.[0] ?? ""
                  }
                  disabled={action.pending}
                  options={[
                    { value: "", label: "Not mapped" },
                    ...priorityOptions.filter(
                      (option) =>
                        priorities[option.value] === undefined ||
                        priorities[option.value] === priority,
                    ),
                  ]}
                  onChange={(selected) =>
                    setPriorities((current) => {
                      const next = Object.fromEntries(
                        Object.entries(current).filter(([, value]) => value !== priority),
                      );
                      if (selected) next[selected] = priority;
                      return next;
                    })
                  }
                />
              </div>
            ))}
          </fieldset>
        ) : null}
        {sprintRelation && sprintSourceId ? (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <h4 className="text-ui font-medium">Sprint planning</h4>
            <p className="text-ui-sm text-muted-foreground">
              Configure fields from the related Notion Sprint database. The backlog and sprint
              summaries stay in Synara's existing Tasks experience.
            </p>
            <NotionError message={sprintQuery.error?.message} />
            {sprintQuery.data ? (
              <NotionSelect
                label="Sprint planning"
                value={sprintPlan ? "on" : "off"}
                onChange={(value) => {
                  if (value === "off") {
                    setSprintPlan(null);
                    return;
                  }
                  const title = sprintProperties.find((property) => property.type === "title");
                  if (!title) return;
                  setSprintPlan({
                    dataSourceId: sprintSourceId as NotionMapping["dataSourceId"],
                    title: { id: title.id, type: "title" },
                    start: null,
                    end: null,
                    status: null,
                    completedStatusIds: [],
                  });
                }}
                options={[
                  { value: "off", label: "Not configured" },
                  { value: "on", label: "Use related sprint properties" },
                ]}
                disabled={action.pending}
              />
            ) : (
              <p className="text-ui-sm text-muted-foreground">
                Share the related Sprint data source with Synara to configure planning.
              </p>
            )}
            {sprintPlan ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {(["start", "end", "status"] as const).map((field) => (
                  <label key={field} className="grid gap-1 text-ui-sm">
                    <span className="capitalize">{field} property</span>
                    <NotionSelect
                      label={"Sprint " + field}
                      value={sprintPlan[field]?.id ?? ""}
                      onChange={(value) => setPlanField(field, value)}
                      options={[
                        { value: "", label: "Not mapped" },
                        ...sprintProperties
                          .filter((property) =>
                            field === "status"
                              ? ["status", "select"].includes(property.type)
                              : property.type === "date",
                          )
                          .map((property) => ({ value: property.id, label: property.label })),
                      ]}
                      disabled={action.pending}
                    />
                  </label>
                ))}
                {sprintOptions.length ? (
                  <fieldset className="space-y-2 sm:col-span-2">
                    <legend className="text-ui-sm font-medium">Completed sprint statuses</legend>
                    <div className="flex flex-wrap gap-3">
                      {sprintOptions.map((option) => (
                        <label key={option.value} className="flex items-center gap-2 text-ui-sm">
                          <Checkbox
                            checked={sprintPlan.completedStatusIds.includes(option.value)}
                            onCheckedChange={(checked) =>
                              setSprintPlan((current) =>
                                current
                                  ? {
                                      ...current,
                                      completedStatusIds: checked
                                        ? [
                                            ...new Set([
                                              ...current.completedStatusIds,
                                              option.value,
                                            ]),
                                          ]
                                        : current.completedStatusIds.filter(
                                            (id) => id !== option.value,
                                          ),
                                    }
                                  : null,
                              )
                            }
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : fields?.sprint ? (
          <p className="text-ui-sm text-muted-foreground">
            Sprint planning needs a Notion relation with a shared target data source. Other sprint
            fields remain editable on tasks.
          </p>
        ) : null}
        <label className="grid gap-1 text-ui">
          Synara project ID for delegation (optional)
          <Input
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="Keep tasks unassigned"
          />
        </label>
      </fieldset>
      <div className="space-y-2 rounded-lg border border-border p-3">
        <h4 className="text-ui font-medium">Agent permissions</h4>
        <p className="text-ui-sm text-muted-foreground">
          Allow Synara agents to search and summarize this mapped data source without exposing
          credentials. Other Notion pages remain inaccessible. Every agent write requires a separate
          Synara approval card; session-wide approval is unavailable.
        </p>
        <NotionSelect
          label="Agent access to this source"
          value={agentAccess}
          onChange={(value) => setAgentAccess(value as "none" | "read" | "write")}
          options={[
            { value: "none", label: "No agent access" },
            { value: "read", label: "Read mapped records" },
            { value: "write", label: "Read and propose approved changes" },
          ]}
          disabled={action.pending}
        />
      </div>
      {existing?.enabled === false ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          This source is paused. Saving these settings does not resume synchronization.
        </p>
      ) : null}
      <p className="text-ui-sm text-muted-foreground">
        Agents use only explicitly permitted mappings and the configured Synara project. Approved
        writes use the existing durable change journal. Individual task handoffs never grant
        workspace-wide permissions.
      </p>
      <NotionError message={action.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={action.pending || !name.trim()}>
          {action.pending ? "Saving mapping…" : existing ? "Save mapping" : "Use in Tasks"}
        </Button>
      </div>
    </form>
  );
}
