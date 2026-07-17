import {
  IconAlertTriangle,
  IconArrowUp,
  IconCamera,
  IconCheck,
  IconFile,
  IconGitCompare,
  IconLoader2,
  IconPaperclip,
  IconPlayerStop,
  IconRobot,
  IconShieldCheck,
  IconTrash,
  IconUser,
  IconX,
} from "@tabler/icons-react";
import { Link, useParams } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCompanion } from "../companionContext";
import {
  EmptyState,
  InlineError,
  LoadingBlock,
  ScreenHeader,
  StatusBadge,
} from "../components/ui";
import type { ThreadDetail } from "../domain";
import { relativeTime, safeExternalUrl } from "../lib/mobileLogic";
import { companionRequestIds } from "../lib/requestIds";

interface AttachmentDraft {
  readonly clientId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly size: number;
  readonly lastModified: number;
  readonly status: "pending" | "uploading" | "uploaded" | "error";
  readonly progress: number;
  readonly attachmentId?: string;
  readonly error?: string | undefined;
}

const maximumAttachments = 8;
const imageLimit = 10 * 1024 * 1024;
const fileLimit = 25 * 1024 * 1024;

export function ThreadScreen() {
  const { threadId } = useParams({ strict: false }) as { readonly threadId: string };
  const {
    threads,
    loadThread,
    sendTurn,
    interrupt,
    respondToApproval,
    respondToInput,
    gateway,
  } = useCompanion();
  const thread = threads.get(threadId);
  const [loading, setLoading] = useState(!thread);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const leaseId = gateway.retainThread(threadId);
    setLoading(true);
    void loadThread(threadId)
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : "The task could not be loaded.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      void gateway.releaseThread(threadId, leaseId);
    };
  }, [gateway, loadThread, threadId]);

  useEffect(() => {
    const refreshFromPush = (event: Event) => {
      const payload = (event as CustomEvent<{ threadId?: unknown }>).detail;
      if (payload?.threadId === threadId) void loadThread(threadId).catch(() => undefined);
    };
    window.addEventListener("synara:companion-push", refreshFromPush);
    return () => window.removeEventListener("synara:companion-push", refreshFromPush);
  }, [loadThread, threadId]);

  if (loading && !thread) {
    return (
      <div className="screen">
        <ScreenHeader title="Task" back />
        <LoadingBlock label="Loading task" />
      </div>
    );
  }
  if (!thread) {
    return (
      <div className="screen">
        <ScreenHeader title="Task unavailable" back />
        {loadError ? <InlineError>{loadError}</InlineError> : null}
        <EmptyState
          title="This task is unavailable"
          description="It may have been removed or belongs to a project that is no longer configured."
        />
      </div>
    );
  }

  return (
    <ThreadView
      thread={thread}
      gateway={gateway}
      sendTurn={sendTurn}
      interrupt={interrupt}
      respondToApproval={respondToApproval}
      respondToInput={respondToInput}
    />
  );
}

