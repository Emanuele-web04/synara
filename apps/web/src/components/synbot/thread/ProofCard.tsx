// FILE: ProofCard.tsx
// Purpose: The merge proof, HoloBot's signature card (thread/ProofCard.tsx + ProofBadge.tsx):
//          "Merge it?" with the pull request and what changed (PR #12 · +12 −3 · 4 files), the
//          proof as a checklist (checks green on the current head, the branch up to date with
//          its base, no conflicts, the diff's red flags, never trusted away), then its answers:
//          Merge (primary, only when the server says the proof is ready; the merge is the
//          user's, asked once more in a dialog), Update branch when behind, Refresh. Shown in a
//          task's pane when Settings → SynBot → Merge proof is on and the task has a pull
//          request (bots.mergeProof / merge / updateBranch). A card of the same height holds
//          its place while it loads; it reads the proof again when the task moves on or its pull
//          request changes, and every 20 s while checks run (for five minutes at most).
// Layer: SynBot thread UI
// Exports: ProofCard

import type { BotMergeProof, HubWorkState, ThreadId } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";
import { describeErrorMessage } from "@synara/shared/errorMessages";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";

import { toastManager } from "../../ui/toast";
import { AlertDialog } from "../kit/Dialog";
import { CapsuleButton, Chip } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { StatusMark, type MarkShape, type MarkTone } from "./CardParts";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly proof: BotMergeProof }
  /** The server has no pull request for the task (yet): no card. */
  | { readonly kind: "none" }
  | { readonly kind: "error"; readonly message: string };

type Check = { readonly tone: "good" | "bad" | "attention" | "muted"; readonly text: string };

/** While checks run, the proof is read again this often, this many times at most. */
const PENDING_POLL_MS = 20_000;
const PENDING_POLLS = 15;

const messageOf = (error: unknown) => describeErrorMessage(error, String(error));

/** The server's "no pull request yet" (bots.mergeProof fails with code `invalid`). */
function isNoPullRequest(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  return code === "invalid" || /no pull request/i.test(messageOf(error));
}

const MARK: Record<Check["tone"], { readonly shape: MarkShape; readonly tone: MarkTone }> = {
  good: { shape: "check", tone: "good" },
  bad: { shape: "cross", tone: "bad" },
  attention: { shape: "dot", tone: "attention" },
  muted: { shape: "ring", tone: "muted" },
};

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
      tone: flag.kind === "outside-scope" ? "attention" : "bad",
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
          <StatusMark shape={MARK[check.tone].shape} tone={MARK[check.tone].tone} />
          <span className="checklist__text">{check.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** The card's place while the proof loads: its frame, a title and three lines, no jump. */
function ProofSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="choice proof-card proof-card--loading" aria-busy role="status">
      <span className="sr-only">{t("synbot:proofLoading")}</span>
      <span className="proof-card__bone proof-card__bone--title" aria-hidden />
      <span className="proof-card__bone" aria-hidden />
      <span className="proof-card__bone" aria-hidden />
      <span className="proof-card__bone proof-card__bone--short" aria-hidden />
    </div>
  );
}

export function ProofCard({
  threadId,
  prUrl,
  taskState,
}: {
  readonly threadId: ThreadId;
  /** The task's known pull request: a new one reads the proof again. */
  readonly prUrl: string;
  /** Where the task stands: a change (a push, a finished run) reads the proof again. */
  readonly taskState: HubWorkState | null;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState<"merge" | "update" | "refresh" | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Only the newest read lands (a slow one never overwrites a later one).
  const latestRead = useRef(0);

  const load = (quiet: boolean) => {
    const api = readNativeApi();
    if (!api) return;
    const read = latestRead.current + 1;
    latestRead.current = read;
    if (!quiet) setBusy((current) => current ?? "refresh");
    void api.bots
      .mergeProof({ threadId })
      .then((proof) => {
        if (latestRead.current === read) setState({ kind: "ready", proof });
      })
      .catch((error: unknown) => {
        if (latestRead.current !== read) return;
        setState(
          isNoPullRequest(error) ? { kind: "none" } : { kind: "error", message: messageOf(error) },
        );
      })
      .finally(() => {
        if (!quiet) setBusy((current) => (current === "refresh" ? null : current));
      });
  };
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // A new task, pull request or task state: read the proof again (the card keeps its place).
  useEffect(() => {
    loadRef.current(true);
  }, [threadId, prUrl, taskState]);

  // Checks still running: look again every 20 s, for five minutes at most.
  const pendingHead =
    state.kind === "ready" && state.proof.state === "open" && state.proof.checks === "pending"
      ? state.proof.headSha
      : null;
  useEffect(() => {
    if (!pendingHead) return;
    let polls = 0;
    const timer = window.setInterval(() => {
      polls += 1;
      loadRef.current(true);
      if (polls >= PENDING_POLLS) window.clearInterval(timer);
    }, PENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pendingHead]);

  if (state.kind === "loading") return <ProofSkeleton />;
  if (state.kind === "none") return null;
  if (state.kind === "error") {
    return (
      <div className="choice proof-card proof-card--error" role="status">
        <p className="choice__note">{t("synbot:proofUnavailable")}</p>
        <div className="choice__pair">
          <CapsuleButton kind="ghost" compact disabled={busy !== null} onClick={() => load(false)}>
            {t("synbot:proof_refresh")}
          </CapsuleButton>
        </div>
      </div>
    );
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
      .finally(() => {
        setBusy(null);
        setConfirming(false);
      });
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
          {proof.state === "merged"
            ? t("synbot:proof_titleMerged")
            : proof.state === "closed"
              ? t("synbot:proof_titleClosed")
              : t("synbot:proof_title")}
        </p>
        <Chip
          tone={
            proof.ready
              ? "good"
              : proof.state === "merged" || proof.state === "closed"
                ? "muted"
                : "attention"
          }
          dot
        >
          {proof.ready
            ? t("synbot:proof_ready")
            : proof.state === "merged"
              ? t("synbot:proof_merged")
              : proof.state === "closed"
                ? t("synbot:proof_closed")
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
            compact
            disabled={!proof.ready || busy !== null}
            onClick={() => setConfirming(true)}
          >
            {t("synbot:proof_merge")}
          </CapsuleButton>
          {proof.behind ? (
            <CapsuleButton kind="normal" compact disabled={busy !== null} onClick={updateBranch}>
              {t("synbot:proof_updateBranch")}
            </CapsuleButton>
          ) : null}
          <CapsuleButton kind="ghost" compact disabled={busy !== null} onClick={() => load(false)}>
            {t("synbot:proof_refresh")}
          </CapsuleButton>
        </div>
      ) : proof.state === "merged" ? (
        <p className="choice__chosen">
          <Icon name="check" size="sm" />
          {t("synbot:proof_titleMerged")}
        </p>
      ) : (
        <p className="choice__chosen">{t("synbot:proof_titleClosed")}</p>
      )}
      <AlertDialog
        open={confirming}
        title={t("synbot:proofMergeConfirmTitle", { number: proof.prNumber })}
        message={t("synbot:proofMergeConfirmBody", { base: proof.baseBranch })}
        confirmLabel={t("synbot:proof_merge")}
        busy={busy === "merge"}
        onConfirm={merge}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
