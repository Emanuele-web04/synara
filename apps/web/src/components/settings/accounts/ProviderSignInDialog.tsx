// FILE: ProviderSignInDialog.tsx
// Purpose: Guided provider sign-in. The provider's own login runs in the shared isolated
//          terminal, but the window reads its output and shows what is going on in plain
//          steps: the browser tab it opened, the wait for approval, a code field when the
//          login asks for one, and a clear connected / nothing-came-back ending. The raw
//          terminal stays one click away under "technical details", and is open from the
//          start for logins that ask their questions in the terminal.
// Layer: Settings UI

import { ThreadId, type ProviderKind } from "@synara/contracts";
import { PROVIDER_AUTHENTICATION } from "@synara/shared/providerCliProfiles";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { useTranslation } from "~/i18n";
import { CheckIcon } from "~/lib/icons";
import { parseProviderSignInOutput, type ProviderSignInOutput } from "~/lib/providerSignInOutput";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";

import TerminalViewport from "../../terminal/TerminalViewport";
import type { TerminalRuntimeStatus } from "../../terminal/terminalRuntimeTypes";
import { disposeAndCloseTerminalSession } from "../../terminal/terminalSession";
import { Button } from "../../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../../ui/dialog";

const ignoreMetadata = () => {};

/** A browser login that has not come back after this long is treated as stuck. */
const STALLED_AFTER_SECONDS = 120;
/** Safety net beside the login's own exit: some logins stay open after approval. */
const STATUS_POLL_MS = 6_000;
/** How long the connected state stays up before a guided flow closes itself. */
const CONNECTED_CLOSE_MS = 2_500;
/** Login output is a few lines; the cap only bounds a login that repaints forever. */
const OUTPUT_BUFFER_CHARACTERS = 64 * 1024;

const NO_OUTPUT: ProviderSignInOutput = { url: null, asksForCode: false };

type SignInPhase = "waiting" | "connected" | "stalled" | "ended" | "unverified" | "failed";
type AuthCheck = "unchecked" | "authenticated" | "unauthenticated" | "unavailable" | "unknown";

interface ProviderSignInDialogProps {
  provider: ProviderKind;
  instanceId: string;
  accountLabel: string;
  /** Close as soon as the account is confirmed signed in (guided flows outside Settings). */
  closeWhenAuthenticated?: boolean;
  onClose: () => void;
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function ProviderSignInDialog(props: ProviderSignInDialogProps) {
  // Each attempt owns one login session; "Try again" swaps in a fresh one.
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef<(() => Promise<void>) | null>(null);
  const interactive = PROVIDER_AUTHENTICATION[props.provider].flow === "interactive";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void closeRef.current?.();
      }}
    >
      <DialogPopup
        // A login that asks its questions in the terminal needs room to show them.
        className={cn("gap-0 overflow-hidden p-0", interactive ? "max-w-2xl" : "max-w-[440px]")}
        showCloseButton={false}
      >
        <ProviderSignInAttempt
          key={attempt}
          {...props}
          closeRef={closeRef}
          onRetry={() => setAttempt((current) => current + 1)}
        />
      </DialogPopup>
    </Dialog>
  );
}

