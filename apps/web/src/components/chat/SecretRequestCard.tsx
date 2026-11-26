// FILE: SecretRequestCard.tsx
// Purpose: The private card for an agent's `synara_request_secret` call. The typed value
//          goes once over the authenticated socket to the server, which writes it to an
//          owner-only file; it is never stored in the thread, the client log, or chat.
// Layer: Chat transcript card
// Exports: SecretRequestCard

import { ThreadId } from "@synara/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { ExternalLinkIcon, EyeIcon, Key01Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import type { WorkLogSecretRequest } from "~/workLog";

const STATUS_TEXT = {
  saved: "Saved securely. The agent got a private file path, not the value.",
  declined: "Declined",
  cancelled: "Closed before an answer",
  timed_out: "Timed out without an answer",
} as const;

export function SecretRequestCard(props: {
  request: WorkLogSecretRequest;
  threadId: string | null | undefined;
}) {
  const { request, threadId } = props;
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hides the form as soon as the server accepts, before the resolution activity arrives.
  const [answered, setAnswered] = useState(false);
  // The server no longer holds this request (it restarted, or the agent stopped).
  const [gone, setGone] = useState(false);

  const submit = async (answer: { type: "save"; secret: string } | { type: "decline" }) => {
    if (!threadId || pending) return;
    setPending(true);
    setError(null);
    try {
      await ensureNativeApi().secretRequest.answer({
        threadId: ThreadId.makeUnsafe(threadId),
        requestId: request.requestId,
        answer,
      });
      setValue("");
      setAnswered(true);
    } catch (cause) {
      const message = cause instanceof Error && cause.message ? cause.message : "Could not send.";
      if (message.includes("no longer waiting")) {
        setValue("");
        setGone(true);
      } else setError(message);
    } finally {
      setPending(false);
    }
  };

  const open = request.status === undefined && !answered && !gone;
  return (
    <section
      className="my-1 w-full max-w-xl min-w-0 rounded-xl border border-border bg-[var(--color-background-elevated-primary)] p-4 text-ui"
      aria-label={`Secret request: ${request.label}`}
    >
      <div className="flex items-center gap-2 font-medium text-foreground">
        <Key01Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">{request.label}</span>
      </div>
      <p className="mt-1 text-ui-sm text-muted-foreground [overflow-wrap:anywhere]">
        {request.reason}
      </p>
      {request.url && open ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => void ensureNativeApi().shell.openExternal(request.url!)}
        >
          <ExternalLinkIcon className="size-3.5" aria-hidden />
          Open page
        </Button>
      ) : null}
      {open ? (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.length > 0) void submit({ type: "save", secret: value });
          }}
        >
          <div className="flex items-center gap-2">
            <InputGroup className="min-w-0 flex-1">
              <InputGroupInput
                type={revealed ? "text" : "password"}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={request.placeholder ?? "Enter the secret"}
                aria-label={request.label}
                autoComplete="new-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                disabled={pending}
              />
              <InputGroupAddon align="inline-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={revealed ? "Hide secret" : "Show secret"}
                  aria-pressed={revealed}
                  onClick={() => setRevealed((current) => !current)}
                >
                  <EyeIcon className={cn("size-4", revealed ? "opacity-100" : "opacity-60")} />
                </Button>
              </InputGroupAddon>
            </InputGroup>
            <Button type="submit" size="sm" disabled={pending || value.length === 0 || !threadId}>
              Save securely
            </Button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-ui-xs text-muted-foreground">
              Kept out of chat, in a private file this agent&apos;s commands can read for 24 hours
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending || !threadId}
              onClick={() => void submit({ type: "decline" })}
            >
              Decline
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-2 text-ui-sm text-muted-foreground">
          {request.status
            ? STATUS_TEXT[request.status]
            : gone
              ? "No longer waiting. The agent stopped or the request timed out."
              : "Sent"}
        </p>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
