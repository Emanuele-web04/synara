import {
  IconAlertTriangle,
  IconArrowRight,
  IconCamera,
  IconFile,
  IconFolder,
  IconLoader2,
  IconPaperclip,
  IconPlus,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useCompanion } from "../companionContext";
import {
  EmptyState,
  InlineError,
  LoadingBlock,
  ScreenHeader,
  SectionHeading,
  ThreadRow,
} from "../components/ui";
import type { ComposerOption } from "../domain";
import { projectThreads } from "../lib/mobileLogic";
import {
  acquirePendingNewTask,
  clearPendingNewTask,
  companionRequestIds,
  pendingNewTask,
} from "../lib/requestIds";

interface NewTaskAttachment {
  readonly clientId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly size: number;
  readonly lastModified: number;
  readonly status: "pending" | "uploading" | "uploaded" | "error";
  readonly progress: number;
  readonly attachmentId?: string;
  readonly uploadedThreadId?: string;
  readonly error?: string | undefined;
}

const maximumAttachments = 8;
const imageLimit = 10 * 1024 * 1024;
const fileLimit = 25 * 1024 * 1024;

export function ProjectScreen() {
  const { projectId } = useParams({ strict: false }) as { readonly projectId: string };
  const navigate = useNavigate();
  const { shell, getComposerOptions, createThread, sendTurn, gateway } = useCompanion();
  const project = shell.projects.find((candidate) => candidate.id === projectId);
  const threads = useMemo(() => projectThreads(shell, projectId), [projectId, shell]);
  const [showNewTask, setShowNewTask] = useState(false);
  const [options, setOptions] = useState<readonly ComposerOption[] | null>(null);
  const [selectedOption, setSelectedOption] = useState("");
  const [interactionMode, setInteractionMode] = useState("");
  const [runtimeMode, setRuntimeMode] = useState<"approval-required" | "full-access">(
    "approval-required",
  );
  const [fullAccessConfirmed, setFullAccessConfirmed] = useState(false);
  const [task, setTask] = useState("");
  const [attachments, setAttachments] = useState<readonly NewTaskAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadControllersRef = useRef(new Map<string, AbortController>());
  const attachmentFilesRef = useRef(new Map<string, File>());

  useEffect(
    () => () => {
      for (const controller of uploadControllersRef.current.values()) controller.abort();
      uploadControllersRef.current.clear();
      attachmentFilesRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!showNewTask || options) return;
    const controller = new AbortController();
    void getComposerOptions(projectId)
      .then((nextOptions) => {
        if (controller.signal.aborted) return;
        setOptions(nextOptions);
        const first = nextOptions[0];
        if (first) {
          setSelectedOption(optionValue(first));
          setInteractionMode(first.interactionModes[0] ?? "default");
        }
      })
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "Models are unavailable.");
        }
      });
    return () => controller.abort();
  }, [getComposerOptions, options, projectId, showNewTask]);

  const activeOption = options?.find((option) => optionValue(option) === selectedOption);

  if (!project) {
    return (
      <div className="screen">
        <ScreenHeader title="Project unavailable" back />
        <EmptyState
          icon={<IconFolder size={24} />}
          title="This project is not available"
          description="It may have been removed from the desktop app. Return home and refresh."
        />
      </div>
    );
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOption || task.trim().length === 0) return;
    if (runtimeMode === "full-access" && !fullAccessConfirmed) return;
    const createFingerprint = JSON.stringify({
      projectId,
      providerId: activeOption.providerId,
      modelId: activeOption.modelId,
      runtimeMode,
      interactionMode,
    });
    const existingPending = pendingNewTask(projectId);
    if (existingPending && existingPending.fingerprint !== createFingerprint) {
      setError(
        "This task was already reserved with different model or permission settings. Cancel it before starting a different configuration.",
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    const turnFingerprint = JSON.stringify({
      text: task.trim(),
      attachments: attachmentFingerprints(attachments),
    });
    const pending = acquirePendingNewTask(
      projectId,
      createFingerprint,
      task.trim().slice(0, 72),
    );
    const createOperation = `create-thread:${projectId}`;
    const createRequestId = companionRequestIds.acquire(createOperation, createFingerprint);
    try {
      let threadId = pending.threadId;
      if (!pending.created) {
        const thread = await createThread({
          requestId: createRequestId,
          threadId,
          projectId,
          providerId: activeOption.providerId,
          modelId: activeOption.modelId,
          runtimeMode,
          fullAccessConfirmed,
          interactionMode,
          initialTitle: pending.initialTitle,
        });
        threadId = thread.id;
        pending.created = true;
        companionRequestIds.acknowledge(createOperation, createRequestId);
      }
      const attachmentIds: string[] = [];
      for (const attachment of attachments) {
        attachmentIds.push(await uploadAttachment(threadId, attachment));
      }
      const sendOperation = `initial-turn:${threadId}`;
      const sendRequestId = companionRequestIds.acquire(
        sendOperation,
        `${turnFingerprint}:${threadId}`,
      );
      await sendTurn({
        requestId: sendRequestId,
        threadId,
        text: task.trim(),
        attachmentIds,
        delivery: "queue",
      });
      companionRequestIds.acknowledge(sendOperation, sendRequestId);
      clearPendingNewTask(projectId);
      setAttachments([]);
      await navigate({ to: "/threads/$threadId", params: { threadId } });
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "The task could not be started.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...(event.target.files ?? [])];
    event.target.value = "";
    setError(null);
    setAttachments((current) => {
      const remaining = maximumAttachments - current.length;
      const accepted = selected.slice(0, Math.max(0, remaining));
      if (selected.length > remaining) {
        setError(`A turn can include at most ${maximumAttachments} attachments.`);
      }
      return [
        ...current,
        ...accepted.map<NewTaskAttachment>((file) => {
          const limit = file.type.startsWith("image/") ? imageLimit : fileLimit;
          const clientId = crypto.randomUUID();
          attachmentFilesRef.current.set(clientId, file);
          return {
            clientId,
            fileName: file.name,
            mediaType: file.type,
            size: file.size,
            lastModified: file.lastModified,
            status: file.size <= limit ? "pending" : "error",
            progress: 0,
            ...(file.size > limit
              ? {
                  error: `${file.type.startsWith("image/") ? "Images" : "Files"} must be ${
                    limit / 1024 / 1024
                  } MiB or smaller.`,
                }
              : {}),
          };
        }),
      ];
    });
  }

  async function uploadAttachment(
    threadId: string,
    draft: NewTaskAttachment,
  ): Promise<string> {
    if (draft.attachmentId && draft.uploadedThreadId === threadId) return draft.attachmentId;
    if (draft.attachmentId) {
      await gateway.cancelAttachment(draft.attachmentId).catch(() => undefined);
      throw new Error(
        `Remove and select ${draft.fileName} again because the target task changed.`,
      );
    }
    const file = attachmentFilesRef.current.get(draft.clientId);
    if (!file) throw new Error("Select this attachment again before retrying the upload.");
    const limit = draft.mediaType.startsWith("image/") ? imageLimit : fileLimit;
    if (draft.size > limit) throw new Error(draft.error ?? "This attachment is too large.");
    setAttachments((current) =>
      updateAttachment(current, draft.clientId, { status: "uploading", progress: 0 }),
    );
    const controller = new AbortController();
    uploadControllersRef.current.set(draft.clientId, controller);
    try {
      const attachmentId = await gateway.uploadAttachment(
        threadId,
        file,
        (progress) => {
          const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
          setAttachments((current) =>
            updateAttachment(current, draft.clientId, {
              status: "uploading",
              progress: Math.max(0, Math.min(1, ratio)),
            }),
          );
        },
        controller.signal,
      );
      attachmentFilesRef.current.delete(draft.clientId);
      setAttachments((current) =>
        updateAttachment(current, draft.clientId, {
          status: "uploaded",
          progress: 1,
          attachmentId,
          uploadedThreadId: threadId,
          error: undefined,
        }),
      );
      return attachmentId;
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "Upload failed.";
      setAttachments((current) =>
        updateAttachment(current, draft.clientId, { status: "error", error: message }),
      );
      throw uploadError;
    } finally {
      uploadControllersRef.current.delete(draft.clientId);
    }
  }

  async function removeAttachment(draft: NewTaskAttachment) {
    uploadControllersRef.current.get(draft.clientId)?.abort();
    uploadControllersRef.current.delete(draft.clientId);
    attachmentFilesRef.current.delete(draft.clientId);
    setAttachments((current) => current.filter((item) => item.clientId !== draft.clientId));
    if (draft.attachmentId) {
      await gateway.cancelAttachment(draft.attachmentId).catch(() => undefined);
    }
  }

  async function cancelNewTask() {
    for (const controller of uploadControllersRef.current.values()) controller.abort();
    uploadControllersRef.current.clear();
    attachmentFilesRef.current.clear();
    await Promise.all(
      attachments
        .flatMap((draft) => (draft.attachmentId ? [draft.attachmentId] : []))
        .map((attachmentId) => gateway.cancelAttachment(attachmentId).catch(() => undefined)),
    );
    setAttachments([]);
    const pendingThreadId = pendingNewTask(projectId)?.threadId;
    clearPendingNewTask(projectId);
    companionRequestIds.clear(`create-thread:${projectId}`);
    if (pendingThreadId) {
      companionRequestIds.clear(`initial-turn:${pendingThreadId}`);
    }
    setShowNewTask(false);
  }

  return (
    <div className="screen">
      <ScreenHeader title={project.name} eyebrow={project.workspaceLabel} back />

      {!showNewTask ? (
        <button className="new-task-card" type="button" onClick={() => setShowNewTask(true)}>
          <span className="new-task-card__icon">
            <IconPlus aria-hidden="true" size={22} />
          </span>
          <span>
            <strong>Start a new task</strong>
            Use this project’s existing workspace
          </span>
          <IconArrowRight aria-hidden="true" size={20} />
        </button>
      ) : (
        <form className="surface new-task-form" onSubmit={(event) => void submitTask(event)}>
          <div className="form-heading">
            <div>
              <p className="eyebrow">New task</p>
              <h2>What should Synara do?</h2>
            </div>
            <button className="text-button" type="button" onClick={() => void cancelNewTask()}>
              Cancel
            </button>
          </div>
          <label className="field-label" htmlFor="task-prompt">
            Instructions
          </label>
          <textarea
            id="task-prompt"
            className="text-area text-area--large"
            value={task}
            onChange={(event) => setTask(event.target.value.slice(0, 120_000))}
            placeholder="Describe the change, investigation, or question…"
            autoFocus
            required
          />

          {attachments.length > 0 ? (
            <div className="attachment-list" aria-label="Initial task attachments">
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

          <div className="button-row">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= maximumAttachments || submitting}
            >
              <IconPaperclip aria-hidden="true" size={18} />
              Add file
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              disabled={attachments.length >= maximumAttachments || submitting}
            >
              <IconCamera aria-hidden="true" size={18} />
              Take photo
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

          {options === null && !error ? <LoadingBlock label="Loading available models" /> : null}
          {options && options.length === 0 ? (
            <InlineError>No configured providers are available on the host.</InlineError>
          ) : null}
          {options && options.length > 0 ? (
            <>
              <div className="form-grid">
                <label>
                  <span className="field-label">Model</span>
                  <select
                    value={selectedOption}
                    onChange={(event) => {
                      setSelectedOption(event.target.value);
                      const option = options.find(
                        (candidate) => optionValue(candidate) === event.target.value,
                      );
                      setInteractionMode(option?.interactionModes[0] ?? "default");
                    }}
                  >
                    {options.map((option) => (
                      <option key={optionValue(option)} value={optionValue(option)}>
                        {option.providerLabel} · {option.modelLabel}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="field-label">Interaction</span>
                  <select
                    value={interactionMode}
                    onChange={(event) => setInteractionMode(event.target.value)}
                  >
                    {(activeOption?.interactionModes ?? ["default"]).map((mode) => (
                      <option key={mode} value={mode}>
                        {humanizeMode(mode)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <fieldset className="segmented-field">
                <legend className="field-label">Permissions</legend>
                <label data-selected={runtimeMode === "approval-required" || undefined}>
                  <input
                    type="radio"
                    name="runtime-mode"
                    value="approval-required"
                    checked={runtimeMode === "approval-required"}
                    onChange={() => {
                      setRuntimeMode("approval-required");
                      setFullAccessConfirmed(false);
                    }}
                  />
                  <IconShieldCheck aria-hidden="true" size={18} />
                  <span>
                    <strong>Ask first</strong>
                    Approval required
                  </span>
                </label>
                <label data-selected={runtimeMode === "full-access" || undefined}>
                  <input
                    type="radio"
                    name="runtime-mode"
                    value="full-access"
                    checked={runtimeMode === "full-access"}
                    onChange={() => setRuntimeMode("full-access")}
                  />
                  <IconAlertTriangle aria-hidden="true" size={18} />
                  <span>
                    <strong>Full access</strong>
                    Fewer prompts
                  </span>
                </label>
              </fieldset>

              {runtimeMode === "full-access" ? (
                <label className="confirmation-card">
                  <input
                    type="checkbox"
                    checked={fullAccessConfirmed}
                    onChange={(event) => setFullAccessConfirmed(event.target.checked)}
                  />
                  <span>
                    <strong>This agent can change files and run commands without asking.</strong>
                    I trust this task and understand it runs on my computer.
                  </span>
                </label>
              ) : null}
            </>
          ) : null}

          {error ? <InlineError>{error}</InlineError> : null}
          <button
            type="submit"
            className="button button--primary button--wide"
            disabled={
              submitting ||
              task.trim().length === 0 ||
              !activeOption ||
              (runtimeMode === "full-access" && !fullAccessConfirmed)
            }
          >
            {submitting ? "Starting task…" : "Start task"}
            {!submitting ? <IconArrowRight aria-hidden="true" size={19} /> : null}
          </button>
        </form>
      )}

      <section className="section-block">
        <SectionHeading title="Tasks" count={threads.length} />
        {threads.length > 0 ? (
          <div className="thread-list">
            {threads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No tasks yet"
            description="Start the first task for this project from your phone."
          />
        )}
      </section>
    </div>
  );
}

function optionValue(option: ComposerOption): string {
  return `${option.providerId}\u0000${option.modelId}`;
}

function humanizeMode(mode: string): string {
  return mode.replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase());
}

function updateAttachment(
  drafts: readonly NewTaskAttachment[],
  clientId: string,
  patch: Partial<NewTaskAttachment>,
): readonly NewTaskAttachment[] {
  return drafts.map((draft) => (draft.clientId === clientId ? { ...draft, ...patch } : draft));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function attachmentFingerprints(drafts: readonly NewTaskAttachment[]): readonly string[] {
  return drafts
    .map((draft) =>
      JSON.stringify([draft.fileName, draft.size, draft.mediaType, draft.lastModified]),
    )
    .sort();
}
