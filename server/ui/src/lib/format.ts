const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const int = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : nf0.format(n));

/** 1234 -> 1.2K, 3.4M, 5.6B. */
export const compact = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  for (const [v, s] of [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const) {
    if (abs >= v) return `${(n / v).toFixed(abs / v >= 100 ? 0 : 1).replace(/\.0$/, "")}${s}`;
  }
  return nf0.format(n);
};

export const usd = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  // Cents hide small training costs: $0.0114, $0.123, $0.50.
  if (Math.abs(n) < 1) return `$${n.toFixed(4).replace(/0{1,2}$/, "")}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Significant-digit number for losses, lrs, scores. */
export const num = (n: number | null | undefined, digits = 4): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs < 1e-3 || abs >= 1e6) return n.toExponential(Math.max(0, digits - 2));
  return Number(n.toPrecision(digits)).toString();
};

export const pct = (n: number | null | undefined, digits = 1): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(digits)}%`);

export const bytes = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
};

/** "4s", "3m 20s", "2h 5m", "3d 4h". */
export const duration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};

/** "just now", "5m ago", "3h ago", "Nov 3". */
export const ago = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = now - t;
  if (d < 0) return `in ${duration(-d).split(" ")[0]}`;
  if (d < 45_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.round(d / 86_400_000)}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
};

export const dateTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};

export const time = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};

/** "1 step", "1,000 steps". */
export const plural = (n: number, noun: string): string => `${int(n)} ${noun}${n === 1 ? "" : "s"}`;

export const humanize = (s: string): string => s.replace(/_/g, " ");

// ------------------------------------------------------------ YAML

const PLAIN = /^[A-Za-z_./@-][\w ./@:+-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~|-?\d[\d._eE+-]*)$/i;

const scalar = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  return PLAIN.test(s) && !RESERVED.test(s) && !s.endsWith(" ") && !s.includes(": ") ? s : JSON.stringify(s);
};

const keyOf = (k: string): string => (PLAIN.test(k) && !RESERVED.test(k) && !k.includes(" ") ? k : JSON.stringify(k));

/** A small, deterministic YAML emitter for read-only display of JSON values. */
export const toYaml = (value: unknown, indent = 0): string => {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (item !== null && typeof item === "object" && Object.keys(item).length > 0) {
          const body = toYaml(item, indent + 1);
          return `${pad}- ${body.trimStart()}`;
        }
        return `${pad}- ${item !== null && typeof item === "object" ? toYaml(item) : scalar(item)}`;
      })
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        if (v !== null && typeof v === "object" && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
          return `${pad}${keyOf(k)}:\n${toYaml(v, Array.isArray(v) ? indent : indent + 1)}`;
        }
        return `${pad}${keyOf(k)}: ${v !== null && typeof v === "object" ? toYaml(v) : scalar(v)}`;
      })
      .join("\n");
  }
  return scalar(value);
};
