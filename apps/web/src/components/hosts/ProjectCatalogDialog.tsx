import { useTranslation } from "~/i18n";
import { useQuery } from "@tanstack/react-query";
import { accountStatusQueryOptions } from "~/lib/accountReactQuery";
import { useEffect, useState } from "react";
import { useStore } from "~/store";
import { ensureNativeApi } from "~/nativeApi";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { addWsTransportStateListener, type WsTransportState } from "~/wsTransportEvents";
import {
  catalogSuggestions,
  checkoutKey,
  emptyCatalog,
  excludeSuggestion,
  linkCheckouts,
  observeCheckouts,
  splitGroup,
  unlinkCheckout,
  type CatalogCheckout,
  type ProjectCatalog,
} from "~/lib/projectCatalog/model";
import {
  projectCatalogKey,
  readProjectCatalog,
  saveProjectCatalog,
} from "~/lib/projectCatalog/storage";
import { openCatalogCheckout } from "~/lib/projectCatalog/navigation";
import { PROJECT_COLORS, projectColorValue } from "~/lib/projectAppearance";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

// Keep persisted color values separate from their translated option labels.
const CATALOG_COLOR_LABEL_KEYS = {
  red: "computer:remote_host_color_red",
  orange: "computer:remote_host_color_orange",
  yellow: "computer:remote_host_color_yellow",
  green: "computer:remote_host_color_green",
  blue: "computer:remote_host_color_blue",
  purple: "computer:remote_host_color_purple",
  pink: "computer:remote_host_color_pink",
} as const;

