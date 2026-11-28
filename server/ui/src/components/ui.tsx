import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { errorMessage } from "../lib/api.js";
import { humanize } from "../lib/format.js";
import { IconAlert, IconCheck, IconCopy, IconInbox, IconInfo, IconRefresh } from "./icons.js";

// ------------------------------------------------------------ status

export type Tone = "green" | "red" | "amber" | "blue" | "accent" | "";

const STATUS_TONE: Record<string, Tone> = {
  queued: "amber",
  running: "blue",
  awaiting_scores: "accent",
  completed: "green",
  failed: "red",
  cancelled: "",
  stopped_budget: "amber",
};

const STATUS_LABEL: Record<string, string> = { stopped_budget: "stopped at cap", awaiting_scores: "awaiting scores" };

export const Badge = ({ tone = "", live, status, children }: { tone?: Tone; live?: boolean; status?: string; children: ReactNode }) => (
  <span className={`badge${tone ? ` ${tone}` : ""}${live ? " live" : ""}`} data-status={status}>
    <span className="dot" aria-hidden="true" />
    {children}
  </span>
);

export const StatusBadge = ({ status }: { status: string }) => (
  <Badge tone={STATUS_TONE[status] ?? ""} live={status === "running"} status={status}>
    {STATUS_LABEL[status] ?? humanize(status)}
  </Badge>
);

// ------------------------------------------------------------ surfaces

export const Card = ({ title, count, actions, children, tight, className }: { title?: ReactNode; count?: ReactNode; actions?: ReactNode; children: ReactNode; tight?: boolean; className?: string }) => (
  <section className={`card${className ? ` ${className}` : ""}`}>
    {title !== undefined && (
      <header className="card-header">
        <h2 className="card-title">
          {title}
          {count !== undefined && <span className="count">{count}</span>}
        </h2>
        {actions && <div className="actions">{actions}</div>}
      </header>
    )}
    <div className={`card-body${tight ? " tight" : ""}`}>{children}</div>
  </section>
);

export const Stat = ({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) => (
  <div className="stat">
    <div className="stat-label">{label}</div>
    <div className="stat-value">{value}</div>
    {hint !== undefined && <div className="stat-hint">{hint}</div>}
  </div>
);

export const Kv = ({ label, value }: { label: string; value: ReactNode }) => (
  <>
    <dt>{label}</dt>
    <dd>{value}</dd>
  </>
);

export const Empty = ({ title, icon, children }: { title: ReactNode; icon?: ReactNode; children?: ReactNode }) => (
  <div className="empty">
    <span className="empty-icon" aria-hidden="true">
      {icon ?? <IconInbox />}
    </span>
    <div className="title">{title}</div>
    {children && <div className="hint">{children}</div>}
  </div>
);

export const Banner = ({ tone = "error", action, children }: { tone?: "error" | "warn" | "info"; action?: ReactNode; children: ReactNode }) => (
  <div className={`banner ${tone}`} role={tone === "error" ? "alert" : "status"}>
    {tone === "info" ? <IconInfo /> : <IconAlert />}
    <div className="body">{children}</div>
    {action}
  </div>
);

export const ErrorBanner = ({ error, onRetry }: { error: unknown; onRetry?: () => void }) =>
  error ? (
    <Banner
      action={
        onRetry && (
          <button type="button" className="btn sm" onClick={onRetry}>
            <IconRefresh /> Retry
          </button>
        )
      }
    >
      {errorMessage(error)}
    </Banner>
  ) : null;

export const SkeletonRows = ({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) => (
  <>
    {Array.from({ length: rows }, (_, r) => (
      <tr key={r} aria-hidden="true">
        {Array.from({ length: cols }, (_, c) => (
          <td key={c}>
            <div className="skeleton" style={{ width: `${40 + ((r * 7 + c * 13) % 45)}%` }} />
          </td>
        ))}
      </tr>
    ))}
  </>
);

/** A bar of `value` against `max`, amber from 85% and red when full. */
export const Meter = ({ value, max, label }: { value: number; max: number | null; label: string }) => {
  const frac = max && max > 0 ? Math.min(1, value / max) : 0;
  const tone = frac >= 1 ? " red" : frac >= 0.85 ? " amber" : "";
  return (
    <div className={`progress slim meter${tone}`} role="progressbar" aria-label={label} aria-valuenow={Math.round(frac * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${(frac * 100).toFixed(1)}%` }} />
    </div>
  );
};

export const Segmented = <T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; count?: number }[]; onChange: (v: T) => void; label: string }) => (
  <div className="segmented" role="group" aria-label={label}>
    {options.map((o) => (
      <button key={o.value} type="button" aria-pressed={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
        {o.label}
        {o.count !== undefined && <span className="n">{o.count}</span>}
      </button>
    ))}
  </div>
);

// ------------------------------------------------------------ copy

export const CopyButton = ({ text, label = "Copy" }: { text: string; label?: string }) => {
  const [done, setDone] = useState(false);
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {
      toast("Copy failed: select the text and copy it manually");
    }
  };
  return (
    <button type="button" className="btn ghost sm icon" onClick={() => void copy()} aria-label={label} title={label}>
      {done ? <IconCheck /> : <IconCopy />}
    </button>
  );
};

export const Command = ({ cmd }: { cmd: string }) => (
  <div className="cmd">
    <code>{cmd}</code>
    <CopyButton text={cmd} label="Copy command" />
  </div>
);

// ------------------------------------------------------------ confirm + toast

export const Confirm = ({ title, body, confirm, danger, onConfirm, onClose }: { title: string; body: ReactNode; confirm: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{title}</h2>
        <div>{body}</div>
        <ErrorBanner error={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button ref={ref} type="button" className={`btn ${danger ? "danger solid" : "primary"}`} onClick={() => void go()} disabled={busy}>
            {busy && <span className="spinner" />}
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
};

const ToastContext = createContext<(msg: string) => void>(() => undefined);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 2600);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);
