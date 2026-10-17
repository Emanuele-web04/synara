import type { NotionConnectResult, NotionMapping, NotionObject } from "@synara/contracts";
import { notionArray, notionObject, notionString, notionTitle } from "@synara/shared/notion";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NotionMappingForm } from "../notion/NotionMappingForm";
import { NotionBrowser } from "../notion/NotionBrowser";
import { NotionError, NotionSelect, notionApi, useNotionAction } from "../notion/notionUi";

export function NotionSettingsPanel({ active }: { active: boolean }) {
  return active ? <NotionSettingsContent /> : null;
}
function NotionSettingsContent() {
  const query = useQuery({
    queryKey: ["notion", "state"],
    queryFn: () => notionApi().state(),
    refetchInterval: 15_000,
    retry: false,
    gcTime: 0,
  });
  const state = query.data;
  const action = useNotionAction();
  const [transaction, setTransaction] = useState<NotionConnectResult | null>(null);
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [sources, setSources] = useState<NotionObject[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [source, setSource] = useState<NotionObject | null>(null);
  const [mapping, setMapping] = useState<NotionMapping | undefined>();
  const [browse, setBrowse] = useState<string | null>(null);
  const connectionId =
    selected || state?.connections.find((value) => value.status === "connected")?.id || "";
  const connected =
    state?.connections.some((value) => value.id === connectionId && value.status === "connected") ??
    false;
  useEffect(() => {
    if (!transaction) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (Date.parse(transaction.expiresAt) <= Date.now()) {
        setTransaction(null);
        return;
      }
      void notionApi()
        .complete({ transactionId: transaction.transactionId })
        .then((result) => {
          if (!cancelled && result.connection) {
            setSelected(result.connection.id);
            setTransaction(null);
            void query.refetch();
          }
        })
        .catch(() => {
          /* The explicit Finish button exposes errors and permits retry without replaying the OAuth code. */
        });
    }, 3_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [transaction, query.refetch]);
  useEffect(() => {
    if (!connected) {
      setSources([]);
      setSource(null);
      setBrowse(null);
    }
  }, [connected]);
  const findSources = async (next?: string) => {
    const { data } = await notionApi().read({
      connectionId,
      kind: "search",
      query: search,
      filter: { value: "data_source", property: "object" },
      ...(next ? { cursor: next } : {}),
    });
    const results = notionArray(data.results).map(notionObject);
    setSources((previous) => (next ? [...previous, ...results] : results));
    setCursor(data.has_more === true ? notionString(data.next_cursor) || null : null);
  };
  return (
    <section id="notion-integration" className="space-y-5 p-3" aria-labelledby="notion-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="notion-heading" className="text-ui-lg font-medium">
            Notion
          </h2>
          <p className="mt-1 max-w-xl text-ui text-muted-foreground">
            Bring authorized tasks and documentation into Synara. Notion remains the source of
            truth. Your agents receive no OAuth credentials.
          </p>
        </div>
        <Button
          disabled={!state?.configured || action.pending || transaction !== null}
          onClick={() =>
            void action.run(async () => {
              const result = await notionApi().connect();
              setTransaction(result);
              await ensureNativeApi().shell.openExternal(result.authorizationUrl);
            })
          }
        >
          Connect Notion
        </Button>
      </div>
      <NotionError message={query.error?.message ?? state?.syncError ?? action.error} />
      {query.isPending ? (
        <p className="text-ui text-muted-foreground" role="status">
          Loading integration…
        </p>
      ) : !state?.configured ? (
        <p className="rounded-lg border border-border p-3 text-ui text-muted-foreground">
          An administrator must deploy the confidential OAuth backend and configure
          SYNARA_NOTION_BROKER_URL on the Synara server. The client secret must never be placed in
          Electron or renderer settings.
        </p>
      ) : null}
      {transaction ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted p-3 text-ui">
          <span>Authorize shared pages in your system browser, then return here.</span>
          <Button
            variant="outline"
            disabled={action.pending}
            onClick={() =>
              void action.run(async () => {
                const result = await notionApi().complete({
                  transactionId: transaction.transactionId,
                });
                if (result.pending) throw new Error("Notion authorization is not finished yet.");
                setTransaction(null);
                await query.refetch();
              })
            }
          >
            Finish connection
          </Button>
        </div>
      ) : null}
      <div className="space-y-2">
        {state?.connections.map((connection) => (
          <div
            key={connection.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3"
          >
            <div>
              <p className="text-ui font-medium">
                {connection.workspaceName || "Notion workspace"}
              </p>
              <p className="text-ui-sm text-muted-foreground">
                {connection.status === "connected"
                  ? "Connected · Only pages shared with Synara"
                  : connection.status === "disconnect-pending"
                    ? "Disconnected locally · Remote revocation still pending"
                    : "Authorization required"}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={connection.status !== "connected"}
                onClick={() => setBrowse(connection.id)}
              >
                Browse
              </Button>
              <Button
                variant="outline"
                disabled={action.pending}
                onClick={() =>
                  void action.run(async () => {
                    if (
                      !window.confirm(
                        "Disconnect this workspace, remove its cached data and revoke Synara's Notion access?",
                      )
                    )
                      return;
                    await notionApi().disconnect({ connectionId: connection.id });
                    await query.refetch();
                  })
                }
              >
                Disconnect
              </Button>
            </div>
          </div>
        ))}
      </div>
      {connected ? (
        <div className="space-y-3">
          <h3 className="font-medium text-ui">Task sources</h3>
          <div className="flex flex-wrap gap-2">
            <NotionSelect
              label="Notion workspace"
              value={connectionId}
              options={(state?.connections ?? [])
                .filter((value) => value.status === "connected")
                .map((value) => ({
                  value: value.id,
                  label: value.workspaceName || "Notion workspace",
                }))}
              onChange={(value) => {
                setSelected(value);
                setSources([]);
                setSource(null);
              }}
            />
            <Input
              aria-label="Find task databases"
              placeholder="Find a database by title"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={action.pending}
              onClick={() => void action.run(() => findSources())}
            >
              Find sources
            </Button>
            <Button
              variant="outline"
              disabled={action.pending || state?.syncing}
              onClick={() =>
                void action.run(async () => {
                  await notionApi().sync();
                  await query.refetch();
                })
              }
            >
              Sync now
            </Button>
          </div>
          {sources.map((item) => (
            <Button
              key={notionString(item.id)}
              variant="ghost"
              className="justify-start"
              onClick={() => {
                setSource(item);
                setMapping(
                  state?.mappings.find(
                    (value) =>
                      value.connectionId === connectionId && value.dataSourceId === item.id,
                  ),
                );
              }}
            >
              {notionTitle(item)}
            </Button>
          ))}
          {cursor ? (
            <Button
              variant="outline"
              disabled={action.pending}
              onClick={() => void action.run(() => findSources(cursor))}
            >
              More sources
            </Button>
          ) : null}
          {source ? (
            <NotionMappingForm
              key={`${connectionId}:${notionString(source.id)}`}
              connectionId={connectionId}
              source={source}
              existing={mapping}
              onCancel={() => setSource(null)}
              onSaved={() => {
                setSource(null);
                void query.refetch();
              }}
            />
          ) : null}
          {(state?.mappings ?? [])
            .filter((value) => value.connectionId === connectionId)
            .map((value) => (
              <div className="flex items-center justify-between gap-3 text-ui" key={value.id}>
                <span>
                  {value.name} · {value.enabled ? "Synced to Tasks" : "Paused"}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void action.run(async () => {
                        const result = await notionApi().read({
                          connectionId,
                          kind: "dataSource",
                          id: value.dataSourceId,
                        });
                        setSource(result.data);
                        setMapping(value);
                      })
                    }
                  >
                    Edit mapping
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void action.run(async () => {
                        if (
                          !window.confirm(
                            "Remove this task mapping and its local cache? Notion records will not be deleted.",
                          )
                        )
                          return;
                        await notionApi().deleteMapping({ mappingId: value.id });
                        await query.refetch();
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          <p className="text-ui-sm text-muted-foreground">
            {state?.lastSyncedAt
              ? `Last sync attempt: ${new Date(state.lastSyncedAt).toLocaleString()}`
              : "No synchronization yet."}{" "}
            Polling runs while Synara is open.
          </p>
        </div>
      ) : null}
      {state?.changes.length ? (
        <div className="space-y-3">
          <h3 className="text-ui font-medium">Changes requiring review</h3>
          {state.changes.map((change) => (
            <details key={change.id} className="rounded-lg border border-border p-3 text-ui">
              <summary>
                {change.kind} · {change.state}
              </summary>
              <p className="my-2 text-muted-foreground">{change.message}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <h4>Local proposal</h4>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-ui-xs">
                    {JSON.stringify(change.changes, null, 2)}
                  </pre>
                </div>
                <div>
                  <h4>Latest remote values</h4>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-ui-xs">
                    {JSON.stringify(change.remote ?? {}, null, 2)}
                  </pre>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  disabled={action.pending}
                  onClick={() =>
                    void action.run(async () => {
                      await notionApi().resolve({ changeId: change.id, resolution: "remote" });
                      await notionApi().sync();
                      await query.refetch();
                    })
                  }
                >
                  Discard local proposal
                </Button>
                {["updatePage", "updateBlock", "archivePage"].includes(change.kind) ? (
                  <Button
                    variant="outline"
                    disabled={action.pending}
                    onClick={() =>
                      void action.run(async () => {
                        await notionApi().resolve({ changeId: change.id, resolution: "retry" });
                        await query.refetch();
                      })
                    }
                  >
                    Review and retry
                  </Button>
                ) : (
                  <span className="text-ui-sm text-muted-foreground">
                    Inspect Notion before creating a new intentional action. This request will not
                    be replayed.
                  </span>
                )}
              </div>
            </details>
          ))}
        </div>
      ) : null}
      {browse ? <NotionBrowser connectionId={browse} onClose={() => setBrowse(null)} /> : null}
    </section>
  );
}
