import { useEffect, useRef, useState } from "react";
import type { BrowserVaultMethods } from "@synara/contracts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useTranslation } from "~/i18n";

type MasterAction = { kind: "setup" | "unlock" } | { kind: "reveal"; id: string };

/** Mounted only while the human is authenticating; secrets never enter the vault snapshot. */
export function BrowserVaultMaster({
  api,
  action,
  onDone,
}: {
  api: BrowserVaultMethods;
  action: MasterAction;
  onDone: () => void;
}) {
  const { t } = useTranslation();

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const hide = () => {
      generation.current++;
      setPassword("");
      setConfirmation("");
      setRevealed(null);
      done.current();
    };
    const visibility = () => {
      if (document.hidden) hide();
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      generation.current++;
      clearTimeout(timer.current);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const submit = async () => {
    if (busy) return;
    if (action.kind === "setup" && (password.length < 12 || password !== confirmation)) {
      setError(t("computer:useAtLeast12CharactersAndEnterTheSame"));
      return;
    }
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    const secret = password;
    setPassword("");
    setConfirmation("");
    try {
      if (action.kind === "reveal") {
        const result = await api.reveal({ id: action.id, password: secret });
        if (request !== generation.current) return;
        const remaining = Math.min(20_000, result.expiresAt - Date.now());
        if (remaining <= 0) {
          onDone();
          return;
        }
        setRevealed(result.password);
        timer.current = setTimeout(() => {
          setRevealed(null);
          onDone();
        }, remaining);
      } else {
        await (action.kind === "setup" ? api.setupMaster(secret) : api.unlock(secret));
        if (request === generation.current) onDone();
      }
    } catch {
      if (request === generation.current)
        setError(t("computer:couldNotVerifyTheMasterPasswordTryAgainShortly"));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  return (
    <div className="space-y-3 py-3">
      {revealed !== null ? (
        <>
          <label className="block space-y-1 text-ui leading-snug">
            <span>{t("computer:password")}</span>
            <Input
              aria-label={t("computer:revealedPassword")}
              value={revealed}
              readOnly
              autoComplete="off"
              className="font-mono"
            />
          </label>
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={onDone}>
              {t("computer:hidePassword")}
            </Button>
          </div>
        </>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="block space-y-1 text-ui leading-snug">
            <span>
              {action.kind === "setup"
                ? t("computer:newMasterPassword")
                : t("computer:masterPassword")}
            </span>
            <Input
              type="password"
              autoFocus
              value={password}
              maxLength={1024}
              autoComplete={action.kind === "setup" ? "new-password" : "current-password"}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </label>
          {action.kind === "setup" ? (
            <>
              <label className="block space-y-1 text-ui leading-snug">
                <span>{t("computer:confirmMasterPassword")}</span>
                <Input
                  type="password"
                  value={confirmation}
                  maxLength={1024}
                  autoComplete="new-password"
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={busy}
                />
              </label>
              <p className="text-ui leading-snug text-muted-foreground">
                {t("computer:keepThisPasswordSomewhereSafeAForgottenMasterPassword")}
              </p>
            </>
          ) : null}
          {error ? (
            <p role="alert" className="text-ui leading-snug text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onDone}>
              {t("common:form_cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !password}>
              {busy
                ? t("computer:verifying")
                : action.kind === "setup"
                  ? t("computer:setMasterPassword")
                  : action.kind === "unlock"
                    ? t("computer:unlock")
                    : t("computer:revealPassword")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
