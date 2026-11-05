// FILE: SynbotMergeProofCard.tsx
// Purpose: HoloBot's signature card: "Merge it?" with the proof (checks green on the current
//          head, branch up to date, no conflicts) and the diff's red flags, always shown. Merge is
//          enabled only when the server says the proof is ready; Update branch when behind.
//          Shown only when Settings → SynBot → Merge proof is on.
// Layer: SynBot UI

import type { BotMergeProof, ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useState } from "react";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { StatusChip } from "../ui/status-chip";
import { toastManager } from "../ui/toast";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly proof: BotMergeProof }
  | { readonly kind: "none"; readonly message: string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function SynbotMergeProofCard({ threadId }: { readonly threadId: ThreadId }) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState<"merge" | "update" | "refresh" | null>(null);

  const load = useCallback(() => {
    const api = readNativeApi();
    if (!api) return;
    setBusy((current) => current ?? "refresh");
    void api.bots
      .mergeProof({ threadId })
      .then((proof) => setState({ kind: "ready", proof }))
      .catch((error: unknown) => setState({ kind: "none", message: messageOf(error) }))
      .finally(() => setBusy(null));
  }, [threadId]);

  useEffect(() => {
    setState({ kind: "loading" });
    load();
  }, [load]);

  if (state.kind === "loading") return null;
  if (state.kind === "none") {
    return (
      <div className="rounded-xl border border-border/60 px-3 py-2 text-ui-sm text-muted-foreground">
        {state.message}
      </div>
    );
  }
  const { proof } = state;
  const checksTone =
    proof.checks === "passing"
      ? "text-emerald-600 dark:text-emerald-400"
      : proof.checks === "pending"
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";

  const merge = () => {
    const api = readNativeApi();
    if (!api) return;
    setBusy("merge");
    void api.bots
      .merge({ threadId, headSha: proof.headSha })
      .then((result) => {
        setState({ kind: "ready", proof: result.proof });
        toastManager.add({
          type: result.outcome === "refused" ? "warning" : "success",
          title:
            result.outcome === "merged"
              ? t("synbot:proof_merged")
              : result.outcome === "enqueued"
                ? t("synbot:proof_enqueued")
                : (result.message ?? t("synbot:proof_refused")),
        });
      })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: t("synbot:proof_mergeFailed"),
          description: messageOf(error),
        }),
      )
      .finally(() => setBusy(null));
  };

  const updateBranch = () => {
    const api = readNativeApi();
    if (!api) return;
    setBusy("update");
    void api.bots
      .updateBranch({ threadId })
      .then((next) => setState({ kind: "ready", proof: next }))
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: t("synbot:proof_updateFailed"),
          description: messageOf(error),
        }),
      )
      .finally(() => setBusy(null));
  };

  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-ui-lg font-medium text-foreground">
          {proof.state === "merged" ? t("synbot:proof_titleMerged") : t("synbot:proof_title")}
        </span>
        <a
          className="ml-auto truncate text-ui-sm text-muted-foreground hover:text-foreground"
          href={proof.prUrl}
          target="_blank"
          rel="noreferrer"
        >
          #{proof.prNumber}
        </a>
      </div>
      <ul className="flex flex-col gap-1 text-ui-sm">
        <li>
          <StatusChip dotClassName="bg-current" className={checksTone}>
            {t(`synbot:proof_checks_${proof.checks}`)}
            {proof.failingChecks.length > 0 ? ` · ${proof.failingChecks.join(", ")}` : ""}
          </StatusChip>
        </li>
        <li>
          <StatusChip
            className={cn(
              proof.behind
                ? "text-amber-600 dark:text-amber-400"
                : "text-emerald-600 dark:text-emerald-400",
            )}
          >
            {proof.behind
              ? t("synbot:proof_behind", { base: proof.baseBranch })
              : t("synbot:proof_current", { base: proof.baseBranch })}
          </StatusChip>
        </li>
        {proof.conflicts ? (
          <li>
            <StatusChip className="text-red-600 dark:text-red-400">
              {t("synbot:proof_conflicts")}
            </StatusChip>
          </li>
        ) : null}
        <li className="text-muted-foreground">
          {t("synbot:proof_diff", {
            files: proof.changedFiles,
            additions: proof.additions,
            deletions: proof.deletions,
          })}
        </li>
      </ul>
      {proof.redFlags.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg bg-red-500/8 px-2.5 py-2 text-ui-sm">
          <span className="font-medium text-red-700 dark:text-red-300">
            {t("synbot:proof_redFlags")}
          </span>
          {proof.redFlags.map((flag) => (
            <span key={`${flag.kind}:${flag.file}:${flag.detail}`} className="text-foreground/80">
              {t(`synbot:proof_flag_${flag.kind}`)} · {flag.file}
              {flag.detail ? ` — ${flag.detail}` : ""}
            </span>
          ))}
        </div>
      ) : null}
      {proof.state === "open" ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Button size="sm" disabled={!proof.ready || busy !== null} onClick={merge}>
            {t("synbot:proof_merge")}
          </Button>
          {proof.behind ? (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={updateBranch}>
              {t("synbot:proof_updateBranch")}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={load}>
            {t("synbot:proof_refresh")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