function ThreadView({
  thread,
  gateway,
  sendTurn,
  interrupt,
  respondToApproval,
  respondToInput,
}: {
  readonly thread: ThreadDetail;
  readonly gateway: ReturnType<typeof useCompanion>["gateway"];
  readonly sendTurn: ReturnType<typeof useCompanion>["sendTurn"];
  readonly interrupt: ReturnType<typeof useCompanion>["interrupt"];
  readonly respondToApproval: ReturnType<typeof useCompanion>["respondToApproval"];
  readonly respondToInput: ReturnType<typeof useCompanion>["respondToInput"];
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followingLiveOutput = useRef(true);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadControllersRef = useRef(new Map<string, AbortController>());
  const attachmentFilesRef = useRef(new Map<string, File>());
  const [text, setText] = useState("");
  const [delivery, setDelivery] = useState<"queue" | "steer">("steer");
  const [attachments, setAttachments] = useState<readonly AttachmentDraft[]>([]);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const latestStreamingText = useMemo(
    () =>
      [...thread.messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.streaming)?.text ?? "",
    [thread.messages],
  );
  const transcriptRows = useMemo(
    () => [
      ...thread.messages.map((message) => ({ kind: "message" as const, message })),
      ...thread.activity.map((activity) => ({ kind: "activity" as const, activity })),
    ],
    [thread.activity, thread.messages],
  );
  const transcriptVirtualizer = useVirtualizer({
    count: transcriptRows.length,
    getScrollElement: () => transcriptRef.current,
    estimateSize: (index) => (transcriptRows[index]?.kind === "message" ? 180 : 72),
    getItemKey: (index) => {
      const row = transcriptRows[index];
      return row?.kind === "message"
        ? `message:${row.message.id}`
        : `activity:${row?.activity.id ?? index}`;
    },
    overscan: 6,
  });

  useEffect(() => {
    if (!latestStreamingText || !followingLiveOutput.current) return;
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [latestStreamingText]);

  useEffect(
    () => () => {
      for (const controller of uploadControllersRef.current.values()) controller.abort();
      uploadControllersRef.current.clear();
      attachmentFilesRef.current.clear();
    },
    [],
  );

  function trackScroll() {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    followingLiveOutput.current =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
  }

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...(event.target.files ?? [])];
    event.target.value = "";
    setActionError(null);
    setAttachments((current) => {
      const remaining = maximumAttachments - current.length;
      const accepted = selected.slice(0, Math.max(0, remaining));
      const next = accepted.map<AttachmentDraft>((file) => {
        const limit = file.type.startsWith("image/") ? imageLimit : fileLimit;
        const clientId = crypto.randomUUID();
        attachmentFilesRef.current.set(clientId, file);
        return file.size <= limit
            ? {
                clientId,
                fileName: file.name,
                mediaType: file.type,
                size: file.size,
                lastModified: file.lastModified,
                status: "pending",
                progress: 0,
              }
            : {
                clientId,
                fileName: file.name,
                mediaType: file.type,
                size: file.size,
                lastModified: file.lastModified,
                status: "error",
              progress: 0,
              error: `${file.type.startsWith("image/") ? "Images" : "Files"} must be ${
                limit / 1024 / 1024
              } MiB or smaller.`,
            };
      });
      if (selected.length > remaining) {
        setActionError(`A turn can include at most ${maximumAttachments} attachments.`);
      }
      return [...current, ...next];
    });
  }

  async function removeAttachment(draft: AttachmentDraft) {
    uploadControllersRef.current.get(draft.clientId)?.abort();
    uploadControllersRef.current.delete(draft.clientId);
    attachmentFilesRef.current.delete(draft.clientId);
    setAttachments((current) => current.filter((item) => item.clientId !== draft.clientId));
    if (draft.attachmentId) {
      await gateway.cancelAttachment(draft.attachmentId).catch(() => undefined);
    }
  }

  async function uploadAttachment(draft: AttachmentDraft): Promise<string> {
    if (draft.attachmentId) return draft.attachmentId;
    const file = attachmentFilesRef.current.get(draft.clientId);
    if (!file) throw new Error("Select this attachment again before retrying the upload.");
    const limit = draft.mediaType.startsWith("image/") ? imageLimit : fileLimit;
    if (draft.size > limit) throw new Error(draft.error ?? "This attachment is too large.");
    setAttachments((current) =>
      updateDraft(current, draft.clientId, { status: "uploading", progress: 0 }),
    );
    const controller = new AbortController();
    uploadControllersRef.current.set(draft.clientId, controller);
    try {
      const attachmentId = await gateway.uploadAttachment(
        thread.id,
        file,
        (progress) => {
          const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
          setAttachments((current) =>
            updateDraft(current, draft.clientId, {
              status: "uploading",
              progress: Math.max(0, Math.min(1, ratio)),
            }),
          );
        },
        controller.signal,
      );
      attachmentFilesRef.current.delete(draft.clientId);
      setAttachments((current) =>
        updateDraft(current, draft.clientId, {
          status: "uploaded",
          progress: 1,
          attachmentId,
          error: undefined,
        }),
      );
      return attachmentId;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed.";
      setAttachments((current) =>
        updateDraft(current, draft.clientId, { status: "error", error: message }),
      );
      throw error;
    } finally {
      uploadControllersRef.current.delete(draft.clientId);
    }
  }

  async function submitTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || (text.trim().length === 0 && attachments.length === 0)) return;
    setSending(true);
    setActionError(null);
    const effectiveDelivery = thread.status === "running" ? delivery : "queue";
    const fingerprint = JSON.stringify({
      threadId: thread.id,
      text: text.trim(),
      delivery: effectiveDelivery,
      attachments: attachmentFingerprints(attachments),
    });
    const operation = `send-turn:${thread.id}`;
    const requestId = companionRequestIds.acquire(operation, fingerprint);
    try {
      const attachmentIds: string[] = [];
      for (const attachment of attachments) {
        attachmentIds.push(await uploadAttachment(attachment));
      }
      await sendTurn({
        requestId,
        threadId: thread.id,
        text: text.trim(),
        attachmentIds,
        delivery: effectiveDelivery,
      });
      companionRequestIds.acknowledge(operation, requestId);
      setText("");
      setAttachments([]);
      followingLiveOutput.current = true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  async function handleInterrupt() {
    setInterrupting(true);
    setActionError(null);
    const operation = `interrupt:${thread.id}`;
    const requestId = companionRequestIds.acquire(operation, thread.id);
    try {
      await interrupt(thread.id, requestId);
      companionRequestIds.acknowledge(operation, requestId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The task could not be interrupted.");
    } finally {
      setInterrupting(false);
    }
  }

  return (
    <div className="thread-screen">
      <ScreenHeader
        title={thread.title}
        eyebrow={`${thread.providerLabel} · ${thread.modelLabel}`}
        back
        actions={<StatusBadge status={thread.status} />}
      />

      <div className="thread-toolbar">
        <Link
          to="/threads/$threadId/diff"
          params={{ threadId: thread.id }}
          className="toolbar-button"
        >
          <IconGitCompare aria-hidden="true" size={17} />
          View changes
        </Link>
        {thread.status === "running" ? (
          <button
            type="button"
            className="toolbar-button toolbar-button--danger"
            onClick={() => void handleInterrupt()}
            disabled={interrupting}
          >
            <IconPlayerStop aria-hidden="true" size={17} />
            {interrupting ? "Stopping…" : "Stop"}
          </button>
        ) : null}
      </div>

      <div className="transcript" ref={transcriptRef} onScroll={trackScroll}>
        {transcriptRows.length === 0 ? (
          <EmptyState
            icon={<IconRobot size={24} />}
            title="Ready for instructions"
            description="Send a message to start this task."
          />
        ) : (
          <div
            className="virtual-transcript"
            style={{ height: transcriptVirtualizer.getTotalSize() }}
          >
            {transcriptVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = transcriptRows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  className="virtual-transcript__row"
                  data-index={virtualRow.index}
                  key={virtualRow.key}
                  ref={transcriptVirtualizer.measureElement}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.kind === "message" ? (
                    <article className="message" data-role={row.message.role}>
                      <div className="message__meta">
                        <span className="message__avatar">
                          {row.message.role === "user" ? (
                            <IconUser aria-hidden="true" size={15} />
                          ) : (
                            <IconRobot aria-hidden="true" size={15} />
                          )}
                        </span>
                        <strong>{row.message.role === "user" ? "You" : "Synara"}</strong>
                        <time dateTime={row.message.createdAt}>
                          {relativeTime(row.message.createdAt)}
                        </time>
                        {row.message.streaming ? <span className="live-dot">Live</span> : null}
                      </div>
                      <div className="markdown-body">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => (
                              <button
                                type="button"
                                className="markdown-external-link"
                                onClick={() => confirmExternalLink(href)}
                              >
                                {children}
                              </button>
                            ),
                          }}
                        >
                          {row.message.text}
                        </ReactMarkdown>
                      </div>
                    </article>
                  ) : (
                    <div className="activity-row" data-tone={row.activity.tone}>
                      <span className="activity-row__dot" aria-hidden="true" />
                      <div>
                        <strong>{row.activity.title}</strong>
                        {row.activity.detail ? <p>{row.activity.detail}</p> : null}
                      </div>
                      <time dateTime={row.activity.createdAt}>
                        {relativeTime(row.activity.createdAt)}
                      </time>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {thread.pendingApproval ? (
          <ApprovalCard
            threadId={thread.id}
            approval={thread.pendingApproval}
            respond={respondToApproval}
          />
        ) : null}

        {thread.pendingInput ? (
          <UserInputCard
            threadId={thread.id}
            request={thread.pendingInput}
            respond={respondToInput}
          />
        ) : null}
      </div>

      <form className="composer" onSubmit={(event) => void submitTurn(event)}>
        {thread.status === "running" ? (
          <div className="delivery-control" role="group" aria-label="Message behavior">
            <button
              type="button"
              aria-pressed={delivery === "steer"}
              data-active={delivery === "steer" || undefined}
              onClick={() => setDelivery("steer")}
            >
              Steer now
            </button>
            <button
              type="button"
              aria-pressed={delivery === "queue"}
              data-active={delivery === "queue" || undefined}
              onClick={() => setDelivery("queue")}
            >
              Queue next
            </button>
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="attachment-list" aria-label="Attachments">
            {attachments.map((draft) => (
              <div className="attachment-chip" data-status={draft.status} key={draft.clientId}>
                <IconFile aria-hidden="true" size={17} />
                <span>
                    <strong>{draft.fileName}</strong>
                  <small>
                    {draft.error ??
                      (draft.status === "uploading"
                        ? `${Math.round(draft.progress * 100)}%`
                        : formatBytes(draft.size))}
                  </small>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${draft.fileName}`}
                  onClick={() => void removeAttachment(draft)}
                >
                  {draft.status === "uploading" ? (
                    <IconLoader2 className="spin" aria-hidden="true" size={16} />
                  ) : (
                    <IconX aria-hidden="true" size={16} />
                  )}
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {actionError ? <InlineError>{actionError}</InlineError> : null}
        <div className="composer__input">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, 120_000))}
            placeholder={thread.status === "running" ? "Steer or queue a follow-up…" : "Message Synara…"}
            aria-label="Message Synara"
            rows={1}
          />
          <button
            className="composer__attach"
            type="button"
            aria-label="Attach a file"
            onClick={() => fileInputRef.current?.click()}
            disabled={attachments.length >= maximumAttachments || sending}
          >
            <IconPaperclip aria-hidden="true" size={20} />
          </button>
          <button
            className="composer__attach"
            type="button"
            aria-label="Take a photo"
            onClick={() => cameraInputRef.current?.click()}
            disabled={attachments.length >= maximumAttachments || sending}
          >
            <IconCamera aria-hidden="true" size={20} />
          </button>
          <button
            className="composer__send"
            type="submit"
            aria-label="Send message"
            disabled={sending || (text.trim().length === 0 && attachments.length === 0)}
          >
            {sending ? (
              <IconLoader2 className="spin" aria-hidden="true" size={20} />
            ) : (
              <IconArrowUp aria-hidden="true" size={20} />
            )}
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            multiple
            onChange={addFiles}
          />
          <input
            ref={cameraInputRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={addFiles}
          />
        </div>
      </form>
    </div>
  );
}

function ApprovalCard({
  threadId,
  approval,
  respond,
}: {
  readonly threadId: string;
  readonly approval: NonNullable<ThreadDetail["pendingApproval"]>;
  readonly respond: ReturnType<typeof useCompanion>["respondToApproval"];
}) {
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "deny") {
    setSubmitting(decision);
    setError(null);
    const operation = `approval:${approval.id}:${decision}`;
    const requestId = companionRequestIds.acquire(
      operation,
      `${threadId}:${approval.id}:${decision}`,
    );
    try {
      await respond(threadId, approval.id, decision, requestId);
      companionRequestIds.acknowledge(operation, requestId);
    } catch (decisionError) {
      setError(
        decisionError instanceof Error ? decisionError.message : "The decision was not accepted.",
      );
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section className="attention-card" data-risk={approval.risk}>
      <div className="attention-card__heading">
        <IconShieldCheck aria-hidden="true" size={21} />
        <div>
          <p className="eyebrow">Approval required · {approval.risk} risk</p>
          <h2>{approval.title}</h2>
        </div>
      </div>
      <p>{approval.description}</p>
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="button-row">
        <button
          type="button"
          className="button button--secondary"
          disabled={submitting !== null}
          onClick={() => void decide("deny")}
        >
          <IconTrash aria-hidden="true" size={17} />
          {submitting === "deny" ? "Denying…" : "Deny"}
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={submitting !== null}
          onClick={() => void decide("approve")}
        >
          <IconCheck aria-hidden="true" size={17} />
          {submitting === "approve" ? "Approving…" : "Approve once"}
        </button>
      </div>
    </section>
  );
}

function UserInputCard({
  threadId,
  request,
  respond,
}: {
  readonly threadId: string;
  readonly request: NonNullable<ThreadDetail["pendingInput"]>;
  readonly respond: ReturnType<typeof useCompanion>["respondToInput"];
}) {
  const [answers, setAnswers] = useState<Record<string, string | readonly string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = request.questions.every((question) => {
    const answer = answers[question.id];
    return Array.isArray(answer) ? answer.length > 0 : typeof answer === "string" && answer.trim().length > 0;
  });

  function toggleMultiple(questionId: string, value: string, checked: boolean) {
    setAnswers((current) => {
      const selected = current[questionId];
      const values = Array.isArray(selected) ? selected : [];
      return {
        ...current,
        [questionId]: checked
          ? [...new Set([...values, value])]
          : values.filter((candidate) => candidate !== value),
      };
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete) return;
    setSubmitting(true);
    setError(null);
    const fingerprint = JSON.stringify(
      request.questions.map((question) => [question.id, answers[question.id]]),
    );
    const operation = `user-input:${request.id}`;
    const requestId = companionRequestIds.acquire(operation, fingerprint);
    try {
      await respond(threadId, request.id, answers, requestId);
      companionRequestIds.acknowledge(operation, requestId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The answers were not accepted.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="attention-card" onSubmit={(event) => void submit(event)}>
      <div className="attention-card__heading">
        <IconAlertTriangle aria-hidden="true" size={20} />
        <div>
          <p className="eyebrow">Your input is needed</p>
          <h2>Answer {request.questions.length === 1 ? "one question" : `${request.questions.length} questions`}</h2>
        </div>
      </div>
      {request.questions.map((question) => (
        <fieldset className="input-question" key={question.id}>
          <legend>
            <span>{question.header}</span>
            {question.prompt}
          </legend>
          {question.choices ? (
            <div className="choice-list">
              {question.choices.map((choice) => {
                const selected = answers[question.id];
                const checked = question.multiSelect
                  ? Array.isArray(selected) && selected.includes(choice.value)
                  : selected === choice.value;
                return (
                  <label key={choice.value}>
                    <input
                      type={question.multiSelect ? "checkbox" : "radio"}
                      name={`input-answer-${question.id}`}
                      value={choice.value}
                      checked={checked}
                      onChange={(event) => {
                        if (question.multiSelect) {
                          toggleMultiple(question.id, choice.value, event.target.checked);
                        } else {
                          setAnswers((current) => ({ ...current, [question.id]: choice.value }));
                        }
                      }}
                    />
                    <span>
                      <strong>{choice.label}</strong>
                      {choice.description ? <small>{choice.description}</small> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <textarea
              className="text-area"
              value={typeof answers[question.id] === "string" ? answers[question.id] : ""}
              onChange={(event) =>
                setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
              }
              placeholder="Type your answer…"
            />
          )}
        </fieldset>
      ))}
      {error ? <InlineError>{error}</InlineError> : null}
      <button type="submit" className="button button--primary" disabled={!complete || submitting}>
        {submitting ? "Sending…" : "Send answers"}
        {!submitting ? <IconArrowUp aria-hidden="true" size={17} /> : null}
      </button>
    </form>
  );
}

function updateDraft(
  drafts: readonly AttachmentDraft[],
  clientId: string,
  patch: Partial<AttachmentDraft>,
): readonly AttachmentDraft[] {
  return drafts.map((draft) => (draft.clientId === clientId ? { ...draft, ...patch } : draft));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function attachmentFingerprints(drafts: readonly AttachmentDraft[]): readonly string[] {
  return drafts
    .map((draft) =>
      JSON.stringify([draft.fileName, draft.size, draft.mediaType, draft.lastModified]),
    )
    .sort();
}

function confirmExternalLink(href: string | undefined) {
  if (!href) return;
  const safeUrl = safeExternalUrl(href);
  if (!safeUrl) return;
  if (window.confirm(`Open this external link?\n\n${safeUrl}`)) {
    window.open(safeUrl, "_blank", "noopener,noreferrer");
  }
}
