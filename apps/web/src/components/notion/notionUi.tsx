import type { NotionApi } from "@synara/contracts";
import { useRef, useState } from "react";
import { ensureNativeApi } from "~/nativeApi";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { NotionWriteSession, type NotionWriteProposal } from "./notionWrites";

export function notionApi(): NotionApi {
  const api = ensureNativeApi().notion;
  if (!api) throw new Error("This Synara server does not support Notion.");
  return api;
}

export function useNotionAction() {
  const busy = useRef(false);
  const session = useRef<NotionWriteSession | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  if (session.current === null) session.current = new NotionWriteSession();

  async function run(action: () => Promise<unknown>) {
    // React state is not a lock: two handlers can run before the next render.
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Notion could not complete this operation.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function write(input: NotionWriteProposal) {
    try {
      return await session.current!.write(notionApi(), input);
    } finally {
      setAwaitingConfirmation(session.current!.awaitingConfirmation);
    }
  }

  return { pending, error, run, write, awaitingConfirmation };
}

export function NotionSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
      items={options}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup surface="settings">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function NotionError({ message }: { message: string | null | undefined }) {
  return message ? (
    <p role="alert" className="text-ui text-destructive">
      {message}
    </p>
  ) : null;
}

export function NotionReceiptNotice({ active }: { active: boolean }) {
  return active ? (
    <p role="status" className="text-ui-sm text-muted-foreground">
      A previous write is unconfirmed. Retrying here checks the same request; closing or discarding
      does not undo a remote write. Review the change in Notion settings before submitting it again.
    </p>
  ) : null;
}