export function ProjectCatalogDialog({ onClose }: { onClose: () => void }) {
  const { t, formatLocale } = useTranslation();
  useQuery(accountStatusQueryOptions());
  const context = readExecutionContext();
  const projects = useStore((store) => store.projects);
  const hydrated = useStore((store) => store.threadsHydrated);
  const [key] = useState(projectCatalogKey);
  const [catalog, setCatalog] = useState<ProjectCatalog>(emptyCatalog);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<WsTransportState>("connecting");
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => addWsTransportStateListener(setState, { replayCurrent: true }), []);
  useEffect(() => {
    if (!key) return;
    try {
      setCatalog(readProjectCatalog(key));
      setReady(true);
    } catch (cause) {
      setError(String(cause));
    }
  }, [key]);
  const currentKey = projectCatalogKey();
  useEffect(() => {
    if (key !== currentKey) onClose();
  }, [key, currentKey, onClose]);
  const editable = ready && state === "open" && !busy && key === projectCatalogKey();
  useEffect(() => {
    if (!key || !context || !ready || !hydrated || state !== "open") return;
    try {
      const next = observeCheckouts(
        readProjectCatalog(key),
        context.execution.environmentId,
        projects.map((project) => ({
          environmentId: context.execution.environmentId,
          projectId: project.id,
          name: project.localName ?? project.name,
          cwd: project.cwd,
          hostName: context.remote ? context.execution.label : "This computer",
          channel: context.remote?.channel ?? context.controller.channel ?? "local",
          ...(context.remoteHostId ? { hostId: context.remoteHostId } : {}),
          observedAt: new Date().toISOString(),
          repositoryUrls: [],
        })),
      );
      saveProjectCatalog(key, next);
      setCatalog(next);
    } catch (cause) {
      setError(String(cause));
    }
  }, [key, context, ready, hydrated, projects, state]);
  const save = (next: ProjectCatalog) => {
    if (!editable || !key) return;
    try {
      saveProjectCatalog(key, next);
      setCatalog(next);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  };
  const scan = async () => {
    if (!editable || !context || !key) return;
    setBusy(true);
    setError(null);
    try {
      // Only the selected execution host is queried, serially. No transcript subscriptions.
      const updated = new Map<string, string[]>();
      for (const checkout of catalog.checkouts.filter(
        (item) => !item.missing && item.environmentId === context.execution.environmentId,
      )) {
        const result = await ensureNativeApi().git.githubRepository({ cwd: checkout.cwd });
        updated.set(
          checkoutKey(checkout),
          result.repositories.map((repository) => repository.url),
        );
      }
      const latest = readProjectCatalog(key);
      const next = {
        ...latest,
        checkouts: latest.checkouts.map((item) => ({
          ...item,
          repositoryUrls: updated.get(checkoutKey(item)) ?? item.repositoryUrls,
        })),
      };
      saveProjectCatalog(key, next);
      setCatalog(next);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const open = async (checkout: CatalogCheckout) => {
    if (!editable) return;
    setBusy(true);
    try {
      await openCatalogCheckout(checkout);
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const row = (checkout: CatalogCheckout) => (
    <div className="flex items-center gap-3 py-2" key={checkoutKey(checkout)}>
      <input
        type="checkbox"
        aria-label={t("computer:remote_host_select_checkout", {
          project: checkout.name,
          host: checkout.hostName,
        })}
        checked={selected.includes(checkoutKey(checkout))}
        disabled={!editable}
        onChange={(event) =>
          setSelected((current) =>
            event.target.checked
              ? [...current, checkoutKey(checkout)]
              : current.filter((key) => key !== checkoutKey(checkout)),
          )
        }
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui">
          {checkout.name}{" "}
          <span className="text-muted-foreground">
            · {checkout.hostName} · {checkout.channel}
          </span>
        </p>
        <p className="truncate text-ui-xs text-muted-foreground" title={checkout.cwd}>
          {checkout.cwd}
        </p>
        <p className="text-ui-xs text-muted-foreground">
          {checkout.missing
            ? t("computer:remote_host_checkout_missing")
            : checkout.environmentId === context?.execution.environmentId
              ? t("computer:remote_host_selected_host")
              : t("computer:remote_host_saved_checkout", {
                  time: new Date(checkout.observedAt).toLocaleString(formatLocale),
                })}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={!editable || checkout.missing}
        onClick={() => void open(checkout)}
      >
        {checkout.environmentId === context?.execution.environmentId
          ? t("onboarding:notification_open")
          : t("computer:remote_host_switch_open")}
      </Button>
    </div>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("computer:remote_host_linked_projects")}</DialogTitle>
          <DialogDescription>{t("computer:remote_host_catalog_description")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          {state !== "open" ? (
            <p role="status" className="text-ui text-muted-foreground">
              {t("computer:remote_host_catalog_offline")}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          ) : null}
          {catalog.groups.map((group) => (
            <section key={group.id} className="rounded-xl border border-border p-3">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={t("computer:remote_host_group_name")}
                  value={group.name}
                  disabled={!editable}
                  onChange={(event) =>
                    save({
                      ...catalog,
                      groups: catalog.groups.map((item) =>
                        item.id === group.id ? { ...item, name: event.target.value } : item,
                      ),
                    })
                  }
                />
                <select
                  aria-label={t("computer:remote_host_color_for", { group: group.name })}
                  className="rounded-md border border-border bg-background px-2 py-1 text-ui"
                  disabled={!editable}
                  value={group.appearance?.kind === "icon" ? (group.appearance.color ?? "") : ""}
                  onChange={(event) =>
                    save({
                      ...catalog,
                      groups: catalog.groups.map((item) =>
                        item.id === group.id
                          ? {
                              ...item,
                              appearance: {
                                kind: "icon",
                                icon: "folder-2",
                                color:
                                  PROJECT_COLORS.find((color) => color === event.target.value) ??
                                  null,
                              },
                            }
                          : item,
                      ),
                    })
                  }
                >
                  <option value="">{t("settings:reasoningModes_default")}</option>
                  {PROJECT_COLORS.map((color) => (
                    <option key={color} value={color}>
                      {t(CATALOG_COLOR_LABEL_KEYS[color])}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!editable}
                  onClick={() => save(splitGroup(catalog, group.id))}
                >
                  {t("computer:remote_host_split_group")}
                </Button>
              </div>
              <div
                style={{
                  borderLeftColor:
                    group.appearance?.kind === "icon" && group.appearance.color
                      ? projectColorValue(group.appearance.color)
                      : "transparent",
                }}
                className="border-l-2 pl-2"
              >
                {group.members.map((ref) => {
                  const checkout = catalog.checkouts.find(
                    (item) => checkoutKey(item) === checkoutKey(ref),
                  );
                  return checkout ? (
                    <div key={checkoutKey(ref)}>
                      {row(checkout)}
                      <div className="flex gap-2 pb-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!editable}
                          onClick={() =>
                            save({
                              ...catalog,
                              groups: catalog.groups.map((item) =>
                                item.id === group.id ? { ...item, preferredCheckout: ref } : item,
                              ),
                            })
                          }
                        >
                          {group.preferredCheckout &&
                          checkoutKey(group.preferredCheckout) === checkoutKey(ref)
                            ? t("computer:remote_host_preferred_checkout")
                            : t("computer:remote_host_set_preferred")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!editable}
                          onClick={() => save(unlinkCheckout(catalog, group.id, ref))}
                        >
                          {t("common:unlink")}
                        </Button>
                      </div>
                    </div>
                  ) : null;
                })}
              </div>
            </section>
          ))}
          <section>
            <p className="text-ui font-medium">{t("computer:remote_host_checkouts")}</p>
            {catalog.checkouts
              .filter(
                (item) =>
                  !catalog.groups.some((group) =>
                    group.members.some((ref) => checkoutKey(ref) === checkoutKey(item)),
                  ),
              )
              .map(row)}
            {!catalog.checkouts.length ? (
              <p className="py-3 text-ui text-muted-foreground">
                {t("computer:remote_host_save_catalog")}
              </p>
            ) : null}
          </section>
          <div className="flex gap-2">
            <Input
              aria-label={t("computer:remote_host_new_group_name")}
              placeholder={t("computer:remote_host_group_name")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!editable}
            />
            <Button
              disabled={!editable || selected.length < 2 || !name.trim()}
              onClick={() => {
                save(
                  linkCheckouts(
                    catalog,
                    catalog.checkouts.filter((item) => selected.includes(checkoutKey(item))),
                    name,
                    crypto.randomUUID(),
                  ),
                );
                setSelected([]);
                setName("");
              }}
            >
              {t("computer:remote_host_link_selected")}
            </Button>
          </div>
          <section className="space-y-2">
            <Button variant="outline" disabled={!editable} onClick={() => void scan()}>
              {busy
                ? t("common:working")
                : t("computer:remote_host_find_matches", {
                    host: context?.execution.label ?? t("computer:remote_host_this_host"),
                  })}
            </Button>
            <p className="text-ui-xs text-muted-foreground">
              {t("computer:remote_host_suggestions_description")}
            </p>
            {catalogSuggestions(catalog).map(([a, b]) => (
              <div
                className="flex items-center gap-2 text-ui-sm"
                key={JSON.stringify([checkoutKey(a), checkoutKey(b)])}
              >
                <p className="flex-1">
                  {a.name} ({a.hostName}) ↔ {b.name} ({b.hostName})
                </p>
                <Button
                  size="sm"
                  disabled={!editable}
                  onClick={() => save(linkCheckouts(catalog, [a, b], a.name, crypto.randomUUID()))}
                >
                  {t("computer:remote_host_confirm_link")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!editable}
                  onClick={() => save(excludeSuggestion(catalog, a, b))}
                >
                  {t("automation:dismiss")}
                </Button>
              </div>
            ))}
          </section>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