function ProviderSignInAttempt(
  props: ProviderSignInDialogProps & {
    closeRef: RefObject<(() => Promise<void>) | null>;
    onRetry: () => void;
  },
) {
  const { t } = useTranslation();
  const { provider, instanceId, accountLabel, closeWhenAuthenticated } = props;

  const [session] = useState(() => ({
    threadId: ThreadId.makeUnsafe(`provider-auth-${crypto.randomUUID()}`),
    terminalId: "sign-in",
  }));
  const config = useQuery(serverConfigQueryOptions());
  const queryClient = useQueryClient();
  const refresh = useRefreshProviderStatusesNow();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const method = PROVIDER_AUTHENTICATION[provider];
  const interactive = method.flow === "interactive";
  const interactiveCommand = "interactiveCommand" in method ? method.interactiveCommand : null;

  const [runtimeStatus, setRuntimeStatus] = useState<TerminalRuntimeStatus>("connecting");
  const [output, setOutput] = useState<ProviderSignInOutput>(NO_OUTPUT);
  const [authCheck, setAuthCheck] = useState<AuthCheck>("unchecked");
  const [account, setAccount] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [exited, setExited] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(interactive);
  const [code, setCode] = useState("");
  const [optionsSent, setOptionsSent] = useState(false);
  const [closing, setClosing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [statusProblem, setStatusProblem] = useState<string | null>(null);
  const closingRef = useRef(false);
  const alive = useRef(true);
  const checkInFlight = useRef<Promise<void> | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  // Read the login's output as it streams, independently of the terminal that draws it.
  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let buffer = "";
    const read = (chunk: string) => {
      buffer = (buffer + chunk).slice(-OUTPUT_BUFFER_CHARACTERS);
      const next = parseProviderSignInOutput(buffer);
      // Keep the first link through repaints, but extend it when another PTY chunk completes it.
      setOutput((previous) => {
        const url =
          previous.url === null || next.url?.startsWith(previous.url) ? next.url : previous.url;
        const asksForCode = previous.asksForCode || next.asksForCode;
        return url === previous.url && asksForCode === previous.asksForCode
          ? previous
          : { url, asksForCode };
      });
    };
    return api.terminal.onEvent((event) => {
      if (event.threadId !== session.threadId || event.terminalId !== session.terminalId) return;
      if (event.type === "output") read(event.data);
      else if (event.type === "started" || event.type === "restarted") read(event.snapshot.history);
    });
  }, [session]);

  const checkStatus = useCallback(() => {
    if (checkInFlight.current) return checkInFlight.current;
    setChecking(true);
    const check = (async () => {
      const statuses = await refreshRef.current({ silent: true });
      if (!alive.current) return;
      const status = statuses?.find((entry) => (entry.instanceId ?? entry.provider) === instanceId);
      // An account can be signed in and still have no usable models.
      if (status?.authStatus === "authenticated" && !status.available) {
        setAuthCheck("unavailable");
        setStatusProblem(status.unavailableReason ?? status.message ?? null);
      } else {
        setAuthCheck(status?.authStatus ?? "unknown");
        setStatusProblem(null);
        if (status?.authStatus === "authenticated") setAccount(status.accountEmail ?? null);
      }
      // Native account preparation can save its isolated roots server-side.
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.allProviderUsage() });
    })().finally(() => {
      checkInFlight.current = null;
      if (alive.current) setChecking(false);
    });
    checkInFlight.current = check;
    return check;
  }, [instanceId, queryClient]);

  const finishSignIn = async () => {
    // A request started before the CLI exited may have read the old credentials.
    await checkInFlight.current;
    if (!alive.current || closingRef.current) return;
    await checkStatus();
    if (alive.current) setExited(true);
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Strict Mode replays setup/cleanup without closing the window. Allow
      // that synchronous setup to reclaim ownership before disposing the PTY.
      queueMicrotask(() => {
        if (alive.current) return;
        void disposeAndCloseTerminalSession({
          api: readNativeApi(),
          ...session,
          requireStructuredClose: true,
        })
          .catch(() => undefined)
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
            void queryClient.invalidateQueries({ queryKey: serverQueryKeys.allProviderUsage() });
            void refreshRef.current({ silent: true });
          });
      });
    };
  }, [session, queryClient]);

  const authenticated = authCheck === "authenticated";
  const running = runtimeStatus === "ready" && !exited && !authenticated;
  const stalled = !interactive && elapsed >= STALLED_AFTER_SECONDS;
  const phase: SignInPhase = authenticated
    ? "connected"
    : runtimeStatus === "error"
      ? "failed"
      : exited
        ? authCheck === "unknown"
          ? "unverified"
          : "ended"
        : stalled
          ? "stalled"
          : "waiting";

  // The clock and the safety-net check only run while the login is live.
  useEffect(() => {
    if (!running) return;
    const clock = window.setInterval(() => setElapsed((seconds) => seconds + 1), 1_000);
    const poll = window.setInterval(() => void checkStatus(), STATUS_POLL_MS);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
  }, [checkStatus, running]);

  // Anything that did not end in a connected account owes the user the raw output.
  useEffect(() => {
    if (phase === "stalled" || phase === "ended" || phase === "failed") setDetailsOpen(true);
  }, [phase]);

  const { onClose } = props;
  const close = async (retry = false) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    try {
      await disposeAndCloseTerminalSession({
        api: readNativeApi(),
        ...session,
        requireStructuredClose: true,
      });
      await queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      if (alive.current) {
        if (retry) props.onRetry();
        else onClose();
      }
    } catch (error) {
      if (alive.current) {
        setProblem(error instanceof Error ? error.message : t("settings:signInFlow_unableToClose"));
      }
    } finally {
      closingRef.current = false;
      if (alive.current) setClosing(false);
    }
  };
  const closeLatest = useRef(close);
  closeLatest.current = close;
  // The dialog shell closes through whichever attempt is mounted.
  const { closeRef } = props;
  useEffect(() => {
    closeRef.current = () => closeLatest.current();
    return () => {
      closeRef.current = null;
    };
  }, [closeRef]);

  useEffect(() => {
    if (!authenticated || !closeWhenAuthenticated) return;
    const timer = window.setTimeout(() => void closeLatest.current(), CONNECTED_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [authenticated, closeWhenAuthenticated]);

  const sendToLogin = async (data: string): Promise<boolean> => {
    try {
      await ensureNativeApi().terminal.write({ ...session, data });
      return true;
    } catch (error) {
      if (alive.current) {
        setProblem(error instanceof Error ? error.message : t("settings:signInFlow_unableToSend"));
      }
      return false;
    }
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (value.length === 0) return;
    setCode("");
    void sendToLogin(`${value}\r`).then((sent) => {
      if (sent) void checkStatus();
    });
  };

  const showSignInOptions = () => {
    if (!interactiveCommand || optionsSent) return;
    setOptionsSent(true);
    void sendToLogin(`${interactiveCommand}\r`).then((sent) => {
      if (!sent && alive.current) setOptionsSent(false);
    });
  };

  const openLink = () => {
    if (!output.url) return;
    void ensureNativeApi()
      .shell.openExternal(output.url)
      .catch(() => undefined);
  };

  const title = {
    waiting: interactive
      ? t("settings:signInFlow_titleInteractive", { provider: accountLabel })
      : t("settings:signInFlow_titleBrowser", { provider: accountLabel }),
    connected: t("settings:signInFlow_titleConnected", { provider: accountLabel }),
    stalled: t("settings:signInFlow_titleStalled", { provider: accountLabel }),
    ended: t("settings:signInFlow_titleEnded"),
    unverified: t("settings:signInFlow_titleUnverified", { provider: accountLabel }),
    failed: t("settings:signInFlow_titleFailed"),
  }[phase];
  const body = {
    waiting: interactive ? method.instructions : t("settings:signInFlow_bodyBrowser"),
    connected: account
      ? t("settings:signInFlow_bodyConnectedAs", { account, provider: accountLabel })
      : t("settings:signInFlow_bodyConnected", { provider: accountLabel }),
    stalled: t("settings:signInFlow_bodyStalled"),
    ended: t("settings:signInFlow_bodyEnded", { provider: accountLabel }),
    unverified: t("settings:signInFlow_bodyUnverified", { provider: accountLabel }),
    failed: t("settings:signInFlow_bodyFailed", { provider: accountLabel }),
  }[phase];
  const linkTone =
    phase === "connected"
      ? "bg-success"
      : phase === "waiting"
        ? "bg-info motion-safe:animate-pulse"
        : "bg-warning";

  const started = runtimeStatus !== "connecting";
  const waitingStep =
    phase === "waiting"
      ? checking && exited
        ? t("settings:signInFlow_stepChecking")
        : interactive
          ? t("settings:signInFlow_stepWaitingPrompts")
          : t("settings:signInFlow_stepWaitingBrowser")
      : phase === "stalled"
        ? t("settings:signInFlow_stepNoApproval")
        : t("settings:signInFlow_stepNotConnected");

  return (
    <>
      <div className="flex flex-col items-center gap-2 px-8 pt-9 pb-7 text-center">
        <div aria-hidden className="mb-4 flex items-center gap-2.5">
          <span className={LINK_TILE_CLASS_NAME}>
            <ProviderIcon provider={provider} className="size-7" />
          </span>
          <span className="flex items-center gap-1.5">
            {[0, 1, 2, 3, 4].map((dot) => (
              <span
                key={dot}
                className={cn(
                  "rounded-full",
                  phase === "connected"
                    ? "size-1 bg-success"
                    : dot === 2
                      ? cn("size-1.5", linkTone)
                      : "size-1 bg-foreground/20",
                )}
              />
            ))}
          </span>
          <span className={LINK_TILE_CLASS_NAME}>
            <img src="/app-icons/dark.png" alt="" className="size-9" draggable={false} />
          </span>
        </div>
        <DialogTitle className="text-xl leading-7 font-semibold tracking-[-0.02em] text-balance">
          {title}
        </DialogTitle>
        <DialogDescription className="max-w-[360px] text-ui leading-relaxed text-pretty">
          {body}
        </DialogDescription>
      </div>

      {phase === "connected" ? (
        <div className="flex flex-col items-center gap-3 px-8 pb-7">
          <Button className="w-full" size="lg" disabled={closing} onClick={() => void close()}>
            {t("git:detail_done")}
          </Button>
          {closeWhenAuthenticated ? (
            <span className="text-ui-sm text-muted-foreground">
              {t("settings:signInFlow_closesItself")}
            </span>
          ) : null}
        </div>
      ) : (
        <>
          <ol className="flex flex-col border-t border-foreground/8 px-8">
            <SignInStep state={started ? "done" : "current"}>
              <span className="flex-1 truncate">
                {output.url
                  ? t("settings:signInFlow_stepBrowserOpened")
                  : started
                    ? t("settings:signInFlow_stepStarted")
                    : t("settings:signInFlow_stepStarting")}
              </span>
              {output.url ? (
                <>
                  <button type="button" className={STEP_LINK_CLASS_NAME} onClick={openLink}>
                    {t("settings:signInFlow_openAgain")}
                  </button>
                  <button
                    type="button"
                    className={cn(STEP_LINK_CLASS_NAME, "text-muted-foreground")}
                    onClick={() => output.url && copyToClipboard(output.url, undefined)}
                  >
                    {isCopied
                      ? t("settings:signInFlow_linkCopied")
                      : t("settings:signInFlow_copyLink")}
                  </button>
                </>
              ) : null}
            </SignInStep>
            <SignInStep
              state={!started ? "upcoming" : phase === "waiting" ? "current" : "warning"}
              index={2}
            >
              <span className="flex-1 truncate">{waitingStep}</span>
              {running ? (
                <span className="text-ui-sm text-muted-foreground tabular-nums">
                  {formatElapsed(elapsed)}
                </span>
              ) : null}
            </SignInStep>
            <SignInStep state="upcoming" index={3}>
              <span className="flex-1 truncate">
                {t("settings:signInFlow_stepReady", { provider: accountLabel })}
              </span>
            </SignInStep>
          </ol>

          {output.asksForCode && !exited ? (
            <form
              onSubmit={submitCode}
              className="flex flex-col gap-2 border-t border-foreground/8 bg-foreground/[0.02] px-8 pt-4 pb-5"
            >
              <label htmlFor="provider-sign-in-code" className="text-ui-sm text-foreground/80">
                {t("settings:signInFlow_codeLabel")}
              </label>
              <span className="flex gap-2">
                <Input
                  id="provider-sign-in-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder={t("settings:signInFlow_codePlaceholder")}
                  className="min-w-0 flex-1 font-mono"
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  autoComplete="off"
                />
                <Button type="submit" variant="outline" disabled={code.trim().length === 0}>
                  {t("git:continue")}
                </Button>
              </span>
            </form>
          ) : null}

          {phase !== "waiting" ? (
            <div className="flex gap-2 border-t border-foreground/8 px-8 py-4">
              {phase === "unverified" ? (
                <Button className="flex-1" disabled={closing} onClick={() => void close()}>
                  {t("git:detail_done")}
                </Button>
              ) : null}
              <Button
                className="flex-1"
                variant={phase === "unverified" ? "outline" : "default"}
                disabled={closing}
                onClick={() => void close(true)}
              >
                {t("settings:signInFlow_tryAgain")}
              </Button>
              {phase === "unverified" ? null : (
                <Button
                  className="flex-1"
                  variant="outline"
                  disabled={closing}
                  onClick={() => void close()}
                >
                  {t("common:form_cancel")}
                </Button>
              )}
            </div>
          ) : null}
        </>
      )}

      {problem || statusProblem ? (
        <p
          role="alert"
          className="border-t border-foreground/8 px-8 py-3 text-ui-sm text-destructive"
        >
          {problem ?? statusProblem}
        </p>
      ) : null}

      {/* The terminal is the login itself, so it stays mounted while collapsed. */}
      <div
        className={cn(
          "flex items-center justify-between gap-3 border-t border-foreground/8 px-8 py-3",
          phase === "connected" && "hidden",
        )}
      >
        <button
          type="button"
          aria-expanded={detailsOpen}
          className="cursor-pointer text-ui-sm text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen
            ? t("settings:signInFlow_hideDetails")
            : t("settings:signInFlow_showDetails")}
        </button>
        <span className="flex items-center gap-2">
          {interactiveCommand ? (
            <Button
              size="sm"
              variant="outline"
              disabled={runtimeStatus !== "ready" || optionsSent || closing}
              onClick={showSignInOptions}
            >
              {t("settings:signInOptions")}
            </Button>
          ) : null}
          {phase === "waiting" ? (
            <Button size="sm" variant="ghost" disabled={closing} onClick={() => void close()}>
              {closing ? t("settings:closing") : t("common:form_cancel")}
            </Button>
          ) : null}
        </span>
      </div>
      <DisclosureRegion open={detailsOpen && phase !== "connected"}>
        <div className="flex flex-col gap-2 px-8 pb-6">
          <p className="text-ui-xs text-muted-foreground">
            {t("settings:thisRunsOnTheSynaraServerMachineForThe")}
          </p>
          <div
            className={cn(
              "overflow-hidden rounded-xl border border-border bg-background",
              interactive ? "h-80" : "h-52",
            )}
          >
            {config.data?.cwd ? (
              <TerminalViewport
                {...session}
                cwd={config.data.cwd}
                providerAuthInstanceId={instanceId}
                terminalLabel={`Sign in · ${accountLabel}`}
                onSessionExited={() => void finishSignIn()}
                onRuntimeStatusChange={setRuntimeStatus}
                onTerminalMetadataChange={ignoreMetadata}
                onTerminalActivityChange={ignoreMetadata}
                focusRequestId={0}
                autoFocus={interactive}
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
        </div>
      </DisclosureRegion>
    </>
  );
}

const LINK_TILE_CLASS_NAME =
  "flex size-14 items-center justify-center rounded-2xl border border-foreground/10 bg-foreground/[0.04]";

const STEP_LINK_CLASS_NAME =
  "shrink-0 cursor-pointer text-ui-sm text-info-foreground transition-opacity hover:opacity-75 motion-reduce:transition-none";

/** One row of the sign-in checklist: its state mark, then the row's own content. */
function SignInStep(props: {
  readonly state: "done" | "current" | "warning" | "upcoming";
  /** Shown in the mark while the step is still ahead. */
  readonly index?: number;
  readonly children: ReactNode;
}) {
  const { state } = props;
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className={cn(
        "flex h-13 items-center gap-3 border-foreground/8 text-ui not-first:border-t",
        state === "upcoming" && "text-muted-foreground",
        state === "done" && "text-foreground/80",
        state === "current" && "font-medium text-foreground",
        state === "warning" && "font-medium text-warning",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-5.5 shrink-0 items-center justify-center rounded-full text-ui-xs",
          state === "done" && "bg-success/15 text-success",
          state === "warning" && "border-2 border-warning/60",
          state === "upcoming" && "border border-foreground/20 font-normal",
        )}
      >
        {state === "done" ? <CheckIcon className="size-3" /> : null}
        {state === "current" ? <Spinner aria-hidden className="size-4 text-info" /> : null}
        {state === "upcoming" ? props.index : null}
      </span>
      {props.children}
    </li>
  );
}
