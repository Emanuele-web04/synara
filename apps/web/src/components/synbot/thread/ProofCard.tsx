// FILE: ProofCard.tsx
// Purpose: The merge proof, HoloBot's signature card (thread/ProofCard.tsx + ProofBadge.tsx):
//          "Merge it?" with the pull request and what changed (PR #12 · +12 −3 · 4 files), the
//          proof as a checklist (checks green on the current head, the branch up to date with
//          its base, no conflicts, the diff's red flags, never trusted away), then its answers as
//          small buttons: Merge (primary, only when the server says the proof is ready; the merge
//          is the user's), Update branch when behind, Refresh. Shown in a task's pane when
//          Settings → SynBot → Merge proof is on (bots.mergeProof / merge / updateBranch).
// Layer: SynBot thread UI
// Exports: ProofCard

import type { BotMergeProof, ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useState } from "react";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";

import { toastManager } from "../../ui/toast";
import { CapsuleButton, Chip } from "../kit/controls";
import { Icon } from "../kit/Icon";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly proof: BotMergeProof }
  | { readonly kind: "none"; readonly message: string };

type Check = { readonly tone: "good" | "bad" | "attention" | "muted"; readonly text: string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function useChecklist(proof: BotMergeProof): readonly Check[] {
  const { t } = useTranslation();
  const checks: Check[] = [
    {
      tone:
        proof.checks === "passing"
          ? "good"
          : proof.checks === "pending"
            ? "attention"
            : proof.checks === "failing"
              ? "bad"
              : "muted",
      text: `${t(`synbot:proof_checks_${proof.checks}`)}${
        proof.failingChecks.length > 0 ? ` · ${proof.failingChecks.join(", ")}` : ""
      }`,
    },
    {
      tone: proof.behind ? "attention" : "good",
      text: proof.behind
        ? t("synbot:proof_behind", { base: proof.baseBranch })
        : t("synbot:proof_current", { base: proof.baseBranch }),
    },
  ];
  if (proof.conflicts) checks.push({ tone: "bad", text: t("synbot:proof_conflicts") });
  for (const flag of proof.redFlags) {
    checks.push({
      tone: "bad",
      text: `${t(`synbot:proof_flag_${flag.kind}`)} · ${flag.file}${flag.detail ? ` · ${flag.detail}` : ""}`,
    });
  }
  return checks;
}

function Checklist({ proof }: { readonly proof: BotMergeProof }) {
  const { t } = useTranslation();
  const checks = useChecklist(proof);
  return (
    <ul className="checklist" aria-label={t("synbot:proofChecks")}>
      {checks.map((check) => (
        <li key={check.text} className={`checklist__item checklist__item--${check.tone}`}>
          <span className="checklist__mark" aria-hidden>
            {check.tone === "good" ? "✓" : check.tone === "bad" ? "✕" : "•"}
          </span>
          <span className="checklist__text">{check.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function ProofCard({ threadId }: { readonly threadId: ThreadId }) {
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
    return <p className="choice__note">{state.message}</p>;
  }
  const { proof } = state;
  const open = proof.state === "open";

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
    <div className={open ? "choice proof-card" : "choice proof-card choice--done"}>
      <div className="choice__head">
        <p className="choice__title">
          {proof.state === "merged" ? t("synbot:proof_titleMerged") : t("synbot:proof_title")}
        </p>
        <Chip tone={proof.ready ? "good" : proof.state === "merged" ? "muted" : "attention"} dot>
          {proof.ready
            ? t("synbot:proof_ready")
            : proof.state === "merged"
              ? t("synbot:proof_merged")
              : t("synbot:proof_notReady")}
        </Chip>
      </div>
      <p className="proof-card__meta">
        <a href={proof.prUrl} target="_blank" rel="noreferrer">
          {t("synbot:pullNumber", { number: proof.prNumber })}
        </a>
        {" · "}
        <span className="diffstat">
          <span className="diffstat__add">+{proof.additions}</span>{" "}
          <span className="diffstat__del">−{proof.deletions}</span>
          {" · "}
          {t("synbot:files", { count: proof.changedFiles })}
        </span>
      </p>
      <Checklist proof={proof} />
      {open ? (
        <div className="choice__pair" role="group" aria-label={t("synbot:answers")}>
          <CapsuleButton
            kind="primary"
            small
            disabled={!proof.ready || busy !== null}
            onClick={merge}
          >
            {t("synbot:proof_merge")}
          </CapsuleButton>
          {proof.behind ? (
            <CapsuleButton kind="normal" small disabled={busy !== null} onClick={updateBranch}>
              {t("synbot:proof_updateBranch")}
            </CapsuleButton>
          ) : null}
          <CapsuleButton kind="ghost" small disabled={busy !== null} onClick={load}>
            {t("synbot:proof_refresh")}
          </CapsuleButton>
        </div>
      ) : (
        <p className="choice__chosen">
          <Icon name="check" size="sm" />
          {t("synbot:proof_titleMerged")}
        </p>
      )}
    </div>
  );
}
