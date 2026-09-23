// FILE: src/views/Login.tsx
// Purpose: Password gate for the diagnostics dashboard.

import { Button, SensitiveInput, Surface, Text } from "@cloudflare/kumo";
import { useState } from "react";

import { api } from "../api";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailed(false);
    try {
      const res = await api.login(password);
      if (res.ok) onLogin();
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Surface style={{ padding: 24, width: 320 }}>
        <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
          <Text variant="heading" as="h1">
            Synara Beta Diagnostics
          </Text>
          <SensitiveInput
            aria-label="Password"
            placeholder="Password"
            value={password}
            onValueChange={setPassword}
          />
          {failed && <Text variant="error">Wrong password.</Text>}
          <Button type="submit" variant="primary" disabled={busy || !password}>
            Sign in
          </Button>
        </form>
      </Surface>
    </div>
  );
}
