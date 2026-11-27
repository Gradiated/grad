import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { errorMessage } from "../lib/api.js";
import { humanize } from "../lib/format.js";
import { IconAlert, IconCheck, IconCopy, IconInfo } from "./icons.js";

// ------------------------------------------------------------ status

const STATUS_TONE: Record<string, string> = {
  queued: "amber",
  running: "blue",
  awaiting_scores: "accent",
  completed: "green",
  failed: "red",
  cancelled: "",
  stopped_budget: "amber",
};

const STATUS_LABEL: Record<string, string> = { stopped_budget: "stopped at cap" };

export const StatusBadge = ({ status }: { status: string }) => {
  const tone = STATUS_TONE[status] ?? "";
  const live = tone === "blue";
  return (
    <span className={`badge ${tone}${live ? " live" : ""}`} data-status={status}>
      <span className="dot" />
      {STATUS_LABEL[status] ?? humanize(status)}
    </span>
  );
};

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

export const Empty = ({ title, children }: { title: ReactNode; children?: ReactNode }) => (
  <div className="empty">
    <div className="title">{title}</div>
    {children && <div>{children}</div>}
  </div>
);

export const Banner = ({ tone = "error", children }: { tone?: "error" | "warn" | "info"; children: ReactNode }) => (
  <div className={`banner ${tone}`} role={tone === "error" ? "alert" : "status"}>
    {tone === "info" ? <IconInfo /> : <IconAlert />}
    <div className="body">{children}</div>
  </div>
);

export const ErrorBanner = ({ error }: { error: unknown }) => (error ? <Banner>{errorMessage(error)}</Banner> : null);

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

export const Meter = ({ value, max, tone, label, right }: { value: number; max: number | null; tone?: string; label: ReactNode; right: ReactNode }) => {
  const frac = max && max > 0 ? Math.min(1, value / max) : 0;
  const auto = tone ?? (frac >= 1 ? "red" : frac >= 0.85 ? "amber" : "");
  return (
    <div className="meter">
      <div className="meter-head">
        <span className="muted">{label}</span>
        <span>{right}</span>
      </div>
      <div className={`progress ${auto}`} role="progressbar" aria-valuenow={Math.round(frac * 100)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${(frac * 100).toFixed(1)}%` }} />
      </div>
    </div>
  );
};

export const Segmented = <T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; count?: number }[]; onChange: (v: T) => void; label: string }) => (
  <div className="segmented" role="tablist" aria-label={label}>
    {options.map((o) => (
      <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
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
    <button type="button" className="btn ghost sm" onClick={() => void copy()} aria-label={label} title={label}>
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
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <div>{body}</div>
        <ErrorBanner error={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button ref={ref} type="button" className={`btn ${danger ? "danger" : "primary"}`} onClick={() => void go()} disabled={busy}>
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
