// Opens the selected account's native CLI in an ephemeral terminal for /usage.
import { ThreadId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import TerminalViewport from "~/components/terminal/TerminalViewport";
import { disposeAndCloseTerminalSession } from "~/components/terminal/terminalSession";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { useTranslation } from "~/i18n";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { readNativeApi } from "~/nativeApi";

const ignoreTerminalEvent = () => {};

export default function AntigravityUsageDialog({
  instanceId,
  accountLabel,
  onClose,
}: {
  instanceId: string;
  accountLabel: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const config = useQuery(serverConfigQueryOptions());
  const [session] = useState(() => ({
    threadId: ThreadId.makeUnsafe(`provider-usage-${crypto.randomUUID()}`),
    terminalId: "usage",
  }));
  const [closing, setClosing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pendingClose = useRef<Promise<void> | null>(null);
  const mounted = useRef(false);
  const closeTerminal = useCallback(() => {
    pendingClose.current ??= disposeAndCloseTerminalSession({
      api: readNativeApi(),
      ...session,
      requireStructuredClose: true,
    }).catch((error: unknown) => {
      pendingClose.current = null;
      throw error;
    });
    return pendingClose.current;
  }, [session]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Strict Mode can immediately reclaim this terminal after replaying cleanup.
      queueMicrotask(() => {
        if (!mounted.current) void closeTerminal().catch(() => undefined);
      });
    };
  }, [closeTerminal]);

  const title = t("settings:antigravityQuotaTitle", { account: accountLabel });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open || closing) return;
        setClosing(true);
        setProblem(null);
        void closeTerminal().then(onClose, (error: unknown) => {
          setProblem(error instanceof Error ? error.message : t("chat:unableToCloseTerminal"));
          setClosing(false);
        });
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {t("settings:antigravityQuotaInstructions", { command: "/usage" })}
        </DialogDescription>
        <div className="h-[min(24rem,45vh)] overflow-hidden rounded-xl border border-border">
          {config.data?.cwd ? (
            <TerminalViewport
              {...session}
              cwd={config.data.cwd}
              providerAuthInstanceId={instanceId}
              terminalLabel={title}
              onSessionExited={ignoreTerminalEvent}
              onTerminalMetadataChange={ignoreTerminalEvent}
              onTerminalActivityChange={ignoreTerminalEvent}
              focusRequestId={0}
              autoFocus
              isVisible
            />
          ) : (
            <p className="p-3 text-ui-sm">
              {config.isError
                ? t("settings:unableToConnectToTheSynaraServer")
                : t("computer:connecting")}
            </p>
          )}
        </div>
        {problem ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {problem}
          </p>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
