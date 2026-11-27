import { useState, type FormEvent } from "react";

import { Wordmark } from "../components/icons.js";
import { Banner } from "../components/ui.js";

export const LoginPage = ({ reason, onSubmit }: { reason?: string | undefined; onSubmit: (key: string) => Promise<string | null> }) => {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(reason);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy(true);
    const result = await onSubmit(trimmed);
    if (result !== null) {
      setProblem(result || "The server rejected that key.");
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="card login-card">
        <div>
          <Wordmark />
          <h1>Sign in to grad</h1>
          <p>Paste an API key for {location.host}. It stays in this tab only and is cleared when you close it.</p>
        </div>
        {problem && <Banner>{problem}</Banner>}
        <form onSubmit={(e) => void submit(e)}>
          <label className="field">
            API key
            <input id="api-key" className="input" type="password" autoComplete="off" spellCheck={false} placeholder="grad_…" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
          </label>
          <button className="btn primary" type="submit" disabled={busy || !key.trim()}>
            {busy && <span className="spinner" />}
            Sign in
          </button>
        </form>
        <div className="login-foot">
          From a terminal, <code>grad ui</code> opens this page already signed in with your CLI profile.
        </div>
      </div>
    </div>
  );
};
