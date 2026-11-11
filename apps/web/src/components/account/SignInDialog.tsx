// FILE: SignInDialog.tsx
// Purpose: "Sign in to Synara" modal — provider SSO through the
// system browser (authorization code + PKCE with a loopback redirect,
// server-brokered, deep-linked to Google/Apple/GitHub) and in-app email OTP:
// the user enters their email, receives a 6-digit code, and enters it in the
// same dialog. Sign-in and sign-up are one path. Dismissable; a successful
// sign-in with no profile hands off to the onboarding modal.
// `SignInPanel` is the same flow without the dialog chrome, embedded by the
// first-run onboarding.
// Layer: Web account feature.

import type { AccountSsoProvider, AccountStatus } from "@synara/contracts";
import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import { SiApple, SiGithub, SiGoogle } from "react-icons/si";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Kbd } from "~/components/ui/kbd";
import { Spinner } from "~/components/ui/spinner";
import { SynaraLogo } from "@synara/profile-ui/logo";
import { useAccount } from "~/hooks/useAccount";
import { useNowMs } from "~/hooks/useNowMs";
import {
  accountErrorMessage,
  formatResendCountdown,
  isSignInCancellation,
  readAccountErrorCode,
  RESEND_COOLDOWN_SECONDS,
  sanitizeVerificationCodeInput,
  VERIFICATION_CODE_LENGTH,
} from "~/lib/accountLogic";
import { cn } from "~/lib/utils";
import { SIGN_IN_ACCENT_CLASS_NAME, SignInOrbit } from "./SignInOrbit";

interface SignInDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called with the fresh status after any successful auth; decides onboarding vs close. */
  readonly onSignedIn: (status: AccountStatus) => void;
}

export function SignInDialog({ open, onOpenChange, onSignedIn }: SignInDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* "Not now" and Escape close it, so the corner X would be a third way out. */}
      <DialogPopup showCloseButton={false} className="overflow-hidden sm:max-w-[400px]">
        {/* The popup clips to its rounded corners; this layer scrolls when a short
            window cannot fit the whole dialog. State lives below DialogPopup,
            which unmounts on close, so every open starts from a clean form. */}
        <div className="min-h-0 overflow-y-auto">
          <SignInPanel onDismiss={() => onOpenChange(false)} onSignedIn={onSignedIn} />
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/** The waiting state of a PKCE attempt: which one, for the cancel RPC. */
type SsoWait = { readonly ssoId: string };

/** `dialog` is the standalone sign-in modal; `embedded` sits inside a host surface's card. */
type SignInPanelVariant = "dialog" | "embedded";

interface SignInPanelProps {
  /** Called with the fresh status after any successful auth. */
  readonly onSignedIn: (status: AccountStatus) => void;
  /** Shown as "Not now" in the dialog variant. */
  readonly onDismiss?: () => void;
  readonly variant?: SignInPanelVariant;
}

/** The title registers with the dialog only when the panel is the dialog. */
function SignInPanelTitle(props: { variant: SignInPanelVariant; children: React.ReactNode }) {
  return props.variant === "dialog" ? (
    <DialogTitle className="font-system-ui text-[22px] leading-7 font-semibold tracking-[-0.02em]">
      {props.children}
    </DialogTitle>
  ) : (
    <h3 className="text-ui-lg font-medium text-foreground">{props.children}</h3>
  );
}

/** The SSO providers in dialog order; each button's accessible name says what it does. */
const SSO_BUTTONS: readonly {
  readonly provider: AccountSsoProvider;
  readonly label: string;
  readonly Icon: ComponentType<{ className?: string }>;
}[] = [
  { provider: "apple", label: "Apple", Icon: SiApple },
  { provider: "google", label: "Google", Icon: SiGoogle },
  { provider: "github", label: "GitHub", Icon: SiGithub },
];

/** "Not now" plus the Escape key that does the same, shared by both dialog steps. */
function DismissRow(props: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      className="flex items-center gap-2 self-center text-ui-sm text-muted-foreground hover:text-foreground"
      onClick={props.onDismiss}
    >
      Not now
      <Kbd aria-hidden className="h-5 bg-foreground/6 px-1.5 font-normal text-ui-xs">
        esc
      </Kbd>
    </button>
  );
}

