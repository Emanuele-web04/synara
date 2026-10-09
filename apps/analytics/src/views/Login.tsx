// FILE: src/views/Login.tsx
// Purpose: Password gate for the diagnostics dashboard.

import { useState } from "react";

import { api, loginErrorMessage } from "../api";
import { Button } from "../components";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setMessage("Enter your password");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const res = await api.login(password);
      if (res.ok) onLogin();
      else setMessage(loginErrorMessage(res));
    } catch {
      setMessage(loginErrorMessage(null));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-form" onSubmit={submit}>
        <h1 className="heading-24">Synara Beta diagnostics</h1>
        <label className="label-13 secondary" htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          className="input"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="login-error" role={message ? "alert" : undefined}>
          {message}
        </p>
        <Button type="submit" variant="primary" disabled={busy}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