export function SignInPanel({ onSignedIn, onDismiss, variant = "dialog" }: SignInPanelProps) {
  const embedded = variant === "embedded";
  const account = useAccount();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Whether `error` came from a provider sign-in rather than the email field.
  // The dialog shows a provider failure under the provider row and leaves the
  // email field valid; the embedded card keeps its single error slot.
  const [errorFromSso, setErrorFromSso] = useState(false);
  // Stable id linking the email input to its error text for assistive tech.
  const emailErrorId = useId();
  const [ssoWait, setSsoWait] = useState<SsoWait | null>(null);
  // The OTP code-entry step, entered once a code was sent. Only the address
  // is held — the code lives in the step's own state and dies with it.
  const [otpEmail, setOtpEmail] = useState<string | null>(null);
  // Abandoning the dialog mid-SSO aborts the pending completeSso RPC so it
  // does not resolve into a closed dialog later, and tells the server to
  // drop the attempt (closing its loopback listener).
  const ssoAbortRef = useRef<AbortController | null>(null);
  const ssoIdRef = useRef<string | null>(null);
  const cancelSso = account.cancelSso;
  // Ref'd for the unmount cleanup below: keying the effect on the function
  // itself would rerun the cleanup — and cancel a LIVE attempt — whenever
  // its identity moved, so the effect stays empty-dep and reads through here.
  const cancelSsoRef = useRef(cancelSso);
  cancelSsoRef.current = cancelSso;

  // Abort on EVERY way out of the dialog, not only the visible "Stop
  // waiting" control: this content unmounts on outer close, Escape, and
  // "Not now", so the cleanup is the one place that
  // covers them all. An explicit user close is a cancellation of the client
  // request AND of the server-side attempt; server-side completion tolerance
  // stays only for genuine transport loss (reconnect recovery via the
  // status query). Unmount-only on purpose: a rerender (mutation state
  // settling, the waiting spinner appearing) must never cancel a live
  // attempt, so the dependency array stays empty.
  useEffect(() => {
    return () => {
      ssoAbortRef.current?.abort();
      const ssoId = ssoIdRef.current;
      if (ssoId) void cancelSsoRef.current(ssoId).catch(() => {});
    };
  }, []);

  const busy = account.sendOtp.isPending || account.beginSso.isPending || ssoWait !== null;

  /**
   * A sign-in error must never outrank a sign-in that actually happened: a
   * slow provider can push the grant past a timeout while the session still
   * lands on disk (the server already re-checks, but the RPC itself can be
   * the leg that failed). Before showing any sign-in error, re-ask the
   * authoritative status — signed-in means advance, not apologize.
   */
  const signedInDespiteError = async (): Promise<boolean> => {
    try {
      const { data } = await account.statusQuery.refetch();
      if (data?.state === "signed-in") {
        onSignedIn(data);
        return true;
      }
    } catch {
      // Unknowable status changes nothing; the original error stands.
    }
    return false;
  };

  const handleSso = async (provider: AccountSsoProvider) => {
    setError(null);
    // Held locally so the guard below cannot be weakened by the `finally`
    // (or a newer attempt) nulling the shared ref before the catch reads it.
    let controller: AbortController | null = null;
    try {
      const begin = await account.beginSso.mutateAsync({ provider });
      ssoIdRef.current = begin.ssoId;
      await account.openVerificationUrl(begin.authorizeUrl);
      setSsoWait({ ssoId: begin.ssoId });
      controller = new AbortController();
      ssoAbortRef.current = controller;
      const status = await account.completeSso.mutateAsync({
        ssoId: begin.ssoId,
        signal: controller.signal,
      });
      ssoIdRef.current = null;
      onSignedIn(status);
    } catch (cause) {
      // The user's own abort ("Stop waiting", closing the dialog) is a
      // decision, not an outcome — swallow it entirely.
      if (controller?.signal.aborted) return;
      // Any failure may hide a success (a slow provider, an interrupted RPC
      // whose sign-in still landed): the authoritative status decides first.
      if (await signedInDespiteError()) {
        ssoIdRef.current = null;
        return;
      }
      setSsoWait(null);
      // A server-side interruption (reconnect, superseded request) with a
      // genuinely signed-out outcome resets to the buttons with plain copy —
      // never the runtime's own interrupt vocabulary.
      setErrorFromSso(true);
      setError(
        isSignInCancellation(cause)
          ? "Sign-in was interrupted. Try again."
          : accountErrorMessage(cause, "Sign-in did not finish. Try again."),
      );
    } finally {
      if (ssoAbortRef.current === controller) ssoAbortRef.current = null;
    }
  };

  /**
   * Sends the code, surviving one transport interruption.
   *
   * A WebSocket reconnect (a stream restart, a dropped socket) interrupts every
   * request in flight on the old runtime, and a one-shot user-initiated call
   * has no natural retry the way a poll does. Sending a code is idempotent from
   * the user's side — a second code supersedes the first — so a single retry on
   * the reconnected transport turns an unavoidable dead end into a no-op.
   * Only interruptions are retried: a real refusal (rate limit, bad address)
   * must surface immediately rather than being sent twice.
   */
  const sendOtpResilient = async (trimmedEmail: string) => {
    try {
      return await account.sendOtp.mutateAsync({ email: trimmedEmail });
    } catch (cause) {
      if (!isSignInCancellation(cause)) throw cause;
      return await account.sendOtp.mutateAsync({ email: trimmedEmail });
    }
  };

  const handleEmailSubmit = async () => {
    setError(null);
    setErrorFromSso(false);
    const trimmed = email.trim();
    if (trimmed.length === 0) {
      setError("Enter your email.");
      return;
    }
    try {
      const sent = await sendOtpResilient(trimmed);
      setOtpEmail(sent.email);
    } catch (cause) {
      // A transport interruption is not an outcome: the socket was torn down
      // (a stream restart, a reconnect) while this one-shot request was in
      // flight. Say so plainly rather than claiming the send failed, since the
      // provider may well have sent the code.
      setError(
        isSignInCancellation(cause)
          ? "The connection restarted. Try again."
          : accountErrorMessage(cause, "Could not send the code. Try again."),
      );
    }
  };

  if (otpEmail) {
    const codeEntryProps: CodeEntryStepProps = {
      email: otpEmail,
      submitting: account.authenticateOtp.isPending,
      resending: account.sendOtp.isPending,
      onSubmit: async (code) => {
        try {
          const status = await account.authenticateOtp.mutateAsync({ email: otpEmail, code });
          onSignedIn(status);
        } catch (cause) {
          // Any failure keeps the step open with its inline error — unless
          // the session actually landed despite the error, in which case
          // advancing is the only honest outcome.
          if (await signedInDespiteError()) return;
          throw cause;
        }
      },
      onResend: async () => {
        await account.sendOtp.mutateAsync({ email: otpEmail });
      },
      onUseDifferentEmail: () => {
        setOtpEmail(null);
        setError(null);
      },
    };
    return embedded ? (
      <CodeEntryStep {...codeEntryProps} />
    ) : (
      <DialogCodeEntryStep {...codeEntryProps} onDismiss={onDismiss} />
    );
  }

  const ssoWaiting = ssoWait ? (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <div className="flex items-center gap-2 text-ui text-muted-foreground">
        <Spinner className="size-3.5" />
        <span>Waiting for your browser…</span>
      </div>
      <p className="text-ui-sm text-muted-foreground">
        Finish signing in with your provider, then return here.
      </p>
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        onClick={() => {
          ssoAbortRef.current?.abort();
          const ssoId = ssoIdRef.current;
          ssoIdRef.current = null;
          if (ssoId) void cancelSso(ssoId).catch(() => {});
          setSsoWait(null);
        }}
      >
        Stop waiting
      </Button>
      <p className="text-ui-sm text-muted-foreground">
        A page you already approved may still finish signing in.
      </p>
    </div>
  ) : null;

  const emailError = error ? (
    <p id={emailErrorId} role="alert" className="text-ui-sm leading-snug text-destructive">
      {error}
    </p>
  ) : null;

  if (embedded) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5 pb-1">
          <img src="/app-icons/dark.png" alt="" className="size-7 shrink-0" draggable={false} />
          <SignInPanelTitle variant={variant}>Sign in to Synara</SignInPanelTitle>
        </div>
        {ssoWaiting ?? (
          <>
            {/* Each provider button carries its provider through the PKCE authorize
                URL, so the browser lands on that provider's sign-in. */}
            <Button
              size="lg"
              shape="capsule"
              className="w-full gap-2"
              disabled={busy}
              onClick={() => void handleSso("apple")}
            >
              <SiApple className="size-3.5" />
              Continue with Apple
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="lg"
                shape="capsule"
                variant="outline"
                className="gap-2"
                disabled={busy}
                onClick={() => void handleSso("google")}
              >
                <SiGoogle className="size-3.5" />
                Google
              </Button>
              <Button
                size="lg"
                shape="capsule"
                variant="outline"
                className="gap-2"
                disabled={busy}
                onClick={() => void handleSso("github")}
              >
                <SiGithub className="size-3.5" />
                GitHub
              </Button>
            </div>
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void handleEmailSubmit();
              }}
            >
              <InputGroup className="h-10 rounded-full ps-1.5 pe-1 sm:h-9">
                <InputGroupInput
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  aria-label="Email"
                  value={email}
                  disabled={busy}
                  aria-invalid={error !== null || undefined}
                  aria-describedby={error !== null ? emailErrorId : undefined}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <Button type="submit" size="xs" shape="capsule" variant="subtle" disabled={busy}>
                    {account.sendOtp.isPending ? <Spinner className="size-3" /> : null}
                    Send code
                  </Button>
                </InputGroupAddon>
              </InputGroup>
              {emailError}
            </form>
          </>
        )}
      </div>
    );
  }

  // Only an email-step failure marks the email field invalid.
  const emailFieldError = error !== null && !errorFromSso;

  return (
    <div className={cn("flex flex-col", SIGN_IN_ACCENT_CLASS_NAME)}>
      <SignInOrbit />
      <div className="flex flex-col gap-4 px-6 pb-5">
        <div className="flex flex-col items-center gap-1.5 pb-1 text-center">
          <SignInPanelTitle variant={variant}>Sign in to Synara</SignInPanelTitle>
          <p className="text-ui leading-snug text-muted-foreground">
            Your profile and workspace, on every device.
          </p>
        </div>

        {ssoWaiting ?? (
          <>
            {/* Email first: it holds initial focus, so a returning user types and
                presses Return without reaching for the mouse. */}
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void handleEmailSubmit();
              }}
            >
              {/* The focus variant is spelled exactly as InputGroup's own grey focus
                  border so cn() replaces it; any other spelling loses the cascade. */}
              <InputGroup className="h-12 rounded-[14px] ps-1.5 pe-1.5 has-[input:focus-visible,textarea:focus-visible]:border-[var(--sign-in-accent)] has-[input:focus-visible,textarea:focus-visible]:ring-4 has-[input:focus-visible,textarea:focus-visible]:ring-[var(--sign-in-accent)]/15">
                <InputGroupInput
                  type="email"
                  autoComplete="email"
                  placeholder="Email address"
                  aria-label="Email"
                  className="caret-[var(--sign-in-accent)]"
                  value={email}
                  // Read-only, not disabled, while busy: a disabled field drops
                  // focus, and a failed send must leave the user typing.
                  readOnly={busy}
                  aria-invalid={emailFieldError || undefined}
                  aria-describedby={emailFieldError ? emailErrorId : undefined}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <Button
                    type="submit"
                    className="h-9 gap-2 rounded-[10px] ps-3 pe-2 font-semibold sm:h-9"
                    disabled={busy}
                  >
                    {account.sendOtp.isPending ? <Spinner className="size-3.5" /> : null}
                    Send code
                    <Kbd
                      aria-hidden
                      className="h-5 bg-primary-foreground/12 px-1.5 text-ui-xs text-primary-foreground/70"
                    >
                      ↵
                    </Kbd>
                  </Button>
                </InputGroupAddon>
              </InputGroup>
              {emailFieldError ? emailError : null}
            </form>

            {/* Per-provider buttons, honestly: each one carries its provider
                through the PKCE authorize URL, so the browser genuinely lands
                on that provider's sign-in — the deep link the device grant
                could never transmit. */}
            {/* Three across needs ~100px a button; phone-width popups stack them. */}
            <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-3">
              {SSO_BUTTONS.map(({ provider, label, Icon }) => (
                <Button
                  key={provider}
                  variant="outline"
                  size="lg"
                  aria-label={`Continue with ${label}`}
                  className="h-10.5 rounded-xl bg-foreground/3 sm:h-10.5"
                  disabled={busy}
                  onClick={() => void handleSso(provider)}
                >
                  <Icon className="size-3.5" />
                  {label}
                </Button>
              ))}
            </div>
            {errorFromSso ? emailError : null}
          </>
        )}

        {onDismiss ? <DismissRow onDismiss={onDismiss} /> : null}
      </div>
    </div>
  );
}

interface CodeEntryStepProps {
  /** The address the code was sent to, shown in the subtitle. */
  readonly email: string;
  readonly submitting: boolean;
  readonly resending: boolean;
  /** Redeems the 6 digits. Throws to keep the step open with an inline error. */
  readonly onSubmit: (code: string) => Promise<void>;
  /** Emails a fresh code, invalidating the old one. */
  readonly onResend: () => Promise<void>;
  readonly onUseDifferentEmail: () => void;
}

/**
 * The state behind every emailed 6-digit code entry — the code, its inline
 * error, the resend cooldown — shared by the dialog and embedded steps so the
 * two never drift in how a code is redeemed, rejected, or resent.
 */
function useCodeEntry({
  submitting,
  resending,
  onSubmit,
  onResend,
}: Pick<CodeEntryStepProps, "submitting" | "resending" | "onSubmit" | "onResend">) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Stable id linking the input to its error text for assistive tech.
  const errorId = useId();
  // Flipped by a successful resend, back off on the next countdown render
  // tick after a few seconds; the subtitle swap the design asks for.
  const [resent, setResent] = useState(false);
  const [resendAvailableAtMs, setResendAvailableAtMs] = useState(
    () => Date.now() + RESEND_COOLDOWN_SECONDS * 1000,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards the auto-submit: six digits may sit unchanged across re-renders,
  // and one entry must submit once.
  const submittedCodeRef = useRef<string | null>(null);

  const nowMs = useNowMs(true);
  const cooldownSecondsLeft = Math.max(0, (resendAvailableAtMs - nowMs) / 1000);
  const resendDisabled = cooldownSecondsLeft > 0 || resending;
  const complete = code.length === VERIFICATION_CODE_LENGTH;
  // The active box is where the next digit lands; while full, the last box.
  const activeIndex = Math.min(code.length, VERIFICATION_CODE_LENGTH - 1);

  const submit = async (candidate: string) => {
    if (candidate.length !== VERIFICATION_CODE_LENGTH || submitting) return;
    if (submittedCodeRef.current === candidate) return;
    submittedCodeRef.current = candidate;
    setError(null);
    try {
      await onSubmit(candidate);
    } catch (cause) {
      submittedCodeRef.current = null;
      setCode("");
      inputRef.current?.focus();
      setError(
        readAccountErrorCode(cause) === "invalid_verification_code"
          ? "That code didn't work — try again or resend"
          : accountErrorMessage(cause, "Could not sign you in. Try again."),
      );
    }
  };

  const handleCodeChange = (raw: string) => {
    const next = sanitizeVerificationCodeInput(raw);
    setCode(next);
    if (next.length === VERIFICATION_CODE_LENGTH) void submit(next);
  };

  const handleResend = async () => {
    setError(null);
    try {
      await onResend();
      // The old code is dead upstream; a fresh entry avoids submitting it.
      setCode("");
      submittedCodeRef.current = null;
      setResent(true);
      setResendAvailableAtMs(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
      inputRef.current?.focus();
    } catch (cause) {
      setError(accountErrorMessage(cause, "Could not resend the code. Try again in a minute."));
    }
  };

  // "New code sent" reads for a few seconds, then the ordinary subtitle
  // returns while the countdown still runs.
  useEffect(() => {
    if (!resent) return;
    const timeout = window.setTimeout(() => setResent(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [resent]);

  return {
    code,
    error,
    errorId,
    resent,
    inputRef,
    cooldownSecondsLeft,
    resendDisabled,
    complete,
    activeIndex,
    submit,
    handleCodeChange,
    handleResend,
  };
}

type CodeEntry = ReturnType<typeof useCodeEntry>;

/**
 * One visually hidden input holds the whole code — the six cells only render
 * its value — so focus, caret, paste, and `autocomplete="one-time-code"` all
 * behave like the single text field they really are. `boxes` draws six
 * separate boxes; `bar` draws one field split into six cells, three and three.
 */
function CodeInput(props: {
  readonly entry: CodeEntry;
  readonly submitting: boolean;
  readonly appearance: "boxes" | "bar";
}) {
  const { entry, submitting } = props;
  const bar = props.appearance === "bar";
  return (
    // Clicking anywhere on the row focuses the input; the cells are presentation only.
    <label
      className={cn(
        "relative flex cursor-text",
        bar
          ? "h-14 overflow-hidden rounded-[14px] border border-foreground/12 bg-background"
          : "justify-center gap-2",
        bar && entry.error !== null && "border-destructive/60",
        bar && submitting && "opacity-64",
      )}
    >
      <input
        ref={entry.inputRef}
        className="absolute inset-0 h-full w-full cursor-text opacity-0"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={VERIFICATION_CODE_LENGTH}
        value={entry.code}
        // Read-only, not disabled, while a code is checked: a disabled input
        // loses focus, so a wrong code would leave nothing to type into.
        readOnly={submitting}
        aria-busy={submitting || undefined}
        aria-label="Sign-in code"
        aria-invalid={entry.error !== null || undefined}
        aria-describedby={entry.error !== null ? entry.errorId : undefined}
        // The code field is the only thing to type into on this step.
        autoFocus
        onChange={(event) => entry.handleCodeChange(event.target.value)}
      />
      {Array.from({ length: VERIFICATION_CODE_LENGTH }, (_, index) => {
        const active = index === entry.activeIndex && !submitting;
        const digit = entry.code[index];
        return bar ? (
          <span
            // Fixed slots; the position is the identity of a cell.
            key={index}
            aria-hidden
            className={cn(
              "flex flex-1 items-center justify-center border-e font-mono text-ui-xl font-medium last:border-e-0",
              // The wider rule after the third digit splits the code as it is read.
              index === 2 ? "border-foreground/20" : "border-foreground/8",
              active &&
                "bg-[var(--sign-in-accent)]/8 shadow-[inset_0_0_0_1.5px_var(--sign-in-accent)]",
            )}
          >
            {digit ??
              (active ? (
                <span className="h-6 w-px bg-[var(--sign-in-accent)] motion-safe:animate-pulse" />
              ) : null)}
          </span>
        ) : (
          <span
            // Fixed slots; the position is the identity of a box.
            key={index}
            aria-hidden
            className={cn(
              "flex h-[46px] w-10 items-center justify-center rounded-[10px] border bg-background font-mono text-lg font-medium",
              active ? "border-foreground/30" : "border-foreground/12",
              submitting && "opacity-64",
            )}
          >
            {digit ?? ""}
          </span>
        );
      })}
    </label>
  );
}

/** role="alert" announces a wrong code or a failed resend when the cells clear. */
function CodeEntryError(props: { readonly entry: CodeEntry; readonly className?: string }) {
  return props.entry.error ? (
    <p
      id={props.entry.errorId}
      role="alert"
      className={cn("text-ui-sm leading-snug text-destructive", props.className)}
    >
      {props.entry.error}
    </p>
  ) : null;
}

/** The code step of the sign-in dialog: the orbit carries a "code sent" badge. */
function DialogCodeEntryStep({
  email,
  submitting,
  resending,
  onSubmit,
  onResend,
  onUseDifferentEmail,
  onDismiss,
}: CodeEntryStepProps & { readonly onDismiss?: (() => void) | undefined }) {
  const entry = useCodeEntry({ submitting, resending, onSubmit, onResend });
  return (
    <div className={cn("flex flex-col", SIGN_IN_ACCENT_CLASS_NAME)}>
      <SignInOrbit mail />
      <div className="flex flex-col gap-4 px-6 pb-5">
        <div className="flex flex-col items-center gap-1.5 pb-1 text-center">
          <SignInPanelTitle variant="dialog">Check your email</SignInPanelTitle>
          <p className="text-ui leading-snug text-muted-foreground">
            {entry.resent ? "New code sent to " : "Code sent to "}
            <span className="text-foreground">{email}</span>
            {" · "}
            <button
              type="button"
              className="text-[var(--sign-in-accent)] underline-offset-2 hover:underline"
              onClick={onUseDifferentEmail}
            >
              Change email
            </button>
          </p>
        </div>

        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void entry.submit(entry.code);
          }}
        >
          <CodeInput entry={entry} submitting={submitting} appearance="bar" />
          <CodeEntryError entry={entry} />
        </form>

        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-ui-sm text-muted-foreground">
            {submitting ? (
              <>
                <Spinner className="size-3.5" />
                Signing you in…
              </>
            ) : (
              "Paste works too."
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5 rounded-[9px]"
            disabled={entry.resendDisabled}
            onClick={() => void entry.handleResend()}
          >
            Resend
            {entry.cooldownSecondsLeft > 0 ? (
              <span className="font-mono text-ui-xs text-muted-foreground tabular-nums">
                {formatResendCountdown(entry.cooldownSecondsLeft)}
              </span>
            ) : null}
          </Button>
        </div>

        {onDismiss ? <DismissRow onDismiss={onDismiss} /> : null}
      </div>
    </div>
  );
}

/**
 * The six-box code-entry step ("Check your email") of the embedded sign-in
 * card in the first-run onboarding.
 */
function CodeEntryStep({
  email,
  submitting,
  resending,
  onSubmit,
  onResend,
  onUseDifferentEmail,
}: CodeEntryStepProps) {
  const entry = useCodeEntry({ submitting, resending, onSubmit, onResend });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <SynaraLogo className="size-8" />
        <SignInPanelTitle variant="embedded">Check your email</SignInPanelTitle>
        <p className="text-ui leading-snug text-muted-foreground">
          {entry.resent ? (
            "New code sent"
          ) : (
            <>
              We sent a 6-digit code to <span className="text-foreground">{email}</span>
            </>
          )}
        </p>
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void entry.submit(entry.code);
        }}
      >
        <CodeInput entry={entry} submitting={submitting} appearance="boxes" />
        <CodeEntryError entry={entry} className="text-center" />

        <Button type="submit" className="mt-1 w-full" disabled={!entry.complete || submitting}>
          {submitting ? <Spinner className="size-3.5" /> : null}
          Verify
        </Button>
      </form>

      <p className="text-center text-ui-sm text-muted-foreground">
        Didn't get it?{" "}
        <button
          type="button"
          className="underline underline-offset-2 enabled:hover:text-foreground disabled:no-underline disabled:opacity-64"
          disabled={entry.resendDisabled}
          onClick={() => void entry.handleResend()}
        >
          Resend code
          {entry.cooldownSecondsLeft > 0
            ? ` (${formatResendCountdown(entry.cooldownSecondsLeft)})`
            : ""}
        </button>
      </p>

      <button
        type="button"
        className="self-center text-ui-sm text-muted-foreground hover:text-foreground"
        onClick={onUseDifferentEmail}
      >
        Use a different email
      </button>
    </div>
  );
}
